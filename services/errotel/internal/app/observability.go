package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"github.com/gopherex/xlog"
)

func (a *App) observeHTTP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		started := time.Now()

		path := "unmatched"
		if route, found := a.api.FindRoute(request.Method, request.URL.Path); found {
			path = route.PathPattern()
		}

		method := safeMethod(request.Method)

		const attributeCount = 3
		attrs := make([]attribute.KeyValue, 0, attributeCount)
		attrs = append(attrs, attribute.String("http.route", path), attribute.String("http.request.method", method))
		ctx := otel.GetTextMapPropagator().Extract(request.Context(), propagation.HeaderCarrier(request.Header))

		ctx, span := otel.Tracer("errotel").Start(ctx, method+" "+path,
			trace.WithSpanKind(trace.SpanKindServer), trace.WithAttributes(attrs...))
		defer span.End()

		requestID := uuid.NewString()
		writer.Header().Set("X-Request-Id", requestID)
		ctx = xlog.ContextWithFields(ctx, xlog.String("request_id", requestID))
		wrapped := middleware.NewWrapResponseWriter(writer, request.ProtoMajor)

		a.observer.HTTPActive.Add(ctx, 1, metric.WithAttributes(attrs...))

		defer a.observer.HTTPActive.Add(ctx, -1, metric.WithAttributes(attrs...))
		next.ServeHTTP(wrapped, request.WithContext(ctx))

		status := wrapped.Status()
		if status == 0 {
			status = http.StatusOK
		}

		attrs = append(attrs, attribute.Int("http.response.status_code", status))
		span.SetAttributes(attrs...)

		if status >= http.StatusInternalServerError {
			span.SetStatus(codes.Error, "request_failed")
		}

		a.observer.HTTPDuration.Record(ctx, time.Since(started).Seconds(), metric.WithAttributes(attrs...))
		a.logRequest(ctx, path, status, time.Since(started))
	})
}

func (a *App) logRequest(ctx context.Context, route string, status int, elapsed time.Duration) {
	if a.logger == nil {
		return
	}

	level := xlog.DebugLevel
	if status >= http.StatusInternalServerError {
		level = xlog.ErrorLevel
	} else if status >= http.StatusBadRequest {
		level = xlog.WarnLevel
	}

	a.logger.Ctx().Log(ctx, level, "HTTP request", xlog.String("route", route),
		xlog.Int("status", status), xlog.Duration("duration", elapsed))
}

func safeMethod(method string) string {
	switch method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch,
		http.MethodHead, http.MethodOptions, http.MethodConnect, http.MethodTrace:
		return method
	default:
		return "_OTHER"
	}
}

func (a *App) observeCache(ctx context.Context, outcome string) {
	if a.observer != nil {
		a.observer.Cache.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", outcome)))
	}
}

func (a *App) observeCacheSize() error {
	meter := otel.Meter("errotel")
	bytesGauge, first := meter.Int64ObservableGauge("errotel.cache.size", metric.WithUnit("By"))
	entriesGauge, second := meter.Int64ObservableGauge("errotel.cache.entries")

	if err := errors.Join(first, second); err != nil {
		return fmt.Errorf("cache gauges: %w", err)
	}

	registration, err := meter.RegisterCallback(func(_ context.Context, observer metric.Observer) error {
		a.cache.mu.Lock()
		defer a.cache.mu.Unlock()
		observer.ObserveInt64(bytesGauge, int64(a.cache.bytes))
		observer.ObserveInt64(entriesGauge, int64(len(a.cache.entries)))

		return nil
	}, bytesGauge, entriesGauge)
	if err != nil {
		return fmt.Errorf("cache observer: %w", err)
	}

	a.stopObserving = func() { _ = registration.Unregister() }

	return nil
}
