package app

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/gopherex/errotel/services/errotel/internal/discovery"
)

func TestFacetAuthPaginationMappingAndFailures(t *testing.T) {
	t.Setenv("APP_DEBUG_API_TOKEN", "facet-test")

	var calls atomic.Int32

	var partial, failure atomic.Bool

	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		assert.NoError(t, r.ParseForm())
		query := r.FormValue("query")
		assert.Contains(t, query, `stats by ("custom.service")`)
		assert.Contains(t, query, `count_uniq("app.debug.event.id")`)
		assert.NotContains(t, query, "pack_json")

		if failure.Load() {
			writer.WriteHeader(http.StatusBadGateway)

			return
		}

		if partial.Load() {
			writer.Header().Set("X-Partial-Response", "true")
		}

		_, _ = writer.Write([]byte("{\"custom.service\":\"a\",\"errors\":\"2\",\"last_seen\":\"2026-09-10T00:00:00Z\"}\n" +
			"{\"custom.service\":\"b\",\"errors\":\"1\",\"last_seen\":\"2026-09-10T00:00:00Z\"}"))
	}))
	defer upstream.Close()

	cfg, err := LoadConfig("")
	require.NoError(t, err)

	cfg.Fields = map[string]string{"service": "custom.service"}
	cfg.Logs.BaseURL = upstream.URL
	application, err := New(&cfg, nil)
	require.NoError(t, err)

	defer application.Close()

	body := map[string]any{"field": "service", "range": Range{"1788998400000000000", "1788998460000000000"}, "pageSize": 1}
	send := func(token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/facets", bytes.NewReader(canonical(body)))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		application.Handler().ServeHTTP(w, r)

		return w
	}
	first := send("facet-test")
	require.Equal(t, http.StatusOK, first.Code, first.Body.String())

	var result facetResponse

	require.NoError(t, json.Unmarshal(first.Body.Bytes(), &result))
	require.Equal(t, "a", result.Items[0].Value)
	require.NotEmpty(t, result.NextCursor)
	require.Equal(t, "hit", send("facet-test").Header().Get("X-Errotel-Cache"))
	require.Equal(t, http.StatusUnauthorized, send("wrong").Code)
	require.EqualValues(t, 1, calls.Load())

	body["cursor"] = result.NextCursor
	second := send("facet-test")
	require.Equal(t, http.StatusOK, second.Code)
	require.NoError(t, json.Unmarshal(second.Body.Bytes(), &result))
	require.Equal(t, "b", result.Items[0].Value)

	body["prefix"] = "changed"

	require.Equal(t, http.StatusBadRequest, send("facet-test").Code)
	delete(body, "prefix")
	delete(body, "cursor")

	application.cache = newCache(0, 0)

	partial.Store(true)

	response := send("facet-test")
	require.Contains(t, response.Body.String(), `"queryStatus":"partial"`)
	require.Equal(t, "miss", send("facet-test").Header().Get("X-Errotel-Cache"))
	failure.Store(true)
	require.Equal(t, http.StatusBadGateway, send("facet-test").Code)
	failure.Store(false)
	partial.Store(false)
	require.Equal(t, http.StatusOK, send("facet-test").Code)
}

func TestPublicDiscoveryMatchesBuildWithoutUpstreamOrToken(t *testing.T) {
	t.Setenv("APP_DEBUG_API_TOKEN", "private-test-token")

	cfg, err := LoadConfig("")
	require.NoError(t, err)

	cfg.Source = "private-source"
	cfg.Logs.BaseURL = "http://127.0.0.1:1"
	application, err := New(&cfg, nil)
	require.NoError(t, err)

	defer application.Close()

	for path, expected := range map[string][]byte{"/openapi.json": discovery.OpenAPI, "/agent.md": discovery.Guide} {
		response := httptest.NewRecorder()
		application.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, http.NoBody))
		require.Equal(t, http.StatusOK, response.Code)
		require.Equal(t, expected, response.Body.Bytes())
		require.NotContains(t, response.Body.String(), "private-test-token")
		require.NotContains(t, response.Body.String(), "private-source")
	}
}

func TestFacetValidationAndLiteralEscaping(t *testing.T) {
	t.Parallel()

	application := &App{}
	application.cfg.Queries.MaxRange = time.Hour
	application.cfg.Queries.MaxPageSize = 1
	application.cfg.Fields = map[string]string{"service": "custom.service", "time": "_time"}
	value := `" OR * | limit 100`
	req := facetRequest{Field: "service", Range: Range{"1000000000000000000", "1000000001000000000"}, Prefix: value}
	_, err := application.normalizeFacet(&req)
	require.NoError(t, err)

	require.Equal(t, 1, req.PageSize, "omitted page size respects deployment limit")

	query := application.facetQuery(&req, 2)
	assert.Contains(t, query, `"custom.service":`)
	assert.NotContains(t, query, `:=`+value)

	for _, field := range []string{"_msg", "traceId", "__proto__", "service | limit 1"} {
		req.Field = field
		_, err := application.normalizeFacet(&req)
		require.Error(t, err)
	}

	req.Field = "service"
	req.Cursor = strings.Repeat("x", 100000)
	_, err = application.normalizeFacet(&req)
	require.Error(t, err)
}
