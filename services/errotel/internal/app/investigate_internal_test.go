package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestInvestigationGeneratedValidationAndCacheAuth(t *testing.T) {
	t.Setenv("APP_DEBUG_API_TOKEN", "investigation-test")

	var calls atomic.Int32

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer upstream.Close()

	cfg, err := LoadConfig("")
	require.NoError(t, err)

	cfg.Logs.BaseURL = upstream.URL
	application, err := New(&cfg, nil)
	require.NoError(t, err)

	defer application.Close()

	send := func(body, token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/investigate", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)

		response := httptest.NewRecorder()
		application.Handler().ServeHTTP(response, req)

		return response
	}
	for _, body := range []string{
		`{}`, `{"ref":"invalid"}`, `{"ref":"x","eventId":"wrong"}`,
		`{"eventId":"6a9b6412-d4c2-4e88-9f0f-a2c3a733dca1"}`,
		`{"ref":"x","search":{"range":{"startUnixNano":"1","endUnixNano":"2"}}}`,
		`{"search":{"range":{"startUnixNano":"2","endUnixNano":"1"}}}`,
		`{"search":{"range":{"startUnixNano":"1","endUnixNano":"2"},"cursor":"x"}}`,
		`{"search":{"range":{"startUnixNano":"1","endUnixNano":"2"},"pageSize":1}}`,
		`{"ref":"x","relatedPageSize":201}`, `{"ref":"x","upstream":"http://example.com"}`,
	} {
		response := send(body, "investigation-test")
		require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
	}

	require.Zero(t, calls.Load())

	loc := locator{
		Version: 1, Source: cfg.Source,
		EventID: "6a9b6412-d4c2-4e88-9f0f-a2c3a733dca1", Time: "1000000000000000000",
	}
	detail := Detail{
		Summary: Summary{
			Ref: encode(loc), Origin: originSDK, EventID: loc.EventID,
			Timestamp: loc.Time, ContextStatus: "invalid",
		},
		Exception: map[string]any{"message": "original <script>"}, Payload: Payload{Status: "invalid"},
		Fields: map[string]string{}, Warnings: []string{"invalid_envelope"},
	}
	application.cache.put(application.revision+":detail:"+encode(loc), canonical(detail), time.Minute, time.Now())
	body := string(canonical(map[string]string{"ref": encode(loc)}))
	response := send(body, "investigation-test")
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())

	var bundle investigationResponse

	require.NoError(t, decodeAPI(response.Body.Bytes(), &bundle))
	require.Equal(t, detail, bundle.Occurrence)
	require.Equal(t, "cache", bundle.OccurrenceMeta.ServedFrom)
	require.Equal(t, statusPartial, bundle.Status)
	require.Equal(t, "trace_context_absent", bundle.Trace.Result.Reason)
	require.Equal(t, http.StatusUnauthorized, send(body, "wrong").Code)
	require.Zero(t, calls.Load())
}

func TestInvestigationTraceTimeoutKeepsPrimaryAndDoesNotCacheFailure(t *testing.T) {
	t.Setenv("APP_DEBUG_API_TOKEN", "investigation-test")

	var calls atomic.Int32

	upstream := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, req *http.Request) {
		calls.Add(1)
		<-req.Context().Done()
	}))
	defer upstream.Close()

	cfg, err := LoadConfig("")
	require.NoError(t, err)

	cfg.Logs.BaseURL, cfg.Traces.BaseURL = upstream.URL, upstream.URL+"/select/jaeger"
	cfg.Queries.Timeout = 50 * time.Millisecond
	application, err := New(&cfg, nil)
	require.NoError(t, err)

	defer application.Close()

	detail := Detail{Summary: Summary{TraceID: strings.Repeat("a", 32)}}
	for range 2 {
		result := application.investigationTrace(t.Context(), &detail)
		require.Equal(t, "unavailable", result.Result.Status)
	}

	require.EqualValues(t, 2, calls.Load())

	detail.Warnings = []string{"event_id_body_conflict"}
	require.Equal(t, "conflicting_identifiers", application.investigationTrace(t.Context(), &detail).Result.Reason)
	require.EqualValues(t, 2, calls.Load())
}
