//go:build integration

package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/docker/go-connections/nat"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
	collectlogs "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	common "go.opentelemetry.io/proto/otlp/common/v1"
	logs "go.opentelemetry.io/proto/otlp/logs/v1"
	resource "go.opentelemetry.io/proto/otlp/resource/v1"
	"google.golang.org/protobuf/proto"

	"github.com/gopherex/errotel/services/errotel/internal/app"
	"github.com/gopherex/errotel/services/errotel/internal/oas"
)

const (
	testToken = "isolated-testcontainers-token"
	logsImage = "victoriametrics/victoria-logs:v1.52.0@sha256:" +
		"47b820890d64c4575a2a0a46415dcd8a4fd59a0f1fcd6a377693d7aea639442e"
	tracesImage = "victoriametrics/victoria-traces:v0.11.0@sha256:" +
		"9947b14b6b9baa61b8efef64467a7118ee54ccd6be6b7c1849f6fdd65d8e17fd"
	metricsImage = "victoriametrics/victoria-metrics:v1.151.0@sha256:" +
		"6d164540a04f49ba4e696cbdb70f9fee78be1e94b8f2a1292743a0b1ab8275bd"
)

type security struct{}

func (security) BearerAuth(context.Context, oas.OperationName) (oas.BearerAuth, error) {
	return oas.BearerAuth{Token: testToken}, nil
}

func startVM(t *testing.T, image string, port nat.Port) string {
	t.Helper()

	request := testcontainers.ContainerRequest{
		Image: image, ExposedPorts: []string{string(port)},
		WaitingFor: wait.ForHTTP("/health").WithPort(port).WithStartupTimeout(time.Minute),
	}
	if image == logsImage {
		request.Cmd = []string{"-insert.maxLineSizeBytes=2MiB"}
	}

	container, err := testcontainers.GenericContainer(t.Context(), testcontainers.GenericContainerRequest{
		ContainerRequest: request, Started: true,
	})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, container.Terminate(context.Background())) })
	host, err := container.Host(t.Context())
	require.NoError(t, err)
	mapped, err := container.MappedPort(t.Context(), port)
	require.NoError(t, err)

	return "http://" + host + ":" + mapped.Port()
}

func fixture(t *testing.T) map[string]any {
	t.Helper()

	raw, err := os.ReadFile("../../../../docs/fixtures/exception-envelope.json")
	require.NoError(t, err)

	var body map[string]any

	require.NoError(t, json.Unmarshal(raw, &body))

	return body
}

func field(key, value string) *common.KeyValue {
	return &common.KeyValue{Key: key, Value: &common.AnyValue{Value: &common.AnyValue_StringValue{StringValue: value}}}
}

func seedLogs(t *testing.T, endpoint string, body map[string]any, stamp int64) {
	t.Helper()

	attrs := make([]*common.KeyValue, 0, 10)
	attrs = append(attrs,
		field("app.debug.schema.version", "1"), field("app.debug.kind", "exception"),
		field("app.debug.event.id", body["eventId"].(string)),
		field("app.debug.runtime.id", "b35e19ae-b217-4f30-ab89-0a9084b7f144"),
		field("app.debug.event.sequence", "3"),
		field("app.debug.exception.mechanism", "manual"), field("app.debug.exception.handled", "true"),
	)
	exception := body["exception"].(map[string]any)

	for _, name := range []string{"type", "message", "stacktrace"} {
		attrs = append(attrs, field("exception."+name, exception[name].(string)))
	}
	// No trace fields in this seed; browser tests cover actual native span linkage.
	delete(body, "trace")
	raw, err := json.Marshal(body)
	require.NoError(t, err)

	record := &logs.LogRecord{
		TimeUnixNano: uint64(stamp), ObservedTimeUnixNano: uint64(stamp),
		SeverityNumber: logs.SeverityNumber_SEVERITY_NUMBER_ERROR,
		Attributes:     attrs, Body: &common.AnyValue{Value: &common.AnyValue_StringValue{StringValue: string(raw)}},
	}
	request := &collectlogs.ExportLogsServiceRequest{ResourceLogs: []*logs.ResourceLogs{{
		Resource:  &resource.Resource{Attributes: []*common.KeyValue{field("service.name", "integration-synthetic")}},
		ScopeLogs: []*logs.ScopeLogs{{LogRecords: []*logs.LogRecord{record, record}}},
	}}}
	data, err := proto.Marshal(request)
	require.NoError(t, err)
	httpRequest, err := http.NewRequestWithContext(
		t.Context(), http.MethodPost, endpoint+"/insert/opentelemetry/v1/logs", bytes.NewReader(data),
	)
	require.NoError(t, err)
	httpRequest.Header.Set("Content-Type", "application/x-protobuf")
	response, err := http.DefaultClient.Do(httpRequest)
	require.NoError(t, err)

	defer response.Body.Close()
	require.Equal(t, http.StatusOK, response.StatusCode)
}

