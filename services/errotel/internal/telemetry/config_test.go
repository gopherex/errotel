package telemetry_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/gopherex/errotel/services/errotel/internal/app"
)

func TestServiceConfiguration(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318")
	t.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf")
	t.Setenv("ERROTEL_SERVICE_LOGGER_LEVEL", "warn")
	t.Setenv("ERROTEL_SERVICE_LOGGER_FORMAT", "text")
	t.Setenv("ERROTEL_SERVICE_HTTP_METRICS_ENABLED", "false")
	t.Setenv("ERROTEL_SERVICE_HTTP_PROBE_ADDR", "127.0.0.1:9999")

	cfg, err := app.LoadConfig("")
	require.NoError(t, err)
	require.NoError(t, cfg.Service.Validate())
	require.Equal(t, "warn", cfg.Service.Logger.Level)
	require.Equal(t, "text", cfg.Service.Logger.Format)
	require.False(t, cfg.Service.HTTP.MetricsEnabled)
	require.Equal(t, "127.0.0.1:9999", cfg.Service.HTTP.ProbeAddr)
	t.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc")
	require.Error(t, cfg.Service.Validate())

	for _, signal := range []string{"TRACES", "LOGS", "METRICS"} {
		t.Setenv("OTEL_EXPORTER_OTLP_"+signal+"_PROTOCOL", "http/protobuf")
	}

	require.NoError(t, cfg.Service.Validate())
	t.Setenv("OTEL_TRACES_EXPORTER", "arbitrary")
	require.Error(t, cfg.Service.Validate())
	t.Setenv("OTEL_TRACES_EXPORTER", "none")
	require.NoError(t, cfg.Service.Validate())
	cfg.Service.Logger.Format = "unrecognized"
	require.Error(t, cfg.Service.Validate())
	cfg.Service.Logger.Format = "json"
	cfg.Service.HTTP.ProbeTimeout = 0
	require.Error(t, cfg.Service.Validate())
}
