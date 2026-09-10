package app

import (
	"context"
	"strconv"
	"time"
)

const (
	relationTimeWindow  = "time_window"
	relationSameTrace   = "same_trace"
	relationSameRuntime = "same_runtime"
)

func hasWarning(detail *Detail, writer string) bool {
	for _, value := range detail.Warnings {
		if value == writer {
			return true
		}
	}

	return false
}

func (a *App) related(ctx context.Context, loc *locator, req RelatedRequest) (RelatedResult, error) {
	if req.Kind != "same_span" && req.Kind != relationSameTrace &&
		req.Kind != relationSameRuntime && req.Kind != relationTimeWindow {
		return RelatedResult{}, requestError("invalid_relation")
	}

	if req.PageSize == 0 {
		req.PageSize = 50
	}

	if req.PageSize < 1 || req.PageSize > a.cfg.Queries.MaxPageSize {
		return RelatedResult{}, requestError("invalid_page_size")
	}

	if req.Range != nil && a.validateRange(*req.Range) != nil {
		return RelatedResult{}, requestError("invalid_range")
	}

	detail, err := a.loadDetail(ctx, loc)
	if err != nil {
		return RelatedResult{}, err
	}

	return a.relatedWithDetail(ctx, loc, req, &detail), nil
}

func (a *App) relatedWithDetail(ctx context.Context, loc *locator, req RelatedRequest, detail *Detail) RelatedResult {
	if hasWarning(detail, "index_payload_mismatch") || hasWarning(detail, "event_id_body_conflict") {
		return RelatedResult{Status: "unavailable", Reason: "conflicting_identifiers"}
	}

	stamp, _ := parseNano(loc.Time)

	record := Range{
		strconv.FormatInt(max(0,
			stamp-int64(relatedWindowMinutes*time.Minute)),
			10),
		strconv.FormatInt(stamp+int64(relatedWindowMinutes*time.Minute),
			10),
	}
	if req.Range != nil {
		record = *req.Range
	}

	relation := a.relationQuery(&req, detail, record)
	query, evidence := relation.query, relation.evidence

	if query == "" {
		return RelatedResult{Status: statusNotFound, Reason: "correlation_key_absent"}
	}

	query += " | sort by (" + a.field("time") + ") limit " + strconv.Itoa(req.PageSize+1)

	return a.relatedRows(ctx, query, record, req.PageSize, evidence)
}

func (a *App) relatedRows(
	ctx context.Context, query string, record Range, pageSize int, evidence map[string]any,
) RelatedResult {
	rows, partial, err := a.logs(ctx, query, record, pageSize+1)
	if err != nil {
		return RelatedResult{Status: "unavailable", Reason: err.Error()}
	}

	if len(rows) == 0 {
		return RelatedResult{Status: statusNotFound}
	}

	reason := ""

	if len(rows) > pageSize {
		partial = true
		reason = "row_limit"
		rows = rows[:pageSize]
	}

	if partial && reason == "" {
		reason = "upstream_partial"
	}

	items := []any{}

	for _, row := range rows {
		stamp, err := rowTime(row, a.cfg.Fields["time"])
		if err != nil {
			partial = true
			reason = "invalid_stored_time"

			continue
		}

		items = append(items, map[string]any{"timestampUnixNano": stamp, "fields": row})
	}

	result := RelatedResult{Status: statusAvailable, Data: map[string]any{"evidence": evidence, "items": items}}
	if partial {
		result.Status = statusPartial
		result.Reason = reason
	}

	return result
}

type relationQuery struct {
	query    string
	evidence map[string]any
}

func (a *App) relationQuery(req *RelatedRequest, detail *Detail, record Range) relationQuery {
	evidence := map[string]any{"kind": req.Kind}
	query := ""

	switch req.Kind {
	case "same_span":
		if detail.Summary.TraceID != "" && detail.Summary.SpanID != "" {
			query = a.exact("traceId", detail.Summary.TraceID) + " AND " + a.exact("spanId", detail.Summary.SpanID)
			evidence["traceId"] = detail.Summary.TraceID
			evidence["spanId"] = detail.Summary.SpanID
		}
	case relationSameTrace:
		if detail.Summary.TraceID != "" {
			query = a.exact("traceId", detail.Summary.TraceID)
			evidence["traceId"] = detail.Summary.TraceID
		}
	case relationSameRuntime:
		if detail.Summary.RuntimeID != "" {
			query = a.exact("runtimeId", detail.Summary.RuntimeID)
			evidence["runtimeId"] = detail.Summary.RuntimeID
		}
	case relationTimeWindow:
		query = "*"
		evidence["range"] = record

		if detail.Summary.Service != "" {
			query = a.exact("service", detail.Summary.Service)
			evidence["service"] = detail.Summary.Service
		}
	}

	return relationQuery{query, evidence}
}
