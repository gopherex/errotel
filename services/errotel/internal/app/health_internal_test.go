package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/gopherex/xprobe"
)

func TestReadinessReadsVMWhileLivenessDoesNot(t *testing.T) {
	t.Setenv("APP_DEBUG_API_TOKEN", "health-test-token")
	t.Setenv("HEALTH_READ_HEADERS", `{"Authorization":"Bearer upstream-test-token"}`)

	status := &atomic.Int32{}
	status.Store(http.StatusOK)

	called := &atomic.Int32{}
	queries := make(chan string, 16)

	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		called.Add(1)

		if request.URL.Path != "/tenant/select/logsql/query" ||
			request.Header.Get("Authorization") != "Bearer upstream-test-token" {
			writer.WriteHeader(http.StatusUnauthorized)

			return
		}

		_ = request.ParseForm()
		queries <- request.Form.Get("query")

		if status.Load() == 0 {
			<-request.Context().Done()

			return
		}

		if status.Load() == http.StatusCreated {
			writer.WriteHeader(http.StatusOK)
		} else {
			writer.WriteHeader(int(status.Load()))
		}

		if status.Load() == http.StatusCreated {
			_, _ = writer.Write([]byte("invalid-ndjson"))
		}
	}))
	defer upstream.Close()

	cfg, err := LoadConfig("")
	require.NoError(t, err)

	cfg.Logs = Endpoint{BaseURL: upstream.URL + "/tenant", HeadersEnv: "HEALTH_READ_HEADERS"}
	cfg.Traces.BaseURL = "http://127.0.0.1:1"
	cfg.Service.HTTP.ProbeTimeout = 30 * time.Millisecond
	application, err := New(&cfg, nil)
	require.NoError(t, err)

	defer application.Close()

	live := xprobe.NewBool()
	live.Set(true)
	handler := application.Management(live, nil)
	probe := func(path string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthz/"+path, http.NoBody))

		return response
	}
	require.Equal(t, http.StatusOK, probe("liveness").Code)
	require.Zero(t, called.Load())
	require.Equal(t, http.StatusOK, probe("readiness").Code)

	query := <-queries
	require.Contains(t, query, "1970-01-01T00:00:00")
	require.True(t, strings.HasSuffix(query, `| fields "_time" | limit 1`))

	for _, failure := range []int{
		http.StatusUnauthorized, http.StatusInternalServerError, http.StatusPartialContent,
		http.StatusCreated,
	} {
		status.Store(int32(failure))
		require.Equal(t, http.StatusServiceUnavailable, probe("readiness").Code)
		require.Equal(t, http.StatusOK, probe("liveness").Code)
	}

	status.Store(0)
	require.Contains(t, []int{http.StatusGatewayTimeout, http.StatusServiceUnavailable}, probe("readiness").Code)
	status.Store(http.StatusOK)
	require.Equal(t, http.StatusOK, probe("readiness").Code)
	live.Set(false)
	require.Equal(t, http.StatusServiceUnavailable, probe("readiness").Code)
}
