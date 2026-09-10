package app

import (
	"context"
	"net/http"
	"strconv"
	"time"
)

const (
	histogramTargetBuckets = 120
	histogramEdgeBuckets   = 2
)

func histogramInterval(span int64) int64 {
	steps := []time.Duration{
		time.Millisecond, 10 * time.Millisecond, 100 * time.Millisecond,
		time.Second, 5 * time.Second, 10 * time.Second, 30 * time.Second,
		time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour, 6 * time.Hour, 24 * time.Hour,
	}
	for _, step := range steps {
		if span/int64(step) <= histogramTargetBuckets {
			return int64(step)
		}
	}

	return (span/histogramTargetBuckets/int64(time.Millisecond) + 1) * int64(time.Millisecond)
}

func (a *App) histogramQuery(search *Search, origin string, step int64) string {
	query := a.matchingQuery(search, origin)
	if origin == originSDK {
		query += " | fields " + a.field("time") + ", " + a.field("eventId") +
			" | last 1 by (" + a.field("time") + ") partition by (" + a.field("eventId") + ")"
	}

	return query + " | stats by (" + a.field("time") + ":" + time.Duration(step).String() + ") count() as hits"
}

func (a *App) loadHistogram(ctx context.Context, search *Search) (HistogramResponse, error) {
	start, _ := parseNano(search.Range.Start)
	end, _ := parseNano(search.Range.End)
	step := histogramInterval(end - start)
	response := HistogramResponse{
		Range: search.Range, IntervalMS: step / int64(time.Millisecond), Buckets: []HistogramBucket{},
		Meta: Meta{
			QueryStatus: "complete", ServedFrom: "upstream",
			FetchedAt: time.Now().UTC().Format(time.RFC3339Nano), Warnings: []string{},
		},
	}
	counts := make(map[int64]int64)

	for _, origin := range []string{originSDK, originOTel} {
		if search.Origin != originBoth && search.Origin != origin {
			continue
		}

		query := a.histogramQuery(search, origin, step)

		rows, partial, err := a.logs(ctx, query, search.Range, histogramTargetBuckets+histogramEdgeBuckets)
		if err != nil {
			return response, err
		}

		if err := a.collectBuckets(rows, counts, step, start, end); err != nil {
			return response, err
		}

		if partial {
			response.Meta.QueryStatus = statusPartial
			response.Meta.Warnings = append(response.Meta.Warnings, "upstream_partial")
		}
	}

	for stamp := start / step * step; stamp < end; {
		bucketEnd := end
		if step < end-stamp {
			bucketEnd = stamp + step
		}

		count := counts[stamp]
		response.Total += count
		response.Buckets = append(response.Buckets, HistogramBucket{
			Start: strconv.FormatInt(max(stamp, start), decimalBase),
			End:   strconv.FormatInt(bucketEnd, decimalBase), Count: count,
		})
		stamp = bucketEnd
	}

	return response, nil
}

func (a *App) collectBuckets(rows []row, counts map[int64]int64, step, start, end int64) error {
	for _, record := range rows {
		stamp, err := rowTime(record, a.cfg.Fields["time"])
		if err != nil {
			return &upstreamError{"invalid_histogram_bucket", http.StatusBadGateway}
		}

		value, _ := parseNano(stamp)
		count, err := strconv.ParseInt(record["hits"], decimalBase, 64)

		if err != nil || count < 0 || value%step != 0 || value < start/step*step || value >= end {
			return &upstreamError{"invalid_histogram_bucket", http.StatusBadGateway}
		}

		counts[value] += count
	}

	return nil
}
