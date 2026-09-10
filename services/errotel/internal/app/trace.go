package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

func (a *App) loadTrace(ctx context.Context, traceID string) (RelatedResult, error) {
	if !validTrace(traceID) {
		return RelatedResult{}, requestError("invalid_trace_id")
	}

	if a.cfg.Traces.BaseURL == "" {
		return RelatedResult{Status: "not_configured"}, nil
	}

	ctx, cancel := context.WithTimeout(ctx, a.cfg.Queries.Timeout)
	defer cancel()

	return a.requestTrace(ctx, traceID), nil
}

func (a *App) requestTrace(ctx context.Context, traceID string) RelatedResult {
	base := strings.TrimRight(a.cfg.Traces.BaseURL, "/")
	if !strings.HasSuffix(base, "/select/jaeger") {
		base += "/select/jaeger"
	}
	// #nosec G704 -- The endpoint is validated server config; traceID is validated lowercase hex.
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/traces/"+traceID, http.NoBody)
	if err != nil {
		return RelatedResult{Status: "unavailable", Reason: "invalid_trace_endpoint"}
	}

	request.Header = a.tracesHeaders.Clone()
	// #nosec G704 -- Fixed configured upstream and validated ID; redirects are disabled.
	response, err := a.http.Do(request)
	if err != nil {
		return RelatedResult{Status: "unavailable", Reason: upstreamFailure(err).Error()}
	}

	defer response.Body.Close()

	if response.StatusCode == http.StatusNotFound {
		return RelatedResult{Status: statusNotFound}
	}

	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusPartialContent {
		return RelatedResult{Status: "unavailable", Reason: "upstream_unavailable"}
	}

	var body jaegerResponse

	decoder := json.NewDecoder(response.Body)
	decoder.UseNumber()

	if decoder.Decode(&body) != nil {
		return RelatedResult{Status: "unavailable", Reason: "invalid_trace_response"}
	}

	return body.normalize(traceID, response.StatusCode == http.StatusPartialContent)
}
