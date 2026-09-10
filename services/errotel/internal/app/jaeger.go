package app

import (
	"encoding/json"
	"math/big"
)

// These tags belong to the external Jaeger API and cannot be renamed.
type jaegerReference struct {
	RefType string `json:"refType"`
	TraceID string `json:"traceID"` //nolint:tagliatelle // Jaeger wire field.
	SpanID  string `json:"spanID"`  //nolint:tagliatelle // Jaeger wire field.
}

type jaegerSpan struct {
	TraceID    string            `json:"traceID"`   //nolint:tagliatelle // Jaeger wire field.
	SpanID     string            `json:"spanID"`    //nolint:tagliatelle // Jaeger wire field.
	ProcessID  string            `json:"processID"` //nolint:tagliatelle // Jaeger wire field.
	Operation  string            `json:"operationName"`
	Start      json.Number       `json:"startTime"`
	Duration   json.Number       `json:"duration"`
	Tags       []map[string]any  `json:"tags"`
	Logs       []map[string]any  `json:"logs"`
	Warnings   []string          `json:"warnings"`
	References []jaegerReference `json:"references"`
}

type jaegerTrace struct {
	TraceID   string       `json:"traceID"` //nolint:tagliatelle // Jaeger wire field.
	Spans     []jaegerSpan `json:"spans"`
	Processes map[string]struct {
		Service string `json:"serviceName"`
	} `json:"processes"`
	Warnings []string `json:"warnings"`
}

type jaegerResponse struct {
	Data   []jaegerTrace     `json:"data"`
	Errors []json.RawMessage `json:"errors"`
}

func microToNano(stamp json.Number) (string, error) {
	value, valid := new(big.Int).SetString(string(stamp), decimalBase)
	if !valid || value.Sign() < 0 {
		return "", requestError("invalid_jaeger_time")
	}

	return value.Mul(value, big.NewInt(nanosPerMicro)).String(), nil
}

func (span *jaegerSpan) normalize(traceID, service string) (TraceSpan, error) {
	start, startErr := microToNano(span.Start)
	duration, durationErr := microToNano(span.Duration)

	if startErr != nil || durationErr != nil || !validSpan(span.SpanID) || span.TraceID != traceID {
		return TraceSpan{}, requestError("invalid_trace_span")
	}

	result := TraceSpan{
		SpanID: span.SpanID, Operation: span.Operation, Service: service, Start: start, Duration: duration,
		Tags: span.Tags, Logs: span.Logs,
	}
	if result.Tags == nil {
		result.Tags = []map[string]any{}
	}

	if result.Logs == nil {
		result.Logs = []map[string]any{}
	}

	for _, ref := range span.References {
		if ref.RefType == "CHILD_OF" && ref.TraceID == traceID && validSpan(ref.SpanID) {
			result.ParentID = ref.SpanID

			break
		}
	}

	return result, nil
}

func (data *TraceData) appendTrace(source *jaegerTrace) bool {
	partial := len(source.Warnings) > 0

	if source.TraceID != data.TraceID {
		return true
	}

	if partial {
		data.Warnings = append(data.Warnings, "upstream_trace_warning")
	}

	for index := range source.Spans {
		span := &source.Spans[index]

		normalized, err := span.normalize(data.TraceID, source.Processes[span.ProcessID].Service)
		if err != nil {
			partial = true

			data.Warnings = append(data.Warnings, "invalid_trace_span")

			continue
		}

		if len(span.Warnings) > 0 {
			partial = true
		}

		data.Spans = append(data.Spans, normalized)
	}

	return partial
}

func (body *jaegerResponse) normalize(traceID string, partial bool) RelatedResult {
	if len(body.Data) == 0 {
		if len(body.Errors) > 0 {
			return RelatedResult{Status: "unavailable", Reason: "trace_query_errors"}
		}

		return RelatedResult{Status: statusNotFound}
	}

	data := TraceData{
		TraceID: traceID, Completeness: "unknown", Spans: []TraceSpan{},
		Warnings: []string{"trace_completeness_unknown"},
	}
	partial = partial || len(body.Errors) > 0

	for index := range body.Data {
		partial = data.appendTrace(&body.Data[index]) || partial
	}

	if len(data.Spans) == 0 {
		return RelatedResult{Status: "unavailable", Reason: "invalid_or_empty_trace"}
	}

	if partial {
		data.Completeness = statusPartial

		return RelatedResult{Status: statusPartial, Data: data, Reason: "upstream_partial"}
	}

	return RelatedResult{Status: statusAvailable, Data: data}
}