func startAPI(t *testing.T, logsURL, tracesURL, metricsURL string) (*httptest.Server, *oas.Client) {
	t.Helper()

	config, err := app.LoadConfig("")
	require.NoError(t, err)

	config.Logs.BaseURL = logsURL
	config.Traces.BaseURL = tracesURL
	config.Metrics.BaseURL = metricsURL
	config.Cache.MaxEntryBytes = 1024
	application, err := app.New(&config, nil)
	require.NoError(t, err)
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	t.Cleanup(server.Close)
	client, err := oas.NewClient(server.URL, security{})
	require.NoError(t, err)

	return server, client
}

func TestVictoriaRoundTrip(t *testing.T) {
	t.Setenv("APP_DEBUG_API_TOKEN", testToken)
	logsURL := startVM(t, logsImage, "9428/tcp")
	tracesURL := startVM(t, tracesImage, "10428/tcp")
	metricsURL := startVM(t, metricsImage, "8428/tcp")
	body := fixture(t)
	stamp := time.Now().Add(-time.Second).UnixNano()
	body["timestampUnixNano"] = strconv.FormatInt(stamp, 10)
	body["extensions"] = map[string]any{"large": strings.Repeat("x", 1<<20)}
	seedLogs(t, logsURL, body, stamp)
	server, client := startAPI(t, logsURL, tracesURL, metricsURL)
	search := &oas.OccurrenceSearch{
		Range: oas.TimeRange{
			StartUnixNano: oas.WireUnixNano(strconv.FormatInt(stamp-1, 10)),
			EndUnixNano:   oas.WireUnixNano(strconv.FormatInt(stamp+1, 10)),
		},
		Origin:  oas.NewOptOccurrenceSearchOrigin(oas.OccurrenceSearchOriginSdk),
		Service: oas.NewOptString("integration-synthetic"),
	}

	var found *oas.SearchResponseHeaders

	require.Eventually(t, func() bool {
		var err error
		found, err = client.SearchOccurrences(t.Context(), search)

		return err == nil && len(found.Response.Items) == 1
	}, 15*time.Second, 200*time.Millisecond)
	require.Len(t, found.Response.Items, 1, "retry must not create a new SDK occurrence")
	reference := found.Response.Items[0].Ref

	var detail *oas.OccurrenceDetailHeaders

	var err error

	require.Eventually(t, func() bool {
		detail, err = client.GetOccurrence(t.Context(), oas.GetOccurrenceParams{Ref: reference})

		return err == nil
	}, 10*time.Second, 200*time.Millisecond)
	require.NoError(t, err)
	raw, err := detail.Response.MarshalJSON()
	require.NoError(t, err)
	require.Greater(t, len(raw), 1<<20, "maxEntryBytes must not truncate responses")
	require.Empty(t, detail.Response.Warnings)
	require.Contains(t, string(raw), "Привет 世界") //nolint:gosmopolitan // Verify Unicode survives the wire.
	server.Close()

	restarted, restartedClient := startAPI(t, logsURL, tracesURL, metricsURL)
	after, err := restartedClient.GetOccurrence(t.Context(), oas.GetOccurrenceParams{Ref: reference})
	require.NoError(t, err)
	afterRaw, err := after.Response.MarshalJSON()
	require.NoError(t, err)
	require.JSONEq(t, string(raw), string(afterRaw))
	// The locator is never an authorization credential.
	_, err = restartedClient.SearchOccurrences(t.Context(), search)
	require.NoError(t, err)
	request, err := http.NewRequestWithContext(
		t.Context(), http.MethodGet, restarted.URL+"/api/v1/occurrences/"+reference, http.NoBody,
	)
	require.NoError(t, err)
	response, err := http.DefaultClient.Do(request)
	require.NoError(t, err)

	defer response.Body.Close()
	require.Equal(t, http.StatusUnauthorized, response.StatusCode)
	_, err = io.Copy(io.Discard, response.Body)
	require.NoError(t, err)
	traceResponse, err := restartedClient.GetTrace(
		t.Context(), oas.GetTraceParams{TraceId: "4bf92f3577b34da6a3ce929d0e0e4736"},
	)
	require.NoError(t, err)
	require.Equal(t, oas.TraceResponse2StatusNotFound, traceResponse.Response.TraceResponse2.Status)
}
