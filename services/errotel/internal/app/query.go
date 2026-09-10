package app

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

var (
	nanoPattern  = regexp.MustCompile(`^(0|[1-9]\d*)$`)
	tracePattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
	spanPattern  = regexp.MustCompile(`^[0-9a-f]{16}$`)
	hashPattern  = regexp.MustCompile(`^\d{1,20}$`)
)

func validTrace(search string) bool {
	return tracePattern.MatchString(search) && search != strings.Repeat("0", traceIDLength)
}

func validSpan(search string) bool {
	return spanPattern.MatchString(search) && search != strings.Repeat("0", spanIDLength)
}

func validID(search string) bool {
	u, err := uuid.Parse(search)

	return err == nil && u.Version() == 4 && u.Variant() == uuid.RFC4122 && u.String() == search
}

func parseNano(search string) (int64, error) {
	if !nanoPattern.MatchString(search) {
		return 0, requestError("invalid_time")
	}

	value, err := strconv.ParseInt(search, decimalBase, 64)
	if err != nil {
		return 0, fmt.Errorf("parse nanoseconds: %w", err)
	}

	return value, nil
}

func (a *App) validateRange(record Range) error {
	start, err := parseNano(record.Start)
	if err != nil {
		return fmt.Errorf("decode request: %w", err)
	}

	end, err := parseNano(record.End)
	if err != nil || end <= start || end-start > int64(a.cfg.Queries.MaxRange) {
		return requestError("invalid_range")
	}

	return nil
}

func strictDecode(data []byte, value any) error {
	detail := json.NewDecoder(bytes.NewReader(data))
	detail.DisallowUnknownFields()

	if err := detail.Decode(value); err != nil {
		return fmt.Errorf("decode request: %w", err)
	}

	var extra any
	if err := detail.Decode(&extra); err != io.EOF {
		return requestError("trailing_json")
	}

	return nil
}
func encode(value any) string { return base64.RawURLEncoding.EncodeToString(canonical(value)) }
func decode(search string, value any) error {
	if len(search) > maxEncodedSize {
		return requestError("invalid_encoding")
	}

	data, err := base64.RawURLEncoding.Strict().DecodeString(search)
	if err != nil {
		return fmt.Errorf("decode request: %w", err)
	}

	return strictDecode(data, value)
}

func (a *App) parseLocator(search string) (locator, error) {
	var loc locator
	if decode(search, &loc) != nil || loc.Version != 1 || loc.Source != a.cfg.Source {
		return loc, requestError("invalid_locator")
	}

	stamp, err := parseNano(loc.Time)
	if err != nil || stamp == int64(^uint64(0)>>1) {
		return loc, requestError("invalid_locator")
	}

	if loc.EventID != "" {
		if !validID(loc.EventID) || loc.Hash != "" || loc.Stream != "" {
			return loc, requestError("invalid_locator")
		}
	} else if !hashPattern.MatchString(loc.Hash) || loc.Stream == "" || len(loc.Stream) > 1024 {
		return loc, requestError("invalid_locator")
	}

	return loc, nil
}

func (a *App) normalize(search *Search) (int, error) {
	if a.validateRange(search.Range) != nil {
		return 0, requestError("invalid_range")
	}

	if err := validateSearchFilter(search.Filter); err != nil {
		return 0, err
	}

	if search.Origin == "" {
		search.Origin = originBoth
	}

	if search.Origin != originSDK && search.Origin != originOTel && search.Origin != originBoth {
		return 0, requestError("invalid_origin")
	}

	if search.PageSize == 0 {
		search.PageSize = 50
	}

	if search.PageSize < 1 || search.PageSize > a.cfg.Queries.MaxPageSize {
		return 0, requestError("invalid_page_size")
	}

	if err := validateLegacyFilters(search); err != nil {
		return 0, err
	}

	if (search.TraceID != "" && !validTrace(search.TraceID)) || (search.RuntimeID != "" && !validID(search.RuntimeID)) {
		return 0, requestError("invalid_id")
	}

	return a.cursorOffset(search)
}

func (a *App) cursorOffset(search *Search) (int, error) {
	encoded := search.Cursor
	search.Cursor = ""

	if encoded == "" {
		return 0, nil
	}

	var decodedCursor cursor
	if decode(encoded,
		&decodedCursor) != nil ||
		decodedCursor.Version != 1 ||
		decodedCursor.Revision != a.revision ||
		decodedCursor.Offset < 0 ||
		decodedCursor.Offset > a.cfg.Queries.MaxOffset ||
		!bytes.Equal(canonical(decodedCursor.Search),
			canonical(search)) {
		return 0, requestError("invalid_cursor")
	}

	return decodedCursor.Offset, nil
}

// Both names and literals are escaped. Names originate exclusively in config.
func quote(search string) string        { return strconv.Quote(search) }
func (a *App) field(name string) string { return quote(a.cfg.Fields[name]) }
func (a *App) exact(name, value string) string {
	if a.cfg.Fields[name] == "_stream_id" {
		return a.field(name) + ":" + quote(value)
	}

	return a.field(name) + ":=" + quote(value)
}

func (a *App) indexNames() []string {
	keys := []string{
		"time",
		"stream",
		"traceId",
		"spanId",
		"severityNumber",
		"eventName",
		"service",
		"environment",
		"release",
		"exceptionType",
		"exceptionMessage",
		"schemaVersion",
		"kind",
		"eventId",
		"runtimeId",
		"sequence",
		"mechanism",
		"handled",
		"groupKey",
	}
	names := make([]string, 0, len(keys))

	for _, key := range keys {
		names = append(names, a.field(key))
	}

	return names
}

