package telemetry_test

import (
	"context"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	logs "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	metrics "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	traces "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/proto"

	"github.com/gopherex/errotel/services/errotel/internal/app"
	"github.com/gopherex/errotel/services/errotel/internal/telemetry"
)

type recordings struct {
	mu      sync.Mutex
	logs    logs.ExportLogsServiceRequest
	metrics metrics.ExportMetricsServiceRequest
	traces  traces.ExportTraceServiceRequest
}

func (records *recordings) receive(writer http.ResponseWriter, request *http.Request) {
	body, err := io.ReadAll(request.Body)
	if err != nil {
		writer.WriteHeader(http.StatusBadRequest)

		return
	}

	records.mu.Lock()
	defer records.mu.Unlock()

	var target proto.Message

	switch request.URL.Path {
	case "/v1/logs":
		target = &records.logs
	case "/v1/metrics":
		target = &records.metrics
	case "/v1/traces":
		target = &records.traces
	default:
		writer.WriteHeader(http.StatusNotFound)

		return
	}

	if err := (proto.UnmarshalOptions{Merge: true}).Unmarshal(body, target); err != nil {
		writer.WriteHeader(http.StatusBadRequest)

		return
	}

	writer.Header().Set("Content-Type", "application/x-protobuf")
	writer.WriteHeader(http.StatusOK)
}

// Global OTel providers are process-owned, so this test must not run in parallel.
func TestHTTPMetricsLogsTracesAndSafeLabels(t *testing.T) {
	records := &recordings{}

	collector := httptest.NewServer(http.HandlerFunc(records.receive))
	defer collector.Close()

	for _, key := range []string{
		"OTEL_SDK_DISABLED", "OTEL_TRACES_EXPORTER", "OTEL_LOGS_EXPORTER", "OTEL_METRICS_EXPORTER",
		"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
		"OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_COMPRESSION",
	} {
		t.Setenv(key, "")
	}

	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", collector.URL)
	t.Setenv("OTEL_TRACES_SAMPLER", "always_on")
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment.name=synthetic")
	t.Setenv("APP_DEBUG_API_TOKEN", "secret-api-token")

	upstreamParents := make(chan string, 8)

	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		upstreamParents <- request.Header.Get("Traceparent")

		writer.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	cfg, err := app.LoadConfig("")
	require.NoError(t, err)

	cfg.Logs.BaseURL = upstream.URL
	cfg.Service.Logger.Level = "debug"
	providers, err := telemetry.Setup(t.Context(), &cfg.Service)
	require.NoError(t, err)

	defer providers.Shutdown(context.Background())

	logger, err := telemetry.NewLogger(&cfg.Service)
	require.NoError(t, err)
	application, err := app.New(&cfg, logger)
	require.NoError(t, err)

	defer application.Close()
	handler := application.Handler()
	send := func(path, token string) *httptest.ResponseRecorder {
		body := `{"range":{"startUnixNano":"1000000000000000000","endUnixNano":"1000000001000000000"},"origin":"sdk"}`
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Traceparent", "00-12345678901234567890123456789012-1234567890123456-01")

		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		return response
	}
	require.Equal(t, http.StatusOK, send("/api/v1/occurrences/search", "secret-api-token").Code)
	hit := send("/api/v1/occurrences/search", "secret-api-token")
	require.Equal(t, "hit", hit.Header().Get("X-Errotel-Cache"))
	require.NotEmpty(t, hit.Header().Get("X-Request-Id"))
	require.Equal(t, http.StatusUnauthorized, send("/api/v1/occurrences/search", "wrong-secret-token").Code)
	require.Contains(t, <-upstreamParents, "12345678901234567890123456789012")

	scrape := httptest.NewRecorder()
	providers.Metrics.ServeHTTP(scrape, httptest.NewRequest(http.MethodGet, "/metrics", http.NoBody))
	require.Equal(t, http.StatusOK, scrape.Code)

	for _, expected := range []string{
		"http_server_request_duration_seconds_count", "errotel_cache_requests_total",
		`outcome="hit"`, `http_response_status_code="401"`, "go", "service_version",
	} {
		require.Contains(t, scrape.Body.String(), expected)
	}

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	require.NoError(t, providers.Shutdown(ctx))
	records.mu.Lock()
	defer records.mu.Unlock()
	require.NotEmpty(t, records.metrics.GetResourceMetrics())
	require.NotEmpty(t, records.logs.GetResourceLogs())
	require.NotEmpty(t, records.traces.GetResourceSpans())

	exported := records.logs.String() + records.traces.String() + records.metrics.String() + scrape.Body.String()
	for _, secret := range []string{"secret-api-token", "wrong-secret-token", "startUnixNano", upstream.URL} {
		require.NotContains(t, exported, secret)
	}

	spans := records.traces.GetResourceSpans()[0].GetScopeSpans()[0].GetSpans()
	require.GreaterOrEqual(t, len(spans), 4)

	for _, span := range spans {
		require.Equal(t, "12345678901234567890123456789012", hex.EncodeToString(span.GetTraceId()))
	}

	record := records.logs.GetResourceLogs()[0].GetScopeLogs()[0].GetLogRecords()[0]
	require.Equal(t, "12345678901234567890123456789012", hex.EncodeToString(record.GetTraceId()))
	require.NotEmpty(t, record.GetSpanId())
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(_ error) {}))
}
