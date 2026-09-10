package app

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
)

type upstreamError struct {
	code   string
	status int
}

func (err *upstreamError) Error() string { return err.code }
func upstreamFailure(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return &upstreamError{"upstream_timeout", http.StatusGatewayTimeout}
	}

	return &upstreamError{"upstream_unavailable", http.StatusBadGateway}
}

func readNDJSON(reader io.Reader, limit int) ([]row, error) {
	record := bufio.NewReader(reader)
	rows := []row{}

	for {
		line, err := record.ReadBytes('\n') // grows with the record; no Scanner's 64 KiB ceiling
		if strings.TrimSpace(string(line)) != "" {
			var value row
			if err := json.Unmarshal(line, &value); err != nil || value == nil {
				return nil, &upstreamError{"invalid_upstream_ndjson", http.StatusBadGateway}
			}

			rows = append(rows, value)
			if len(rows) > limit {
				return nil, &upstreamError{"upstream_row_budget_exceeded", http.StatusBadGateway}
			}
		}

		if err == io.EOF {
			return rows, nil
		}

		if err != nil {
			return nil, upstreamFailure(err)
		}
	}
}

func (a *App) logs(ctx context.Context, query string, record Range, limit int) ([]row, bool, error) {
	if a.observer == nil {
		return a.readLogs(ctx, query, record, limit)
	}

	ctx, finish := a.observer.Upstream(ctx, "victorialogs.query")
	rows, partial, err := a.readLogs(ctx, query, record, limit)
	outcome := "complete"

	if err != nil {
		outcome = "failed"

		var failure *upstreamError

		if errors.As(err, &failure) {
			outcome = failure.code
		}
	} else if partial {
		outcome = "partial"
	}

	finish(outcome)

	return rows, partial, err
}

func (a *App) readLogs(ctx context.Context, query string, record Range, limit int) ([]row, bool, error) {
	start, _ := parseNano(record.Start)
	end, _ := parseNano(record.End)
	// Keep the absolute range explicit in the structured LogsQL query.
	timeFilter := "_time:[" + quote(time.Unix(0, start).UTC().Format(time.RFC3339Nano)) + "," +
		quote(time.Unix(0, end).UTC().Format(time.RFC3339Nano)) + ") AND "
	body := url.Values{
		"query":                  {timeFilter + query},
		"timeout":                {a.cfg.Queries.Timeout.String()},
		"allow_partial_response": {"0"},
	}

	ctx, cancel := context.WithTimeout(ctx, a.cfg.Queries.Timeout)
	defer cancel()

	req,
		err := http.NewRequestWithContext(ctx,
		http.MethodPost,
		strings.TrimRight(a.cfg.Logs.BaseURL,
			"/")+"/select/logsql/query",
		strings.NewReader(body.Encode()))
	if err != nil {
		return nil, false, upstreamFailure(err)
	}

	req.Header = a.logsHeaders.Clone()
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))

	resp, err := a.http.Do(req)
	if err != nil {
		return nil, false, upstreamFailure(err)
	}

	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		if resp.StatusCode == http.StatusGatewayTimeout {
			return nil, false, &upstreamError{"upstream_timeout", http.StatusGatewayTimeout}
		}

		return nil, false, &upstreamError{"upstream_unavailable", http.StatusBadGateway}
	}

	rows, err := readNDJSON(resp.Body, limit)

	if ctx.Err() != nil {
		return nil, false, upstreamFailure(ctx.Err())
	}

	partial := resp.StatusCode == http.StatusPartialContent ||
		resp.Header.Get("X-Partial-Response") == "true" ||
		resp.Header.Get("Vl-Partial-Response") == "true"

	return rows, partial, err
}

func (a *App) loadSearch(ctx context.Context, search *Search, offset int) (SearchResponse, error) {
	response := SearchResponse{
		Items: []Summary{},
		Range: search.Range,
		Meta: Meta{
			QueryStatus: "complete",
			ServedFrom:  "upstream",
			FetchedAt:   time.Now().UTC().Format(time.RFC3339Nano),
			Warnings:    []string{},
		},
	}
	rows := []row{}
	limit := offset + search.PageSize + 1

	for _, origin := range []string{originSDK, originOTel} {
		if search.Origin != originBoth && search.Origin != origin {
			continue
		}

		part, partial, err := a.logs(ctx, a.searchQuery(search, origin, limit), search.Range, limit)
		if err != nil {
			return response, err
		}

		rows = append(rows, part...)

		if partial {
			response.Meta.QueryStatus = statusPartial
			response.Meta.Warnings = append(response.Meta.Warnings, "upstream_partial")
		}
	}

	a.order(rows)

	if offset >= len(rows) {
		return response, nil
	}

	rows = rows[offset:]
	if len(rows) > search.PageSize {
		rows = rows[:search.PageSize]

		if offset+search.PageSize <= a.cfg.Queries.MaxOffset {
			response.NextCursor = encode(cursor{1, a.revision, *search, offset + search.PageSize})
		} else {
			response.Meta.QueryStatus = statusPartial
			response.Meta.Warnings = append(response.Meta.Warnings, "offset_budget_exceeded")
		}
	}

	seen := map[string]bool{}

	for _, record := range rows {
		item, err := a.summary(record)
		if err != nil {
			response.Meta.QueryStatus = statusPartial
			response.Meta.Warnings = append(response.Meta.Warnings, "invalid_stored_index")

			continue
		}

		if item.EventID != "" {
			if seen[item.EventID] {
				continue
			}

			seen[item.EventID] = true
		}

		response.Items = append(response.Items, item)
	}

	return response, nil
}

func (a *App) loadDetail(ctx context.Context, loc *locator) (Detail, error) {
	stamp, _ := parseNano(loc.Time)
	record := Range{loc.Time, strconv.FormatInt(stamp+1, 10)}

	query := a.exact("eventId", loc.EventID)
	if loc.EventID == "" {
		query = a.exact("stream",
			loc.Stream) +
			" | pack_json as __errotel_row | hash(__errotel_row) as __errotel_hash | filter __errotel_hash:=" +
			quote(loc.Hash) +
			" | delete __errotel_row"
	}

	query += " | sort by (_time) limit " + strconv.Itoa(a.cfg.Queries.MaxDetailRows+1)

	rows, partial, err := a.logs(ctx, query, record, a.cfg.Queries.MaxDetailRows+1)
	if err != nil {
		return Detail{}, err
	}

	if len(rows) == 0 {
		return Detail{}, &upstreamError{statusNotFound, http.StatusNotFound}
	}

	detail, err := a.decodeDetail(rows[0])
	if err != nil {
		return detail, err
	}

	if len(rows) > a.cfg.Queries.MaxDetailRows {
		detail.Warnings = append(detail.Warnings, "detail_row_budget_exceeded")
	}

	if partial {
		detail.Warnings = append(detail.Warnings, "upstream_partial")
	}

	if len(rows) > 1 {
		if loc.EventID == "" {
			detail.Warnings = append(detail.Warnings, "ambiguous_identical_logs")
		}

		for _, value := range rows[1:] {
			if value[a.cfg.Fields["body"]] != rows[0][a.cfg.Fields["body"]] {
				detail.Warnings = append(detail.Warnings, "event_id_body_conflict")

				break
			}
		}
	}

	return detail, nil
}