func (a *App) matchingQuery(search *Search, origin string) string {
	sdk := a.exact("kind", "exception") + " AND " + a.field("eventId") + ":~" +
		quote(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	vanilla := "(" +
		a.field("exceptionType") +
		":* OR " +
		a.field("exceptionMessage") +
		":* OR " +
		a.field("exceptionStack") +
		":* OR " +
		a.exact("eventName",
			"exception") + " OR " + a.exact("kind", "exception") +
		") AND NOT (" + sdk + ")"
	query := sdk

	if origin == originOTel {
		query = vanilla
	}

	filters := []struct{ key, value string }{
		{"service", search.Service},
		{"environment", search.Environment},
		{"exceptionType", search.ExceptionType},
		{"traceId", search.TraceID},
		{"runtimeId", search.RuntimeID},
		{"groupKey", search.GroupKey},
	}

	var filterQuery strings.Builder

	for _, filter := range filters {
		if filter.value != "" {
			filterQuery.WriteString(" AND " + a.exact(filter.key, filter.value))
		}
	}

	query += filterQuery.String()

	if search.MessageContains != "" {
		query += " AND " + a.field("exceptionMessage") + ":~" + quote(regexp.QuoteMeta(search.MessageContains))
	}

	if search.Filter != nil {
		query += " AND (" + a.filterQuery(search.Filter) + ")"
	}

	return query
}

func (a *App) searchQuery(search *Search, origin string, limit int) string {
	query := a.matchingQuery(search, origin)

	names := a.indexNames()

	if origin == originOTel {
		// Vanilla has no event ID. VM hashes its canonical packed row; the API never
		// downloads Body during search. Detail recomputes this same fingerprint.
		query += " | pack_json as __errotel_row | hash(__errotel_row) as __errotel_hash"

		names = append(names, "__errotel_hash")
	}

	query += " | fields " + strings.Join(names, ", ")
	if origin == originSDK {
		query += " | last 1 by (" + a.field("time") + ") partition by (" + a.field("eventId") + ")"
	}

	query += " | sort by (" +
		a.field("time") +
		" desc, " +
		a.field("eventId") +
		" desc, " +
		a.field("stream") +
		" desc"
	if origin == originOTel {
		query += ", __errotel_hash desc"
	}

	return query + ") limit " + strconv.Itoa(limit)
}

func rowTime(record row, f string) (string, error) {
	t, err := time.Parse(time.RFC3339Nano, record[f])
	if err != nil || t.UnixNano() < 0 {
		return "", requestError("invalid_stored_time")
	}

	return strconv.FormatInt(t.UnixNano(), 10), nil
}

func (a *App) summary(record row) (Summary, error) {
	value := func(key string) string { return record[a.cfg.Fields[key]] }

	stamp, err := rowTime(record, a.cfg.Fields["time"])
	if err != nil {
		return Summary{}, err
	}

	search := Summary{
		Origin:        originOTel,
		Timestamp:     stamp,
		Service:       value("service"),
		Environment:   value("environment"),
		Release:       value("release"),
		ExceptionType: value("exceptionType"),
		ContextStatus: "absent",
	}
	if x, ok := record[a.cfg.Fields["exceptionMessage"]]; ok {
		search.Message = &x
	}

	if x, err := strconv.Atoi(value("severityNumber")); err == nil {
		search.Severity = &x
	}

	if validTrace(value("traceId")) {
		search.TraceID = value("traceId")
		if validSpan(value("spanId")) {
			search.SpanID = value("spanId")
		}
	}

	if validID(value("runtimeId")) {
		search.RuntimeID = value("runtimeId")
	}

	loc := locator{Version: 1, Source: a.cfg.Source, Time: stamp}

	if value("kind") == "exception" && validID(value("eventId")) {
		search.Origin = originSDK
		search.EventID = value("eventId")
		search.ContextStatus = "not_loaded"
		loc.EventID = search.EventID
	} else {
		if value("kind") == "exception" {
			search.Origin = originSDK
			search.ContextStatus = "invalid"
		}

		loc.Stream = value("stream")
		loc.Hash = record["__errotel_hash"]

		if loc.Hash == "" {
			return search, requestError("invalid_sdk_index")
		}
	}

	search.Ref = encode(loc)

	return search, nil
}

func (a *App) order(rows []row) {
	sort.SliceStable(rows, func(i, j int) bool {
		loc, record := rows[i], rows[j]
		lt, _ := rowTime(loc, a.cfg.Fields["time"])
		rt, _ := rowTime(record, a.cfg.Fields["time"])
		ln, _ := parseNano(lt)
		rn, _ := parseNano(rt)

		if ln != rn {
			return ln > rn
		}

		// Keep each upstream's natural tie order. Re-sorting UUID strings
		// lexicographically changes top-k prefixes and repeats/skips pages.
		// Stable merge puts SDK rows before vanilla rows at equal timestamps.

		return false
	})
}

func validateLegacyFilters(search *Search) error {
	for _, value := range []string{
		search.Service,
		search.Environment,
		search.ExceptionType,
		search.MessageContains,
		search.GroupKey,
	} {
		if len(value) > maxFilterLength {
			return requestError("filter_too_long")
		}
	}

	return nil
}
