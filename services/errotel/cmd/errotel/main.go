package main

import (
	"context"
	"encoding/json"
	"flag"
	"os"
	"time"

	"github.com/gopherex/xlog"

	"github.com/gopherex/errotel/services/errotel/internal/app"
	"github.com/gopherex/errotel/services/errotel/internal/build"
	"github.com/gopherex/errotel/services/errotel/internal/telemetry"
)

func run() int {
	path := flag.String("config", "", "external YAML/JSON/TOML configuration")
	version := flag.Bool("version", false, "print build metadata as JSON and exit")
	flag.Parse()

	if *version {
		if err := json.NewEncoder(os.Stdout).Encode(map[string]string{
			"service": build.ServiceName, "version": build.Version, "commit": build.Commit, "buildTime": build.BuildTime,
		}); err != nil {
			return 1
		}

		return 0
	}

	bootstrap := xlog.NewJSON()
	cfg, err := app.LoadConfig(*path)

	if err != nil || cfg.Service.Validate() != nil {
		bootstrap.Error("invalid server configuration")

		return 1
	}

	if err = serve(&cfg); err != nil {
		// Raw exporter/config errors may contain credentials: return only a fixed stage name.
		bootstrap.Error("service stopped with an error", xlog.String("stage", err.Error()))

		return 1
	}

	return 0
}

func serve(cfg *app.Config) error {
	if err := telemetry.InstallErrorHandler(); err != nil {
		return stageError("telemetry diagnostics")
	}

	providers, err := telemetry.Setup(context.Background(), &cfg.Service)
	if err != nil {
		return stageError("telemetry setup")
	}

	defer shutdownTelemetry(providers, cfg.Service.HTTP.ShutdownTimeout)

	logger, err := telemetry.NewLogger(&cfg.Service)
	if err != nil {
		return stageError("logger setup")
	}

	defer func() { _ = logger.Sync() }()

	application, err := app.New(cfg, logger)
	if err != nil {
		return stageError("application configuration")
	}

	defer application.Close()

	return runServers(cfg, application, providers.Metrics, logger)
}

type stageError string

func (err stageError) Error() string { return string(err) }

func shutdownTelemetry(providers *telemetry.Providers, timeout time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	if err := providers.Shutdown(ctx); err != nil {
		xlog.NewJSON().Warn("telemetry shutdown failed; queued service telemetry may be lost")
	}
}
func main() { os.Exit(run()) }
