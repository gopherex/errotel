package app

import "encoding/json"

type Range struct {
	Start string `json:"startUnixNano"`
	End   string `json:"endUnixNano"`
}
type Search struct {
	Range           Range         `json:"range"`
	Service         string        `json:"service,omitempty"`
	Environment     string        `json:"environment,omitempty"`
	ExceptionType   string        `json:"exceptionType,omitempty"`
	MessageContains string        `json:"messageContains,omitempty"`
	TraceID         string        `json:"traceId,omitempty"`
	RuntimeID       string        `json:"runtimeId,omitempty"`
	GroupKey        string        `json:"groupKey,omitempty"`
	Origin          string        `json:"origin,omitempty"`
	PageSize        int           `json:"pageSize,omitempty"`
	Cursor          string        `json:"cursor,omitempty"`
	Filter          *SearchFilter `json:"filter,omitempty"`
}

// SearchFilter is a validated read-side expression, never raw LogsQL.
type SearchFilter struct {
	Op       string         `json:"op"`
	Field    string         `json:"field,omitempty"`
	Value    *string        `json:"value,omitempty"`
	Children []SearchFilter `json:"children,omitempty"`
}
type HistogramBucket struct {
	Start string `json:"startUnixNano"`
	End   string `json:"endUnixNano"`
	Count int64  `json:"count"`
}
type HistogramResponse struct {
	Range      Range             `json:"range"`
	IntervalMS int64             `json:"intervalMs"`
	Buckets    []HistogramBucket `json:"buckets"`
	Total      int64             `json:"total"`
	Meta       Meta              `json:"meta"`
}
type Summary struct {
	Ref           string  `json:"ref"`
	Origin        string  `json:"origin"`
	EventID       string  `json:"eventId,omitempty"`
	Timestamp     string  `json:"timestampUnixNano"`
	Service       string  `json:"service,omitempty"`
	Environment   string  `json:"environment,omitempty"`
	Release       string  `json:"release,omitempty"`
	ExceptionType string  `json:"exceptionType,omitempty"`
	Message       *string `json:"message,omitempty"`
	Severity      *int    `json:"severityNumber,omitempty"`
	TraceID       string  `json:"traceId,omitempty"`
	SpanID        string  `json:"spanId,omitempty"`
	RuntimeID     string  `json:"runtimeId,omitempty"`
	ContextStatus string  `json:"contextStatus"`
}
type Meta struct {
	QueryStatus string   `json:"queryStatus"`
	ServedFrom  string   `json:"servedFrom"`
	FetchedAt   string   `json:"fetchedAt"`
	CacheAgeMS  int64    `json:"cacheAgeMs,omitempty"`
	Warnings    []string `json:"warnings"`
}
type SearchResponse struct {
	Items      []Summary `json:"items"`
	Range      Range     `json:"range"`
	NextCursor string    `json:"nextCursor,omitempty"`
	Meta       Meta      `json:"meta"`
}
type Payload struct {
	Status string         `json:"status"`
	Value  map[string]any `json:"value,omitempty"`
	Raw    *string        `json:"raw,omitempty"`
}
type Detail struct {
	Summary   Summary           `json:"summary"`
	Exception map[string]any    `json:"exception"`
	Payload   Payload           `json:"payload"`
	Fields    map[string]string `json:"storedFields"`
	Warnings  []string          `json:"warnings"`
}
type RelatedRequest struct {
	Kind     string `json:"kind"`
	Range    *Range `json:"range,omitempty"`
	PageSize int    `json:"pageSize,omitempty"`
}
type RelatedResult struct {
	Status string `json:"status"`
	Data   any    `json:"data,omitempty"`
	Reason string `json:"reason,omitempty"`
}
type TraceSpan struct {
	SpanID    string           `json:"spanId"`
	ParentID  string           `json:"parentSpanId,omitempty"`
	Operation string           `json:"operation"`
	Service   string           `json:"service"`
	Start     string           `json:"startUnixNano"`
	Duration  string           `json:"durationNano"`
	Tags      []map[string]any `json:"tags"`
	Logs      []map[string]any `json:"logs"`
}
type TraceData struct {
	TraceID      string      `json:"traceId"`
	Completeness string      `json:"completeness"`
	Spans        []TraceSpan `json:"spans"`
	Warnings     []string    `json:"warnings"`
}
type (
	row     map[string]string
	locator struct {
		Version int    `json:"v"`
		Source  string `json:"source"`
		EventID string `json:"eventId,omitempty"`
		Time    string `json:"time"`
		Stream  string `json:"stream,omitempty"`
		Hash    string `json:"hash,omitempty"`
	}
)

type cursor struct {
	Version  int    `json:"v"`
	Revision string `json:"revision"`
	Search   Search `json:"search"`
	Offset   int    `json:"offset"`
}

func canonical(value any) []byte {
	data, err := json.Marshal(value)
	if err != nil {
		panic("canonical encoding invariant")
	}

	return data
}
