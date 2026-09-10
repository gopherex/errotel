package app

import (
	"crypto/sha256"
	"encoding/json"
	"net"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/gopherex/xlog"

	"github.com/gopherex/errotel/services/errotel/internal/envelope"
	"github.com/gopherex/errotel/services/errotel/internal/oas"
)

type App struct {
	api                        *oas.Server
	cfg                        Config
	revision                   string
	logsHeaders, tracesHeaders http.Header
	http                       *http.Client
	schema                     *jsonschema.Schema
	cache                      *memoryCache
	auth                       *authGate
	slots                      chan struct{}
	logger                     *xlog.Logger
}

func New(cfg *Config, logger *xlog.Logger) (*App, error) {
	prepared, err := prepare(cfg)
	if err != nil {
		return nil, err
	}

	schema, err := envelope.New()
	if err != nil {
		return nil, err
	}

	transport := &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		DialContext:         (&net.Dialer{Timeout: cfg.Queries.Timeout}).DialContext,
		TLSHandshakeTimeout: cfg.Queries.Timeout, ResponseHeaderTimeout: cfg.Queries.Timeout,
	}
	transport.MaxIdleConnsPerHost = cfg.Queries.Concurrency

	application := &App{
		cfg: *cfg, revision: prepared.revision,
		logsHeaders: prepared.logsHeaders, tracesHeaders: prepared.tracesHeaders,
		http: &http.Client{
			Transport: transport,
			CheckRedirect: func(*http.Request,
				[]*http.Request,
			) error {
				return http.ErrUseLastResponse
			},
		},
		schema: schema,
		cache: newCache(cfg.Cache.MaxBytes,
			cfg.Cache.MaxEntryBytes),
		auth: &authGate{
			secret:  sha256.Sum256([]byte(prepared.token)),
			peers:   map[string]peerBucket{},
			burst:   cfg.Auth.Burst,
			rate:    cfg.Auth.PerMinute,
			max:     cfg.Auth.MaxPeers,
			proxies: prepared.proxies,
		},
		slots: make(chan struct{}, cfg.Queries.Concurrency), logger: logger,
	}
	if err := application.initAPI(); err != nil {
		return nil, err
	}

	return application, nil
}
func (a *App) Close() { a.http.CloseIdleConnections() }
func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)

	if err := json.NewEncoder(writer).Encode(value); err != nil {
		return
	}
}

func apiError(writer http.ResponseWriter, status int, code string) {
	writeJSON(writer, status, map[string]string{"code": code, "message": strings.ReplaceAll(code, "_", " ")})
}

func (a *App) Handler() http.Handler {
	request := chi.NewRouter()
	request.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			writer.Header().Set("X-Content-Type-Options", "nosniff")
			writer.Header().Set("Referrer-Policy", "no-referrer")
			writer.Header().Set("X-Request-Id", uuid.NewString())

			defer func() {
				if recover() != nil {
					apiError(writer, http.StatusInternalServerError, "internal_error")
				}
			}()
			next.ServeHTTP(writer, request)
		})
	})
	request.Route("/api", func(request chi.Router) {
		request.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				writer.Header().Set("Cache-Control", "no-store")
				next.ServeHTTP(writer, request)
			})
		})
		request.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				request.Body = http.MaxBytesReader(writer, request.Body, maxRequestBytes)
				next.ServeHTTP(writer, request)
			})
		})
		request.Use(a.auth.middleware)
		request.Mount("/", a.api)
	})
	request.Get("/openapi.json", a.apiDescription)
	request.Get("/agent.md", a.agentGuide)
	request.Get("/*", a.staticHandler)

	return request
}
