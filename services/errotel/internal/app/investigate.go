package app

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gopherex/errotel/services/errotel/internal/oas"
)

const defaultInvestigationLogLimit = 20

type investigationRequest struct {
	Ref             string  `json:"ref"`
	EventID         string  `json:"eventId"`
	Range           *Range  `json:"range"`
	Search          *Search `json:"search"`
	RelatedPageSize int     `json:"relatedPageSize"`
}

type investigationSelection struct {
	Method         string `json:"method"`
	HasMoreMatches *bool  `json:"hasMoreMatches,omitempty"`
	Range          *Range `json:"range,omitempty"`
	Meta           *Meta  `json:"meta,omitempty"`
	Ref            string `json:"-"`
}

type investigationPart struct {
	Result RelatedResult `json:"result"`
	Meta   *Meta         `json:"meta,omitempty"`
}

type investigationResponse struct {
	Status         string                 `json:"status"`
	Selection      investigationSelection `json:"selection"`
	Occurrence     Detail                 `json:"occurrence"`
	OccurrenceMeta Meta                   `json:"occurrenceMeta"`
	Trace          investigationPart      `json:"trace"`
	RelatedLogs    investigationPart      `json:"relatedLogs"`
	Warnings       []string               `json:"warnings"`
}

func (a *App) validateInvestigation(req *investigationRequest) error {
	selectors := 0

	for _, present := range []bool{req.Ref != "", req.EventID != "", req.Search != nil} {
		if present {
			selectors++
		}
	}

	if selectors != 1 || (req.EventID != "") != (req.Range != nil) {
		return requestError("choose_ref_event_id_with_range_or_search")
	}

	if req.EventID != "" && (!validID(req.EventID) || a.validateRange(*req.Range) != nil) {
		return requestError("invalid_event_id_or_range")
	}

	if req.Search != nil && (req.Search.Cursor != "" || req.Search.PageSize != 0) {
		return requestError("latest_search_has_no_cursor_or_page_size")
	}

	if req.RelatedPageSize == 0 {
		req.RelatedPageSize = min(defaultInvestigationLogLimit, a.cfg.Queries.MaxPageSize)
	}

	if req.RelatedPageSize < 1 || req.RelatedPageSize > a.cfg.Queries.MaxPageSize {
		return requestError("invalid_page_size")
	}

	return nil
}

// Investigate reads one occurrence and independent, bounded evidence. It does not infer causality.
func (a *App) Investigate(
	ctx context.Context, req *oas.InvestigationRequest,
) (*oas.InvestigationResponseHeaders, error) {
	var request investigationRequest
	if err := decodeAPI(canonical(req), &request); err != nil {
		return nil, err
	}

	if err := a.validateInvestigation(&request); err != nil {
		return nil, err
	}

	selection, err := a.selectInvestigation(ctx, &request)
	if err != nil {
		return nil, err
	}

	primary, err := a.GetOccurrence(ctx, oas.GetOccurrenceParams{Ref: selection.Ref})
	if err != nil {
		return nil, err
	}

	result := investigationResponse{Status: "complete", Selection: selection, Warnings: []string{}}
	if err := decodeAPI(canonical(&primary.Response), &result.Occurrence); err != nil {
		return nil, err
	}

	result.OccurrenceMeta = headerMeta(primary.XErrotelCache, primary.XErrotelFetchedAt, primary.XErrotelCacheAgeMs)
	result.OccurrenceMeta.Warnings = append(result.OccurrenceMeta.Warnings, result.Occurrence.Warnings...)

	if hasWarning(&result.Occurrence, "upstream_partial") || hasWarning(&result.Occurrence, "detail_row_budget_exceeded") {
		result.OccurrenceMeta.QueryStatus = statusPartial
	}

	var workers sync.WaitGroup

	workers.Go(func() { result.Trace = a.investigationTrace(ctx, &result.Occurrence) })
	workers.Go(func() { result.RelatedLogs = a.investigationLogs(ctx, &result.Occurrence, request.RelatedPageSize) })
	workers.Wait()
	result.finish()

	response := new(oas.InvestigationResponseHeaders)
	if err := decodeAPI(canonical(result), &response.Response); err != nil {
		return nil, err
	}
	// No aggregate cache: freshness is reported for each independently read component.
	response.XErrotelCache = oas.NewOptString("mixed")

	return response, nil
}

func (a *App) selectInvestigation(ctx context.Context, req *investigationRequest) (investigationSelection, error) {
	if req.Ref != "" {
		return investigationSelection{Method: "ref", Ref: req.Ref}, nil
	}

	if req.EventID != "" {
		return a.selectEventID(ctx, req)
	}

	req.Search.PageSize = 1

	var search oas.OccurrenceSearch

	if err := decodeAPI(canonical(req.Search), &search); err != nil {
		return investigationSelection{}, err
	}

	response, err := a.SearchOccurrences(ctx, &search)
	if err != nil {
		return investigationSelection{}, err
	}

	var found SearchResponse
	if err := decodeAPI(canonical(&response.Response), &found); err != nil {
		return investigationSelection{}, err
	}

	if len(found.Items) == 0 {
		if found.Meta.QueryStatus == statusPartial {
			return investigationSelection{}, &upstreamError{"selection_upstream_partial", http.StatusBadGateway}
		}

		return investigationSelection{}, &upstreamError{statusNotFound, http.StatusNotFound}
	}

	more := found.NextCursor != ""

	selection := investigationSelection{
		Method: "latest", Ref: found.Items[0].Ref, Range: &found.Range, Meta: &found.Meta, HasMoreMatches: &more,
	}
	if found.Meta.QueryStatus == statusPartial {
		selection.HasMoreMatches = nil
	}

	return selection, nil
}

