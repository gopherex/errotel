package app

// requestError is a comparable, immutable error code, never a user value.
type requestError string

func (code requestError) Error() string { return string(code) }

const (
	maxRequestBytes      = 64 << 10
	maxPageSize          = 200
	maxEncodedSize       = 16384
	maxFilterLength      = 2048
	traceIDLength        = 32
	spanIDLength         = 16
	decimalBase          = 10
	nanosPerMicro        = 1000
	relatedWindowMinutes = 5
	originSDK            = "sdk"
	originOTel           = "otel-log"
	originBoth           = "both"
	statusAvailable      = "available"
	statusNotFound       = "not_found"
	statusPartial        = "partial"
	statusInvalid        = "invalid"
)
