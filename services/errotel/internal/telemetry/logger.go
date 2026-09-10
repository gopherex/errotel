package telemetry

import (
	"context"
	"fmt"
	"sync/atomic"

	"go.opentelemetry.io/otel"
	logglobal "go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/metric"

	"github.com/gopherex/xlog"
	xlogtrace "github.com/gopherex/xtrace/contrib/libs/xlog"

	"github.com/gopherex/errotel/services/errotel/internal/build"
)

func NewLogger(cfg *Config) (*xlog.Logger, error) {
	level, err := xlog.ParseLevel(cfg.Logger.Level)
	if err != nil {
		return nil, fmt.Errorf("logger level: %w", err)
	}

	const loggerOptionCount = 4
	opts := make([]xlog.Option, 0, loggerOptionCount)
	opts = append(opts, xlog.WithLevel(level))
	base := xlog.NewJSON(opts...)

	if cfg.Logger.Format == "text" {
		base = xlog.NewConsole(opts...)
	}

	core := xlog.NewFilterCore(xlogtrace.Core(logglobal.GetLoggerProvider().Logger(build.ServiceName)),
		xlog.NewAtomicLevel(level))
	opts = append(opts, xlog.WithCore(xlog.NewTeeCore(base.Core(), core)))
	opts = append(opts, xlogtrace.Options(xlog.ErrorLevel)...)
	logger := xlog.NewJSON(opts...).With(
		xlog.String("service", build.ServiceName), xlog.String("version", build.Version),
		xlog.String("commit", build.Commit), xlog.String("build_time", build.BuildTime),
		xlog.String("instance_id", build.InstanceID))

	return logger, nil
}

// Error diagnostics bypass the OTLP logger: reporting exporter failures must not recurse or expose URLs/headers.
func InstallErrorHandler() error {
	counter, err := otel.Meter(build.ServiceName).Int64Counter("errotel.telemetry.errors",
		metric.WithDescription("OpenTelemetry SDK/exporter errors"))
	if err != nil {
		return fmt.Errorf("telemetry error counter: %w", err)
	}

	logger := xlog.NewJSON()
	count := &atomic.Uint64{}

	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(_ error) {
		counter.Add(context.Background(), 1)

		if count.Add(1) == 1 {
			logger.Warn("telemetry export or SDK error; check collector configuration and errotel_telemetry_errors_total")
		}
	}))

	return nil
}
