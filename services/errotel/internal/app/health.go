package app

import (
	"context"
	"net/http"

	"github.com/gopherex/xprobe"
	httpprobe "github.com/gopherex/xprobe/pkg/transport/http"
)

// LogsReadiness exercises the configured read route and credentials without loading application payloads.
// The epoch interval and projected time field make it independent of retention and data availability.
func (a *App) LogsReadiness(ctx context.Context) error {
	_, partial, err := a.logs(ctx, "* | fields "+quote(a.cfg.Fields["time"])+" | limit 1",
		Range{Start: "0", End: "1"}, 1)
	if err != nil {
		return err
	}

	if partial {
		return &upstreamError{"upstream_partial", http.StatusServiceUnavailable}
	}

	return nil
}

func (a *App) Management(live *xprobe.Bool, metrics http.Handler) http.Handler {
	ready := xprobe.All(live, xprobe.FromError(a.LogsReadiness))
	opts := []xprobe.HTTPOption{httpprobe.AsJSON(), httpprobe.WithTimeout(a.cfg.Service.HTTP.ProbeTimeout)}

	router := xprobe.Mux(xprobe.Liveness(live, opts...), xprobe.Readiness(ready, opts...))
	if metrics != nil {
		router.Handle("/metrics", metrics)
	}

	return router
}
