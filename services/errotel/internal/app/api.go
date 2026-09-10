package app

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gopherex/errotel/services/errotel/internal/oas"
)

type (
	cachedResponse struct {
		body    []byte
		fetched time.Time
		hit     bool
	}
	responseLoader func(context.Context) (any, bool, error)
)

func (a *App) cached(ctx context.Context, key string, ttl time.Duration, load responseLoader) (cachedResponse, error) {
	key = a.revision + ":" + key
	if body, fetched, exists := a.cache.get(key); exists {
		return cachedResponse{body, fetched, true}, nil
	}
	select {
	case a.slots <- struct{}{}:
		defer func() { <-a.slots }()
	default:
		return cachedResponse{}, &upstreamError{"query_budget_exceeded", http.StatusTooManyRequests}
	}

	ctx, cancel := context.WithTimeout(ctx, a.cfg.Queries.Timeout)
	defer cancel()

	value, cacheable, err := load(ctx)
	if err != nil {
		return cachedResponse{}, err
	}

	body, err := json.Marshal(value)
	if err != nil {
		return cachedResponse{}, &upstreamError{"invalid_upstream_response", http.StatusBadGateway}
	}

	fetched := time.Now()

	if cacheable {
		if related, ok := value.(RelatedResult); ok && related.Status == statusNotFound {
			ttl = a.cfg.Cache.NegativeTTL
		}

		a.cache.put(key, body, ttl, fetched)
	}

	return cachedResponse{body, fetched, false}, nil
}

type responseHeaders interface {
	SetXErrotelCache(value oas.OptString)
	SetXErrotelCacheAgeMs(value oas.OptString)
	SetXErrotelFetchedAt(value oas.OptString)
}

func (result *cachedResponse) headers(target responseHeaders) {
	cache := "miss"
	if result.hit {
		cache = "hit"
		age := strconv.FormatInt(time.Since(result.fetched).Milliseconds(), decimalBase)
		target.SetXErrotelCacheAgeMs(oas.NewOptString(age))
	}

	target.SetXErrotelCache(oas.NewOptString(cache))
	target.SetXErrotelFetchedAt(oas.NewOptString(result.fetched.UTC().Format(time.RFC3339Nano)))
}

func decodeAPI(data []byte, target any) error {
	if err := json.Unmarshal(data, target); err != nil {
		return &upstreamError{"invalid_api_response", http.StatusBadGateway}
	}

	return nil
}

func (a *App) GetCapabilities(_ context.Context) (*oas.CapabilitiesHeaders, error) {
	return &oas.CapabilitiesHeaders{Response: oas.Capabilities{
		ApiVersion: "1", Source: a.cfg.Source,
		ServerTimeUnixNano: oas.WireUnixNano(strconv.FormatInt(time.Now().UnixNano(), decimalBase)),
		MaxOffset:          a.cfg.Queries.MaxOffset,
		FilterFields: []oas.CapabilitiesFilterFieldsItem{
			"service", "environment", "exceptionType", "message", "release",
			"traceId", "runtimeId", "groupKey", "origin",
		},
		FilterOperators: []oas.CapabilitiesFilterOperatorsItem{
			"and", "or", "not", "eq", "contains", "icontains", "prefix", "exists",
		},
		FacetFields: []oas.CapabilitiesFacetFieldsItem{"service", "environment", "release"},
		Features: oas.CapabilitiesFeatures{
			Traces: a.cfg.Traces.BaseURL != "", QueryFilters: true, Histogram: true, AlertExport: true,
			Investigation: true, Facets: true,
		},
		MaxPageSize: a.cfg.Queries.MaxPageSize, MaxRangeMs: int(a.cfg.Queries.MaxRange.Milliseconds()),
	}}, nil
}

func (a *App) SearchOccurrences(ctx context.Context, req *oas.OccurrenceSearch) (*oas.SearchResponseHeaders, error) {
	var search Search
	if err := decodeAPI(canonical(req), &search); err != nil {
		return nil, err
	}

	offset, err := a.normalize(&search)
	if err != nil {
		return nil, err
	}

	key := "search:" + string(canonical(search)) + ":" + strconv.Itoa(offset)

	result, err := a.cached(ctx, key, a.cfg.Cache.SearchTTL, func(ctx context.Context) (any, bool, error) {
		value, err := a.loadSearch(ctx, &search, offset)

		return value, err == nil && value.Meta.QueryStatus == statusComplete, err
	})
	if err != nil {
		return nil, err
	}

	response := new(oas.SearchResponseHeaders)
	if err := decodeAPI(result.body, &response.Response); err != nil {
		return nil, err
	}

	if result.hit {
		response.Response.Meta.ServedFrom = oas.MetaServedFromCache
		response.Response.Meta.CacheAgeMs = oas.NewOptInt(int(time.Since(result.fetched).Milliseconds()))
	}

	result.headers(response)

	return response, nil
}

