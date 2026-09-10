package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/gopherex/xconf/pkg/structconf"
)

type Endpoint struct {
	BaseURL    string `mapstructure:"base_url"`
	HeadersEnv string `mapstructure:"headers_env"`
}
type Config struct {
	UIConnectOrigins []string          `mapstructure:"ui_connect_origins"`
	Listen           string            `default:"127.0.0.1:8080"          mapstructure:"listen"`
	UIDir            string            `default:"../../app/dist"          mapstructure:"ui_dir"`
	TokenEnv         string            `default:"APP_DEBUG_API_TOKEN"     mapstructure:"token_env"`
	Source           string            `default:"default"                 mapstructure:"source"`
	Logs             Endpoint          `mapstructure:"logs"`
	Traces           Endpoint          `mapstructure:"traces"`
	Metrics          Endpoint          `mapstructure:"metrics"`
	Fields           map[string]string `mapstructure:"fields"`
	TrustedProxies   []string          `mapstructure:"trusted_proxies"`
	Auth             struct {
		Burst     int `default:"5"     mapstructure:"burst"`
		PerMinute int `default:"10"    mapstructure:"per_minute"`
		MaxPeers  int `default:"10000" mapstructure:"max_peers"`
	} `mapstructure:"auth"`
	Cache struct {
		MaxBytes      int           `default:"268435456" mapstructure:"max_bytes"`
		MaxEntryBytes int           `default:"16777216"  mapstructure:"max_entry_bytes"`
		SearchTTL     time.Duration `default:"5s"        mapstructure:"search_ttl"`
		DetailTTL     time.Duration `default:"30s"       mapstructure:"detail_ttl"`
		TraceTTL      time.Duration `default:"5s"        mapstructure:"trace_ttl"`
		NegativeTTL   time.Duration `default:"1s"        mapstructure:"negative_ttl"`
	} `mapstructure:"cache"`
	Queries struct {
		Timeout       time.Duration `default:"5s"     mapstructure:"timeout"`
		MaxPageSize   int           `default:"200"    mapstructure:"max_page_size"`
		MaxRange      time.Duration `default:"168h"   mapstructure:"max_range"`
		MaxOffset     int           `default:"100000" mapstructure:"max_offset"`
		MaxDetailRows int           `default:"1000"   mapstructure:"max_detail_rows"`
		Concurrency   int           `default:"16"     mapstructure:"concurrency"`
	} `mapstructure:"queries"`
}

func LoadConfig(path string) (Config, error) {
	opts := []structconf.Option{structconf.WithEnvPrefix("ERROTEL")}
	if path != "" {
		opts = append(opts, structconf.WithFile(path))
	}

	cfg, err := structconf.Load[Config](opts...)
	if err != nil {
		return Config{}, requestError("cannot load configuration")
	}

	return *cfg, nil
}

const (
	schemeHTTP  = "http"
	schemeHTTPS = "https"
)

func defaultFields() map[string]string {
	return map[string]string{
		"time": "_time", "body": "_msg", "stream": "_stream_id",
		"traceId": "trace_id", "spanId": "span_id", "severityNumber": "severity_number",
		"eventName": "event_name", "service": "service.name",
		"environment": "deployment.environment.name", "release": "service.version",
		"exceptionType": "exception.type", "exceptionMessage": "exception.message",
		"exceptionStack": "exception.stacktrace", "schemaVersion": "app.debug.schema.version",
		"kind": "app.debug.kind", "eventId": "app.debug.event.id", "runtimeId": "app.debug.runtime.id",
		"sequence": "app.debug.event.sequence", "mechanism": "app.debug.exception.mechanism",
		"handled": "app.debug.exception.handled", "groupKey": "app.debug.group.key",
	}
}

var fieldPattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_.-]*$`)

func (cfg *Config) validate() error {
	invalid := cfg.Source == "" || cfg.Logs.BaseURL == "" || cfg.Queries.Timeout <= 0 ||
		cfg.Queries.MaxPageSize < 1 || cfg.Queries.MaxPageSize > maxPageSize ||
		cfg.Queries.MaxRange <= 0 || cfg.Queries.MaxOffset < 0 || cfg.Queries.MaxDetailRows < 2 ||
		cfg.Queries.Concurrency < 1 || cfg.Auth.Burst < 1 || cfg.Auth.PerMinute < 1 ||
		cfg.Auth.MaxPeers < 1 || cfg.Cache.MaxBytes < 0 || cfg.Cache.MaxEntryBytes < 0
	if invalid {
		return requestError("invalid_configuration")
	}

	return validateUIOrigins(cfg.UIConnectOrigins)
}

// Only exact origins may extend connect-src; never accept CSP directives or wildcards.
func validateUIOrigins(origins []string) error {
	for _, origin := range origins {
		parsed, err := url.Parse(origin)
		if err != nil || strings.ContainsAny(origin, " \t\r\n;,'\"<>\\*") {
			return requestError("invalid_ui_connect_origin")
		}

		if (parsed.Scheme != schemeHTTP && parsed.Scheme != schemeHTTPS) || parsed.Hostname() == "" ||
			parsed.User != nil || origin != parsed.Scheme+"://"+parsed.Host {
			return requestError("invalid_ui_connect_origin")
		}
	}

	return nil
}

func (cfg *Config) mapFields() error {
	fields := defaultFields()
	for key, value := range cfg.Fields {
		if _, known := fields[key]; !known || !fieldPattern.MatchString(value) ||
			strings.HasPrefix(value, "__errotel_") {
			return requestError("invalid_field_mapping")
		}

		fields[key] = value
	}

	seen := map[string]bool{}
	for _, value := range fields {
		if seen[value] {
			return requestError("duplicate_field_mapping")
		}

		seen[value] = true
	}

	cfg.Fields = fields

	return nil
}

func endpointHeaders(endpoint Endpoint) (http.Header, error) {
	headers := http.Header{}
	if endpoint.BaseURL == "" {
		return headers, nil
	}

	parsed, err := url.Parse(endpoint.BaseURL)
	if err != nil {
		return nil, requestError("invalid_endpoint")
	}

	if (parsed.Scheme != schemeHTTP && parsed.Scheme != schemeHTTPS) || parsed.Host == "" ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, requestError("invalid_endpoint")
	}

	raw := os.Getenv(endpoint.HeadersEnv)
	if raw == "" {
		return headers, nil
	}

	values := map[string]string{}
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return nil, requestError("invalid_headers")
	}

	for key, value := range values {
		if strings.ContainsAny(key+value, "\r\n") {
			return nil, requestError("invalid_headers")
		}

		headers.Set(key, value)
	}

	return headers, nil
}

type preparedConfig struct {
	token                      string
	logsHeaders, tracesHeaders http.Header
	proxies                    []netip.Prefix
	revision                   string
}

func prepare(cfg *Config) (*preparedConfig, error) {
	fail := func() (*preparedConfig, error) {
		return nil, requestError("invalid_configuration")
	}
	token := os.Getenv(cfg.TokenEnv)

	if token == "" || strings.ContainsAny(token, "\r\n") || cfg.validate() != nil || cfg.mapFields() != nil {
		return fail()
	}

	logsHeaders, err := endpointHeaders(cfg.Logs)
	if err != nil {
		return fail()
	}

	tracesHeaders, err := endpointHeaders(cfg.Traces)
	if err != nil {
		return fail()
	}

	metricsHeaders, err := endpointHeaders(cfg.Metrics)
	if err != nil {
		return fail()
	}

	proxies := make([]netip.Prefix, 0, len(cfg.TrustedProxies))

	for _, configured := range cfg.TrustedProxies {
		prefix, err := netip.ParsePrefix(configured)
		if err != nil {
			return fail()
		}

		proxies = append(proxies, prefix)
	}

	revision := digest(append(canonical(cfg), canonical([]http.Header{logsHeaders, tracesHeaders, metricsHeaders})...))

	return &preparedConfig{token, logsHeaders, tracesHeaders, proxies, revision}, nil
}

func digest(data []byte) string {
	headers := sha256.Sum256(data)

	return hex.EncodeToString(headers[:])
}
