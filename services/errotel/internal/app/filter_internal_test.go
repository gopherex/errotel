package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStructuredFilterValidationAndEscaping(t *testing.T) {
	t.Parallel()

	application := &App{}
	application.cfg.Fields = map[string]string{"service": "resource.service.name", "exceptionMessage": "exception.message"}
	literal := `checkout" OR * | limit 999`
	filter := &SearchFilter{Op: "eq", Field: "service", Value: &literal}
	require.NoError(t, validateSearchFilter(filter))
	require.Equal(t, `"resource.service.name":="checkout\" OR * | limit 999"`, application.filterQuery(filter))
	group := &SearchFilter{Op: "not", Children: []SearchFilter{*filter}}
	require.NoError(t, validateSearchFilter(group))
	require.Contains(t, application.filterQuery(group), "NOT (")

	for _, invalid := range []SearchFilter{
		{Op: "eq", Field: "body", Value: &literal},
		{Op: "exists", Field: "service", Value: &literal},
		{Op: "not", Children: []SearchFilter{*filter, *filter}},
		{Op: "eq", Field: "service"},
		{Op: "raw", Field: "service", Value: &literal},
		{Op: "or", Field: "service", Children: []SearchFilter{*filter}},
	} {
		require.Error(t, validateSearchFilter(&invalid))
	}

	for range 14 {
		group = &SearchFilter{Op: "not", Children: []SearchFilter{*group}}
	}

	require.Error(t, validateSearchFilter(group))
}

func TestHistogramAggregationAndAuthOnCacheHit(t *testing.T) {
	t.Setenv("APP_DEBUG_API_TOKEN", "histogram-test")

	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		assert.NoError(t, request.ParseForm())
		query := request.Form.Get("query")
		assert.Contains(t, query, "partition by")
		assert.Contains(t, query, "stats by")
		assert.NotContains(t, query, " | sort")

		_, _ = writer.Write([]byte("{\"_time\":\"2026-09-10T10:00:00Z\",\"hits\":\"2\"}\n"))
	}))
	defer upstream.Close()

	config, err := LoadConfig("")
	require.NoError(t, err)

	config.Logs.BaseURL = upstream.URL
	application, err := New(&config, nil)
	require.NoError(t, err)

	defer application.Close()
	// Decimal nanoseconds in the public contract, independent of wall clock.
	requestBody := map[string]any{"range": map[string]string{
		"startUnixNano": "1789034400000000000", "endUnixNano": "1789034460000000000",
	}, "origin": "sdk"}
	body := string(canonical(requestBody))
	send := func(token string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/occurrences/histogram", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+token)

		response := httptest.NewRecorder()
		application.Handler().ServeHTTP(response, request)

		return response
	}
	response := send("histogram-test")
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())

	var histogram HistogramResponse

	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &histogram))
	require.EqualValues(t, 2, histogram.Total)
	require.Len(t, histogram.Buckets, 60)
	require.EqualValues(t, 2, histogram.Buckets[0].Count)
	require.Zero(t, histogram.Buckets[1].Count)
	require.Equal(t, "hit", send("histogram-test").Header().Get("X-Errotel-Cache"))
	require.Equal(t, http.StatusUnauthorized, send("wrong").Code)
}

func TestSearchMergePreservesUpstreamNaturalOrder(t *testing.T) {
	t.Parallel()

	application := &App{}
	application.cfg.Fields = map[string]string{"time": "_time", "eventId": "id"}
	rows := []row{
		{"_time": "2026-09-10T10:00:00Z", "id": "169ce792-3ef2-4050-a969-e1f4357a094f"},
		{"_time": "2026-09-10T10:00:00Z", "id": "28fe008e-205e-4275-88a6-e389c4862760"},
		{"_time": "2026-09-10T10:00:01Z", "id": "vanilla"},
	}
	application.order(rows)
	require.Equal(t, "vanilla", rows[0]["id"])
	require.Equal(t, "169ce792-3ef2-4050-a969-e1f4357a094f", rows[1]["id"])
	require.Equal(t, "28fe008e-205e-4275-88a6-e389c4862760", rows[2]["id"])
}

func TestUIConnectOriginsRejectCSPInjection(t *testing.T) {
	t.Parallel()
	require.NoError(t, validateUIOrigins([]string{
		"http://127.0.0.1:14318", "https://collector.example", "http://[::1]:4318",
	}))

	for _, origin := range []string{
		"*", "https:", "https://*.example", "https://example;script-src *",
		"https://example\nimg-src *", "https://u:p@example", "https://example/path",
		"https://example?x=1", "https://example#x",
	} {
		require.Error(t, validateUIOrigins([]string{origin}), origin)
	}
}
