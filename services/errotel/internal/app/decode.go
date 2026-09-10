package app

import (
	"fmt"

	"github.com/gopherex/errotel/services/errotel/internal/envelope"
)

func (a *App) baseDetail(record row, summary *Summary) Detail {
	detail := Detail{
		Summary: *summary, Exception: map[string]any{}, Payload: Payload{Status: "absent"},
		Fields: map[string]string{}, Warnings: []string{},
	}

	for key, value := range record {
		if key != "__errotel_hash" && key != "__errotel_row" && key != a.cfg.Fields["body"] {
			detail.Fields[key] = value
		}
	}

	for name, field := range map[string]string{
		"type": "exceptionType", "message": "exceptionMessage", "stacktrace": "exceptionStack",
	} {
		if value, exists := record[a.cfg.Fields[field]]; exists {
			detail.Exception[name] = value
		}
	}

	return detail
}

func (detail *Detail) payloadError(status string) {
	detail.Payload.Status = status
	detail.Summary.ContextStatus = status

	warning := status
	if status == statusInvalid {
		warning = "invalid_payload"
	}

	detail.Warnings = append(detail.Warnings, warning)
}

func (detail *Detail) preserveException(body map[string]any) {
	exception, exists := body["exception"].(map[string]any)
	if !exists {
		return
	}

	for _, key := range []string{"type", "message", "stacktrace"} {
		if value, isString := exception[key].(string); isString {
			detail.Exception[key] = value
		}
	}
}

func (a *App) decodeDetail(record row) (Detail, error) {
	summary, err := a.summary(record)
	if err != nil {
		return Detail{}, err
	}

	detail := a.baseDetail(record, &summary)
	if summary.Origin == originSDK {
		a.decodePayload(record, &detail)
	}

	return detail, nil
}

// Decode failures are payload states, not a failure to read the occurrence.
func (a *App) decodePayload(record row, detail *Detail) {
	raw := record[a.cfg.Fields["body"]]
	detail.Payload.Raw = &raw
	body, err := envelope.Decode(raw)

	if err != nil || body["schema"] != "app-debug" {
		detail.payloadError(statusInvalid)

		return
	}

	if fmt.Sprint(body["schemaVersion"]) != "1" {
		detail.payloadError("unsupported_version")

		return
	}

	detail.preserveException(body)

	if a.schema.Validate(body) != nil {
		detail.payloadError(statusInvalid)

		return
	}

	exception, exceptionOK := body["exception"].(map[string]any)
	runtime, runtimeOK := body["runtime"].(map[string]any)

	if !exceptionOK || !runtimeOK {
		detail.payloadError(statusInvalid)

		return
	}

	detail.Payload = Payload{Status: statusAvailable, Value: body}
	detail.Exception = exception

	if a.indexMismatch(record, body, runtime, detail) {
		detail.Warnings = append(detail.Warnings, "index_payload_mismatch")
	}
}

func (a *App) indexMismatch(record row, body, runtime map[string]any, detail *Detail) bool {
	expected := map[string]any{
		"eventId": body["eventId"], "schemaVersion": body["schemaVersion"], "kind": body["kind"],
		"groupKey": body["groupKey"], "runtimeId": runtime["id"], "sequence": runtime["sequence"],
		"exceptionType": detail.Exception["type"], "exceptionMessage": detail.Exception["message"],
		"exceptionStack": detail.Exception["stacktrace"], "mechanism": detail.Exception["mechanism"],
		"handled": detail.Exception["handled"], "traceId": nil, "spanId": nil,
	}
	if link, exists := body["trace"].(map[string]any); exists {
		expected["traceId"] = link["traceId"]
		expected["spanId"] = link["spanId"]
	}

	for field, value := range expected {
		stored, exists := record[a.cfg.Fields[field]]
		if value == nil {
			if exists && stored != "" {
				return true
			}

			continue
		}

		if !exists || stored != fmt.Sprint(value) {
			return true
		}
	}

	return fmt.Sprint(body["timestampUnixNano"]) != detail.Summary.Timestamp
}
