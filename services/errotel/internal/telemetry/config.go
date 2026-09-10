// Package telemetry owns the read service's observability, separate from browser telemetry.
package telemetry

import (
	"errors"
	"os"
	"strings"
	"time"

	"github.com/gopherex/xlog"
)

type Config struct {
	HTTP struct {
		ProbeAddr       string        `default:"127.0.0.1:8081" mapstructure:"probe_addr"`
		ProbeTimeout    time.Duration `default:"2s"             mapstructure:"probe_timeout"`
		MetricsEnabled  bool          `default:"true"           mapstructure:"metrics_enabled"`
		ReadTimeout     time.Duration `default:"15s"            mapstructure:"read_timeout"`
		WriteTimeout    time.Duration `default:"30s"            mapstructure:"write_timeout"`
		ShutdownTimeout time.Duration `default:"15s"            mapstructure:"shutdown_timeout"`
	} `mapstructure:"http"`
	Logger struct {
		Level  string `default:"info" mapstructure:"level"`
		Format string `default:"json" mapstructure:"format"`
	} `mapstructure:"logger"`
}

func (cfg *Config) Validate() error {
	_, err := xlog.ParseLevel(cfg.Logger.Level)
	if err != nil || (cfg.Logger.Format != "json" && cfg.Logger.Format != "text") ||
		cfg.HTTP.ProbeTimeout <= 0 || cfg.HTTP.ReadTimeout <= 0 || cfg.HTTP.WriteTimeout <= 0 ||
		cfg.HTTP.ShutdownTimeout <= 0 {
		return errors.New("invalid service logger or HTTP configuration") //nolint:err113 // Startup-only diagnostic.
	}

	return validateExporters()
}

// The binary deliberately uses HTTP protobuf exporters; reject a silently ignored gRPC selection.
func validateExporters() error {
	for _, signal := range []string{"TRACES", "METRICS", "LOGS"} {
		exporter := os.Getenv("OTEL_" + signal + "_EXPORTER")
		if exporter != "" && exporter != "none" && exporter != "otlp" {
			return errors.New("unsupported telemetry exporter") //nolint:err113 // Startup-only diagnostic.
		}

		if !configured(signal) || strings.EqualFold(os.Getenv("OTEL_SDK_DISABLED"), "true") {
			continue
		}

		protocol := os.Getenv("OTEL_EXPORTER_OTLP_" + signal + "_PROTOCOL")
		if protocol == "" {
			protocol = os.Getenv("OTEL_EXPORTER_OTLP_PROTOCOL")
		}

		if protocol != "" && protocol != "http/protobuf" {
			return errors.New("only OTLP HTTP protobuf is supported") //nolint:err113 // Startup-only diagnostic.
		}
	}

	return nil
}
