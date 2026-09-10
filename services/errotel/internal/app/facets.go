package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strconv"
	"time"

	"github.com/gopherex/errotel/services/errotel/internal/oas"
)

type facetRequest struct {
	Field    string        `json:"field"`
	Range    Range         `json:"range"`
	Filter   *SearchFilter `json:"filter,omitempty"`
	Prefix   string        `json:"prefix,omitempty"`
	PageSize int           `json:"pageSize,omitempty"`
	Cursor   string        `json:"cursor,omitempty"`
}
type facetCursor struct {
	Version  int    `json:"v"`
	Revision string `json:"revision"`
	Query    string `json:"query"`
	Offset   int    `json:"offset"`
}
type facetValue struct {
	Value      string `json:"value"`
	ErrorCount int64  `json:"errorCount"`
	LastSeen   string `json:"lastSeenUnixNano"`
}
type facetResponse struct {
	Field      string       `json:"field"`
	Range      Range        `json:"range"`
	Items      []facetValue `json:"items"`
	NextCursor string       `json:"nextCursor,omitempty"`
	Meta       Meta         `json:"meta"`
}

const (
	statusComplete       = "complete"
	defaultFacetPageSize = 50
)

func (a *App) normalizeFacet(req *facetRequest) (int, error) {
	if req.Field != string(oas.FacetRequestFieldService) && req.Field != string(oas.FacetRequestFieldEnvironment) &&
		req.Field != string(oas.FacetRequestFieldRelease) {
		return 0, requestError("invalid_facet_field")
	}

	if a.validateRange(req.Range) != nil {
		return 0, requestError("invalid_range")
	}

	if err := validateSearchFilter(req.Filter); err != nil {
		return 0, err
	}

	if len(req.Prefix) > maxFilterLength {
		return 0, requestError("filter_too_long")
	}

	if req.PageSize == 0 {
		req.PageSize = min(defaultFacetPageSize, a.cfg.Queries.MaxPageSize)
	}

	if req.PageSize < 1 || req.PageSize > a.cfg.Queries.MaxPageSize {
		return 0, requestError("invalid_page_size")
	}

	return a.facetOffset(req)
}

func (a *App) facetOffset(req *facetRequest) (int, error) {
	encoded := req.Cursor
	req.Cursor = ""

	if encoded == "" {
		return 0, nil
	}

	var cursor facetCursor
	if decode(encoded, &cursor) != nil || cursor.Version != 1 || cursor.Revision != a.revision ||
		cursor.Query != facetHash(req) || cursor.Offset < 0 || cursor.Offset > a.cfg.Queries.MaxOffset {
		return 0, requestError("invalid_cursor")
	}

	return cursor.Offset, nil
}

func facetHash(req *facetRequest) string {
	digest := sha256.Sum256(canonical(req))

	return hex.EncodeToString(digest[:])
}

// Aggregate output aliases must not overwrite a configured facet field.
func (a *App) facetAlias(req *facetRequest, name string) string {
	for name == a.cfg.Fields[req.Field] {
		name = "_" + name
	}

	return name
}

func (a *App) facetQuery(req *facetRequest, limit int) string {
	search := Search{Range: req.Range, Filter: req.Filter}
	sdk, vanilla := a.matchingQuery(&search, originSDK), a.matchingQuery(&search, originOTel)
	field := a.field(req.Field)
	sdkCount, otelCount := a.facetAlias(req, "sdk_count"), a.facetAlias(req, "otel_count")
	errors, lastSeen := a.facetAlias(req, "errors"), a.facetAlias(req, "last_seen")
	query := "((" + sdk + ") OR (" + vanilla + "))"

	if req.Prefix != "" {
		prefix := SearchFilter{Op: "prefix", Field: req.Field, Value: &req.Prefix}
		query += " AND (" + a.filterQuery(&prefix) + ")"
	}
	// All grouping and counting happen upstream. Neither Body nor exception stack is returned.
	query += " | stats by (" + field + ") count_uniq(" + a.field("eventId") + ") if (" + sdk + ") as " + sdkCount + "," +
		" count() if (" + vanilla + ") as " + otelCount + ", max(" + a.field("time") + ") as " + lastSeen +
		" | math " + sdkCount + "+" + otelCount + " as " + errors +
		" | sort by (" + errors + " desc, " + field + ") limit " + strconv.Itoa(limit) +
		" | fields " + field + ", " + errors + ", " + lastSeen

	return query
}

func (a *App) loadFacets(ctx context.Context, req *facetRequest, offset int) (facetResponse, error) {
	result := facetResponse{Field: req.Field, Range: req.Range, Items: []facetValue{}, Meta: Meta{
		QueryStatus: statusComplete, ServedFrom: "upstream",
		FetchedAt: time.Now().UTC().Format(time.RFC3339Nano), Warnings: []string{},
	}}
	limit := offset + req.PageSize + 1

	rows, partial, err := a.logs(ctx, a.facetQuery(req, limit), req.Range, limit)
	if err != nil {
		return result, err
	}

	if partial {
		result.Meta.QueryStatus = statusPartial
		result.Meta.Warnings = append(result.Meta.Warnings, "upstream_partial")
	}

	if offset >= len(rows) {
		return result, nil
	}

	rows = rows[offset:]
	if len(rows) > req.PageSize {
		rows = rows[:req.PageSize]

		if offset+req.PageSize <= a.cfg.Queries.MaxOffset {
			result.NextCursor = encode(facetCursor{1, a.revision, facetHash(req), offset + req.PageSize})
		} else {
			result.Meta.QueryStatus = statusPartial
			result.Meta.Warnings = append(result.Meta.Warnings, "offset_budget_exceeded")
		}
	}

	for _, row := range rows {
		count, err := strconv.ParseInt(row[a.facetAlias(req, "errors")], decimalBase, 64)
		if err != nil || count < 1 {
			return result, &upstreamError{"invalid_facet_count", http.StatusBadGateway}
		}

		stamp, err := rowTime(row, a.facetAlias(req, "last_seen"))
		if err != nil {
			return result, &upstreamError{"invalid_facet_time", http.StatusBadGateway}
		}

		result.Items = append(result.Items, facetValue{row[a.cfg.Fields[req.Field]], count, stamp})
	}

	return result, nil
}

func (a *App) GetFacets(ctx context.Context, req *oas.FacetRequest) (*oas.FacetResponseHeaders, error) {
	var request facetRequest
	if err := decodeAPI(canonical(req), &request); err != nil {
		return nil, err
	}

	offset, err := a.normalizeFacet(&request)
	if err != nil {
		return nil, err
	}

	key := "facets:" + facetHash(&request) + ":" + strconv.Itoa(offset)

	result, err := a.cached(ctx, key, a.cfg.Cache.SearchTTL, func(ctx context.Context) (any, bool, error) {
		value, err := a.loadFacets(ctx, &request, offset)

		return value, err == nil && value.Meta.QueryStatus == statusComplete, err
	})
	if err != nil {
		return nil, err
	}

	response := new(oas.FacetResponseHeaders)
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
