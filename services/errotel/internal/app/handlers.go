package app

import (
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gopherex/errotel/services/errotel/internal/discovery"
)

func (a *App) staticHandler(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Link", `<openapi.json>; rel="service-desc"; type="application/json", `+
		`<agent.md>; rel="describedby"; type="text/markdown"`)
	// URLs embedded in telemetry are never fetched or used here.
	writer.Header().Set("Content-Security-Policy",
		"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "+
			"img-src 'self' data:; connect-src 'self' "+strings.Join(a.cfg.UIConnectOrigins, " ")+
			"; frame-ancestors 'none'; object-src 'none'; base-uri 'self'")

	clean := filepath.Clean("/" + request.URL.Path)

	path := filepath.Join(a.cfg.UIDir, clean)
	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		http.ServeFile(writer, request, path)

		return
	}

	if strings.HasPrefix(clean, "/assets/") {
		http.NotFound(writer, request)

		return
	}

	http.ServeFile(writer, request, filepath.Join(a.cfg.UIDir, "index.html"))
}

func (a *App) apiDescription(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, "openapi.json", time.Time{}, bytes.NewReader(discovery.OpenAPI))
}

func (a *App) agentGuide(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, "agent.md", time.Time{}, bytes.NewReader(discovery.Guide))
}