func (a *App) GetHistogram(ctx context.Context, req *oas.OccurrenceSearch) (*oas.HistogramResponseHeaders, error) {
	var search Search
	if err := decodeAPI(canonical(req), &search); err != nil {
		return nil, err
	}

	if search.Cursor != "" {
		return nil, requestError("histogram_has_no_cursor")
	}

	if _, err := a.normalize(&search); err != nil {
		return nil, err
	}

	search.PageSize = 0

	result, err := a.cached(ctx, "histogram:"+string(canonical(search)), a.cfg.Cache.SearchTTL,
		func(ctx context.Context) (any, bool, error) {
			value, err := a.loadHistogram(ctx, &search)

			return value, err == nil && value.Meta.QueryStatus == statusComplete, err
		})
	if err != nil {
		return nil, err
	}

	response := new(oas.HistogramResponseHeaders)
	if err := decodeAPI(result.body, &response.Response); err != nil {
		return nil, err
	}

	if result.hit {
		response.Response.Meta.ServedFrom = oas.MetaServedFromCache
		response.Response.Meta.CacheAgeMs = oas.NewOptInt(int(time.Since(result.fetched).Milliseconds()))
	}

	result.headers(response)

	return response, nil
}

func (a *App) GetOccurrence(ctx context.Context, params oas.GetOccurrenceParams) (*oas.OccurrenceDetailHeaders, error) {
	loc, err := a.parseLocator(params.Ref)
	if err != nil {
		return nil, err
	}

	key := "detail:" + encode(loc)

	result, err := a.cached(ctx, key, a.cfg.Cache.DetailTTL, func(ctx context.Context) (any, bool, error) {
		value, err := a.loadDetail(ctx, &loc)
		cacheable := err == nil && !hasWarning(&value, "upstream_partial") &&
			!hasWarning(&value, "detail_row_budget_exceeded")

		return value, cacheable, err
	})
	if err != nil {
		return nil, err
	}

	response := new(oas.OccurrenceDetailHeaders)
	if err := decodeAPI(result.body, &response.Response); err != nil {
		return nil, err
	}

	result.headers(response)

	return response, nil
}

func (a *App) GetRelatedLogs(
	ctx context.Context, req *oas.RelatedRequest, params oas.GetRelatedLogsParams,
) (*oas.RelatedResponseHeaders, error) {
	loc, err := a.parseLocator(params.Ref)
	if err != nil {
		return nil, err
	}

	var request RelatedRequest
	if err := decodeAPI(canonical(req), &request); err != nil {
		return nil, err
	}

	key := "related:" + encode(loc) + ":" + string(canonical(request))

	result, err := a.cached(ctx, key, a.cfg.Cache.SearchTTL, func(ctx context.Context) (any, bool, error) {
		value, err := a.related(ctx, &loc, request)

		return value, err == nil && (value.Status == statusAvailable || value.Status == statusNotFound), err
	})
	if err != nil {
		return nil, err
	}

	response := new(oas.RelatedResponseHeaders)
	if err := decodeAPI(result.body, &response.Response); err != nil {
		return nil, err
	}

	result.headers(response)

	return response, nil
}

func (a *App) GetTrace(ctx context.Context, params oas.GetTraceParams) (*oas.TraceResponseHeaders, error) {
	if !validTrace(params.TraceId) {
		return nil, requestError("invalid_trace_id")
	}

	key := "trace:" + params.TraceId

	result, err := a.cached(ctx, key, a.cfg.Cache.TraceTTL, func(ctx context.Context) (any, bool, error) {
		value, err := a.loadTrace(ctx, params.TraceId)

		return value, err == nil && (value.Status == statusAvailable || value.Status == statusNotFound), err
	})
	if err != nil {
		return nil, err
	}

	response := new(oas.TraceResponseHeaders)
	if err := decodeAPI(result.body, &response.Response); err != nil {
		return nil, err
	}

	result.headers(response)

	return response, nil
}

func (a *App) HandleBearerAuth(
	ctx context.Context, _ oas.OperationName, token oas.BearerAuth,
) (context.Context, error) {
	candidate := sha256.Sum256([]byte(token.Token))
	if subtle.ConstantTimeCompare(candidate[:], a.auth.secret[:]) != 1 {
		return ctx, requestError("unauthorized")
	}

	return ctx, nil
}

func (a *App) NewError(_ context.Context, err error) *oas.ApiErrorStatusCode {
	status, code := http.StatusBadRequest, "invalid_request"

	var upstream *upstreamError

	if errors.As(err, &upstream) {
		status, code = upstream.status, upstream.code
	}

	return &oas.ApiErrorStatusCode{
		StatusCode: status, Response: oas.ApiError{Code: code, Message: strings.ReplaceAll(code, "_", " ")},
	}
}

func (a *App) initAPI() error {
	server, err := oas.NewServer(a, a, oas.WithErrorHandler(func(
		_ context.Context, writer http.ResponseWriter, _ *http.Request, _ error,
	) {
		apiError(writer, http.StatusBadRequest, "invalid_request")
	}))
	if err != nil {
		return fmt.Errorf("initialize generated API: %w", err)
	}

	a.api = server

	return nil
}
