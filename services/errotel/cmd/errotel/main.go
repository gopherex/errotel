package main

import (
	"context"
	"errors"
	"flag"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/gopherex/xlog"
	"github.com/gopherex/xprobe"
	"github.com/gopherex/xshutdown"

	"github.com/gopherex/errotel/services/errotel/internal/app"
)

const (
	shutdownTimeout = 10 * time.Second
	headerTimeout   = 5 * time.Second
)

func run() int {
	path := flag.String("config", "", "external YAML/JSON/TOML config file")
	flag.Parse()

	logger := xlog.NewJSON()
	defer func() { _ = logger.Sync() }()

	cfg, e := app.LoadConfig(*path)
	if e != nil {
		logger.Error("cannot load configuration")

		return 1
	}

	application, e := app.New(&cfg, logger)
	if e != nil {
		logger.Error("invalid server configuration")

		return 1
	}

	defer application.Close()

	ready := xprobe.NewBool()
	ready.Set(true)

	router := chi.NewRouter()
	router.Mount("/healthz", http.StripPrefix("", xprobe.Mux(xprobe.Liveness(ready), xprobe.Readiness(ready))))
	router.Mount("/", application.Handler())

	listener, e := (&net.ListenConfig{}).Listen(context.Background(), "tcp", cfg.Listen)
	if e != nil {
		logger.Error("cannot listen")

		return 1
	}

	stop := xshutdown.New(context.Background(), xshutdown.WithTimeout(shutdownTimeout))
	server := &http.Server{Handler: router, ReadHeaderTimeout: headerTimeout, IdleTimeout: time.Minute}

	stop.Register(func() { ready.Set(false) })
	stop.RegisterFnErr(func(ctx context.Context) error { return server.Shutdown(ctx) })
	// Serve is not a tracked drain task: Shutdown must close its listener first.
	go func() {
		if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			logger.Error("HTTP server stopped")

			_ = stop.Stop()
		}
	}()
	logger.Info("errotel listening", xlog.String("address", listener.Addr().String()))

	if e = stop.Run(); e != nil {
		logger.Error("shutdown failed")

		return 1
	}

	return 0
}
func main() { os.Exit(run()) }