func (a *App) selectEventID(ctx context.Context, req *investigationRequest) (investigationSelection, error) {
	key := "event-id:" + req.EventID + ":" + string(canonical(req.Range))

	response, err := a.cached(ctx, key, a.cfg.Cache.SearchTTL, func(ctx context.Context) (any, bool, error) {
		query := a.exact("eventId", req.EventID) + " AND " + a.exact("kind", "exception") +
			" | fields " + strings.Join(a.indexNames(), ", ") + " | sort by (" + a.field("time") + " desc) limit 1"

		rows, partial, err := a.logs(ctx, query, *req.Range, 1)
		if err != nil {
			return nil, false, err
		}

		if partial {
			return nil, false, &upstreamError{"selection_upstream_partial", http.StatusBadGateway}
		}

		if len(rows) == 0 {
			return nil, false, &upstreamError{statusNotFound, http.StatusNotFound}
		}

		summary, err := a.summary(rows[0])

		return summary, err == nil, err
	})
	if err != nil {
		return investigationSelection{}, err
	}

	var summary Summary
	if err := decodeAPI(response.body, &summary); err != nil {
		return investigationSelection{}, err
	}

	meta := response.meta()

	return investigationSelection{Method: "eventId", Ref: summary.Ref, Range: req.Range, Meta: &meta}, nil
}

func headerMeta(cache, fetched, age oas.OptString) Meta {
	result := Meta{QueryStatus: "complete", ServedFrom: "upstream", FetchedAt: fetched.Value, Warnings: []string{}}
	if cache.Value == "hit" {
		result.ServedFrom = "cache"
		result.CacheAgeMS, _ = strconv.ParseInt(age.Value, 10, 64)
	}

	return result
}

func (response *cachedResponse) meta() Meta {
	result := Meta{
		QueryStatus: "complete", ServedFrom: "upstream",
		FetchedAt: response.fetched.UTC().Format(time.RFC3339Nano), Warnings: []string{},
	}
	if response.hit {
		result.ServedFrom = "cache"
		result.CacheAgeMS = time.Since(response.fetched).Milliseconds()
	}

	return result
}

func unsafeCorrelation(detail *Detail) bool {
	return hasWarning(detail, "index_payload_mismatch") || hasWarning(detail, "event_id_body_conflict")
}

func (a *App) investigationTrace(ctx context.Context, detail *Detail) investigationPart {
	if unsafeCorrelation(detail) {
		return missingPart("unavailable", "conflicting_identifiers")
	}

	if detail.Summary.TraceID == "" {
		return missingPart(statusNotFound, "trace_context_absent")
	}

	response, err := a.GetTrace(ctx, oas.GetTraceParams{TraceId: detail.Summary.TraceID})
	if err != nil {
		return missingPart("unavailable", a.NewError(ctx, err).Response.Code)
	}

	result := investigationPart{}
	if err := decodeAPI(canonical(&response.Response), &result.Result); err != nil {
		return missingPart("unavailable", "invalid_trace_response")
	}

	meta := headerMeta(response.XErrotelCache, response.XErrotelFetchedAt, response.XErrotelCacheAgeMs)
	result.Meta = &meta

	return result
}

func (a *App) investigationLogs(ctx context.Context, detail *Detail, pageSize int) investigationPart {
	if unsafeCorrelation(detail) {
		return missingPart("unavailable", "conflicting_identifiers")
	}

	kind := relationTimeWindow

	switch {
	case detail.Summary.TraceID != "":
		kind = relationSameTrace
	case detail.Summary.RuntimeID != "":
		kind = relationSameRuntime
	case detail.Summary.Service == "":
		return missingPart(statusNotFound, "correlation_key_absent")
	}

	loc, err := a.parseLocator(detail.Summary.Ref)
	if err != nil {
		return missingPart("unavailable", "invalid_locator")
	}

	request := RelatedRequest{Kind: kind, PageSize: pageSize}
	// Conflicting identifiers are rejected before consulting the related-data cache.
	key := "investigation-related:" + encode(loc) + ":" + string(canonical(request))

	response, err := a.cached(ctx, key, a.cfg.Cache.SearchTTL, func(ctx context.Context) (any, bool, error) {
		value := a.relatedWithDetail(ctx, &loc, request, detail)

		return value, value.Status == statusAvailable || value.Status == statusNotFound, nil
	})
	if err != nil {
		return missingPart("unavailable", a.NewError(ctx, err).Response.Code)
	}

	result := investigationPart{}
	if err := decodeAPI(response.body, &result.Result); err != nil {
		return missingPart("unavailable", "invalid_related_response")
	}

	meta := response.meta()
	result.Meta = &meta

	return result
}

func missingPart(status, reason string) investigationPart {
	return investigationPart{Result: RelatedResult{Status: status, Reason: reason}}
}

func (result *investigationResponse) finish() {
	result.Warnings = append(result.Warnings, result.Occurrence.Warnings...)
	if result.Selection.Meta != nil && result.Selection.Meta.QueryStatus == statusPartial {
		result.Warnings = append(result.Warnings, "selection_partial_latest_not_guaranteed")
	}

	for _, component := range []struct {
		name string
		part *investigationPart
	}{
		{"trace", &result.Trace}, {"related_logs", &result.RelatedLogs},
	} {
		name, part := component.name, component.part
		if part.Result.Status == statusAvailable {
			continue
		}
		// An absent correlation key is expected, unlike an attempted but incomplete read.
		if part.Result.Reason == "trace_context_absent" || part.Result.Reason == "correlation_key_absent" {
			continue
		}

		result.Warnings = append(result.Warnings, name+":"+part.Result.Status)

		if part.Meta != nil {
			part.Meta.QueryStatus = statusPartial
		}
	}

	if len(result.Warnings) > 0 {
		result.Status = statusPartial
	}
}
