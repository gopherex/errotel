package telemetry

import (
	"context"
	"errors"
	"fmt"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

type Observer struct {
	HTTPDuration     metric.Float64Histogram
	HTTPActive       metric.Int64UpDownCounter
	Cache            metric.Int64Counter
	UpstreamDuration metric.Float64Histogram
	tracer           trace.Tracer
}

func NewObserver() (*Observer, error) {
	meter := otel.Meter("errotel")
	// HTTP latency is measured in seconds; generic OTel buckets start at five seconds.
	//nolint:mnd // Standard HTTP latency boundaries, from milliseconds through upstream timeouts.
	latencyBuckets := metric.WithExplicitBucketBoundaries(.005, .01, .025, .05, .075, .1, .25, .5, .75, 1, 2.5, 5, 10)
	duration, first := meter.Float64Histogram("http.server.request.duration", metric.WithUnit("s"), latencyBuckets)
	active, second := meter.Int64UpDownCounter("http.server.active_requests")
	cache, third := meter.Int64Counter("errotel.cache.requests")
	upstream, fourth := meter.Float64Histogram("errotel.upstream.request.duration", metric.WithUnit("s"), latencyBuckets)

	if err := errors.Join(first, second, third, fourth); err != nil {
		return nil, fmt.Errorf("service instruments: %w", err)
	}

	return &Observer{duration, active, cache, upstream, otel.Tracer("errotel")}, nil
}

// Upstream records only a fixed adapter name and bounded outcome; never URLs or queries.
//
//nolint:gocritic // The returned callback completes one adapter request.
func (observer *Observer) Upstream(ctx context.Context, name string) (context.Context, func(string)) {
	started := time.Now()
	ctx, span := observer.tracer.Start(ctx, name, trace.WithSpanKind(trace.SpanKindClient))

	return ctx, func(outcome string) {
		defer span.End()

		attrs := []attribute.KeyValue{attribute.String("upstream", name), attribute.String("outcome", outcome)}
		span.SetAttributes(attrs...)

		if outcome != "complete" && outcome != "available" && outcome != "not_found" && outcome != "not_configured" {
			span.SetStatus(codes.Error, outcome)
		}

		observer.UpstreamDuration.Record(ctx, time.Since(started).Seconds(), metric.WithAttributes(attrs...))
	}
}
