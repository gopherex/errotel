package telemetry

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/contrib/instrumentation/host"
	"go.opentelemetry.io/contrib/instrumentation/runtime"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	logexport "go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	metricexport "go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	traceexport "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	otelprom "go.opentelemetry.io/otel/exporters/prometheus"
	logglobal "go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/gopherex/errotel/services/errotel/internal/build"
)

type Providers struct {
	Metrics http.Handler
	stops   []func(context.Context) error
}

func (providers *Providers) Shutdown(ctx context.Context) error {
	var result error
	for _, stop := range providers.stops {
		result = errors.Join(result, stop(ctx))
	}

	return result
}

func configured(signal string) bool {
	return !strings.EqualFold(os.Getenv("OTEL_SDK_DISABLED"), "true") &&
		os.Getenv("OTEL_"+signal+"_EXPORTER") != "none" &&
		(os.Getenv("OTEL_EXPORTER_OTLP_"+signal+"_ENDPOINT") != "" || os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "")
}

// Setup is called once by the executable, before constructing the application.
func Setup(ctx context.Context, cfg *Config) (*Providers, error) {
	providers := &Providers{}

	res, err := resource.New(ctx, resource.WithFromEnv(), resource.WithHost(), resource.WithTelemetrySDK(),
		resource.WithAttributes(attribute.String("service.name", build.ServiceName),
			attribute.String("service.version", build.Version), attribute.String("service.instance.id", build.InstanceID),
			attribute.String("vcs.ref.head.revision", build.Commit)))
	if err != nil {
		return nil, fmt.Errorf("telemetry resource: %w", err)
	}
	// No baggage is copied from untrusted HTTP clients to the configured VM services.
	otel.SetTextMapPropagator(propagation.TraceContext{})

	if err = providers.setupSignals(ctx, cfg, res); err != nil {
		_ = providers.Shutdown(ctx)

		return nil, err
	}

	if err = errors.Join(host.Start(), runtime.Start()); err != nil {
		_ = providers.Shutdown(ctx)

		return nil, fmt.Errorf("runtime instrumentation: %w", err)
	}

	return providers, nil
}

func (providers *Providers) setupSignals(ctx context.Context, cfg *Config, res *resource.Resource) error {
	if err := providers.setupTraces(ctx, res); err != nil {
		return err
	}

	if err := providers.setupMetrics(ctx, cfg, res); err != nil {
		return err
	}

	return providers.setupLogs(ctx, res)
}

func (providers *Providers) setupTraces(ctx context.Context, res *resource.Resource) error {
	opts := []sdktrace.TracerProviderOption{sdktrace.WithResource(res)}

	if configured("TRACES") {
		exporter, err := traceexport.New(ctx)
		if err != nil {
			return fmt.Errorf("trace exporter: %w", err)
		}

		opts = append(opts, sdktrace.WithBatcher(exporter))
	} else {
		opts = append(opts, sdktrace.WithSampler(sdktrace.NeverSample()))
	}

	provider := sdktrace.NewTracerProvider(opts...)
	otel.SetTracerProvider(provider)
	providers.stops = append(providers.stops, provider.Shutdown)

	return nil
}

func (providers *Providers) setupMetrics(ctx context.Context, cfg *Config, res *resource.Resource) error {
	opts := []sdkmetric.Option{sdkmetric.WithResource(res)}

	if cfg.HTTP.MetricsEnabled && !strings.EqualFold(os.Getenv("OTEL_SDK_DISABLED"), "true") {
		registry := prometheus.NewRegistry()

		exporter, err := otelprom.New(otelprom.WithRegisterer(registry))
		if err != nil {
			return fmt.Errorf("prometheus exporter: %w", err)
		}

		opts = append(opts, sdkmetric.WithReader(exporter))
		providers.Metrics = promhttp.HandlerFor(registry, promhttp.HandlerOpts{})
	}

	if configured("METRICS") {
		exporter, err := metricexport.New(ctx)
		if err != nil {
			return fmt.Errorf("metric exporter: %w", err)
		}

		opts = append(opts, sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter)))
	}

	provider := sdkmetric.NewMeterProvider(opts...)
	otel.SetMeterProvider(provider)
	providers.stops = append(providers.stops, provider.Shutdown)

	return nil
}

func (providers *Providers) setupLogs(ctx context.Context, res *resource.Resource) error {
	opts := []sdklog.LoggerProviderOption{sdklog.WithResource(res)}

	if configured("LOGS") {
		exporter, err := logexport.New(ctx)
		if err != nil {
			return fmt.Errorf("log exporter: %w", err)
		}

		opts = append(opts, sdklog.WithProcessor(sdklog.NewBatchProcessor(exporter)))
	}

	provider := sdklog.NewLoggerProvider(opts...)
	logglobal.SetLoggerProvider(provider)
	providers.stops = append(providers.stops, provider.Shutdown)

	return nil
}
