//go:build integration

package integration_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// A black-box HTTP consumer: no generated client or repository contract imports.
func TestPublishedDiscoveryWorkflow(t *testing.T) {
	t.Setenv("APP_DEBUG_API_TOKEN", testToken)
	logsURL := startVM(t, logsImage, "9428/tcp")
	seedAlertRows(t, logsURL)
	envelope := fixture(t)
	stamp := time.Now().Add(-time.Second).UnixNano()
	envelope["timestampUnixNano"] = strconv.FormatInt(stamp, 10)
	seedLogs(t, logsURL, envelope, stamp)
	server, _ := startAPI(t, logsURL, "", "")
	schema := httpJSON(t, server.URL+"/openapi.json", nil, "", http.StatusOK)
	paths := schema["paths"].(map[string]any)
	operations := map[string]string{}

	for path, raw := range paths {
		for _, operation := range raw.(map[string]any) {
			operations[operation.(map[string]any)["operationId"].(string)] = path
		}
	}

	capabilities := httpJSON(t, server.URL+operations["getCapabilities"], nil, testToken, http.StatusOK)
	end, err := strconv.ParseInt(capabilities["serverTimeUnixNano"].(string), 10, 64)
	require.NoError(t, err)

	period := map[string]string{
		"startUnixNano": strconv.FormatInt(end-int64(time.Minute), 10),
		"endUnixNano":   strconv.FormatInt(end, 10),
	}
	request := map[string]any{"field": "service", "range": period, "pageSize": 1}

	var facets map[string]any

	require.Eventually(t, func() bool {
		facets = httpJSON(t, server.URL+operations["getFacets"], request, testToken, http.StatusOK)

		return len(facets["items"].([]any)) == 1
	}, 15*time.Second, 200*time.Millisecond)

	item := facets["items"].([]any)[0].(map[string]any)
	require.Equal(t, "alerts-test", item["value"])
	require.EqualValues(t, 4, item["errorCount"])

	request["cursor"] = facets["nextCursor"]
	second := httpJSON(t, server.URL+operations["getFacets"], request, testToken, http.StatusOK)
	item = second["items"].([]any)[0].(map[string]any)
	require.Equal(t, "integration-synthetic", item["value"])
	require.EqualValues(t, 1, item["errorCount"])
	httpJSON(t, server.URL+operations["getFacets"], request, "wrong", http.StatusUnauthorized)

	filter := map[string]string{"op": "eq", "field": "service", "value": "integration-synthetic"}
	for _, field := range []string{"environment", "release"} {
		found := httpJSON(t, server.URL+operations["getFacets"], map[string]any{
			"field": field, "range": period, "filter": filter,
		}, testToken, http.StatusOK)
		value := found["items"].([]any)[0].(map[string]any)
		require.Empty(t, value["value"], "absent metadata must not invent a default environment or commit")
	}

	search := map[string]any{"range": period, "filter": filter}
	bundle := httpJSON(t, server.URL+operations["investigate"], map[string]any{"search": search}, testToken, http.StatusOK)
	detail := bundle["occurrence"].(map[string]any)
	require.Equal(t, "available", detail["payload"].(map[string]any)["status"])
	require.Equal(t, envelope["eventId"], detail["summary"].(map[string]any)["eventId"])
	require.Equal(t, "trace_context_absent", bundle["trace"].(map[string]any)["result"].(map[string]any)["reason"])

	search["filter"] = map[string]string{"op": "eq", "field": "service", "value": `" OR * | limit 100`}
	empty := httpJSON(t, server.URL+operations["getFacets"], map[string]any{
		"field": "service", "range": period, "filter": search["filter"],
	}, testToken, http.StatusOK)
	require.Empty(t, empty["items"])
}

func httpJSON(t *testing.T, target string, body any, token string, expected int) map[string]any {
	t.Helper()

	method := http.MethodGet

	var reader io.Reader = http.NoBody

	if body != nil {
		data, err := json.Marshal(body)
		require.NoError(t, err)

		reader = bytes.NewReader(data)
		method = http.MethodPost
	}

	request, err := http.NewRequestWithContext(t.Context(), method, target, reader)
	require.NoError(t, err)
	request.Header.Set("Content-Type", "application/json")

	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}

	response, err := http.DefaultClient.Do(request)
	require.NoError(t, err)

	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.Equal(t, expected, response.StatusCode, string(data))

	var result map[string]any

	require.NoError(t, json.Unmarshal(data, &result))

	return result
}
