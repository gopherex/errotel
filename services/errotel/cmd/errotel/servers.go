package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/gopherex/xlog"
	"github.com/gopherex/xprobe"
	"github.com/gopherex/xshutdown"

	"github.com/gopherex/errotel/services/errotel/internal/app"
)

type listenerServer struct {
	server   *http.Server
	listener net.Listener
}

func runServers(cfg *app.Config, application *app.App, metrics http.Handler, logger *xlog.Logger) error {
	live := xprobe.NewBool()

	servers, err := bindServers(cfg, application, live, metrics)
	if err != nil {
		return err
	}

	stop := xshutdown.New(context.Background(), xshutdown.WithTimeout(cfg.Service.HTTP.ShutdownTimeout))
	stop.Register(func() { live.Set(false) })

	for _, bound := range servers {
		stop.RegisterFnErr(func(ctx context.Context) error {
			if err := bound.server.Shutdown(ctx); err != nil {
				_ = bound.server.Close()

				return stageError("HTTP drain timeout")
			}

			return nil
		})
	}

	signals, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	failures := make(chan error, len(servers))

	live.Set(true)

	for _, bound := range servers {
		go func() {
			if err := bound.server.Serve(bound.listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
				failures <- stageError("HTTP serve")
			}
		}()
		logger.Info("listening", xlog.String("address", bound.listener.Addr().String()))
	}
	select {
	case <-signals.Done():
	case err = <-failures:
	}
	logger.Info("draining HTTP requests")

	return errors.Join(err, stop.Stop())
}

func bindServers(
	cfg *app.Config, application *app.App, live *xprobe.Bool, metrics http.Handler,
) ([]listenerServer, error) {
	management := application.Management(live, metrics)
	main := application.Handler()

	probeAddr := cfg.Service.HTTP.ProbeAddr
	managementRoute := http.NotFoundHandler()

	if probeAddr == "" || probeAddr == cfg.Listen {
		managementRoute = management
	}

	router := http.NewServeMux()
	router.Handle("/healthz/", managementRoute)
	router.Handle("/metrics", managementRoute)
	router.Handle("/", main)

	bound, err := bind(cfg, cfg.Listen, router)
	if err != nil {
		return nil, err
	}

	servers := []listenerServer{bound}

	if probeAddr != "" && probeAddr != cfg.Listen {
		probe, err := bind(cfg, probeAddr, management)
		if err != nil {
			_ = bound.listener.Close()

			return nil, err
		}

		servers = append(servers, probe)
	}

	return servers, nil
}

func bind(cfg *app.Config, address string, handler http.Handler) (listenerServer, error) {
	listener, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", address)
	if err != nil {
		return listenerServer{}, stageError("listen")
	}

	const headerTimeout = 5 * time.Second
	server := &http.Server{
		Handler: handler, ReadHeaderTimeout: headerTimeout, IdleTimeout: time.Minute,
		ReadTimeout: cfg.Service.HTTP.ReadTimeout, WriteTimeout: cfg.Service.HTTP.WriteTimeout,
	}

	return listenerServer{server, listener}, nil
}
