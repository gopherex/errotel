package app

import (
	"context"
	"crypto/sha256"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type fragmentedReader struct{ data string }

func (reader *fragmentedReader) Read(target []byte) (int, error) {
	if reader.data == "" {
		return 0, io.EOF
	}

	size := min(len(target), 7, len(reader.data))
	copy(target, reader.data[:size])
	reader.data = reader.data[size:]

	return size, nil
}

func TestNDJSONFragmentsAndLargeFinalLine(t *testing.T) {
	t.Parallel()

	large := strings.Repeat("x", 3<<20)
	rows, err := readNDJSON(&fragmentedReader{data: "{\"key.with.dots\":\"Привет\"}\n{\"_msg\":\"" + large + "\"}"}, 2)
	require.NoError(t, err)
	require.Len(t, rows, 2)
	require.Equal(t, large, rows[1]["_msg"])

	_, err = readNDJSON(strings.NewReader("{}\n{broken}"), 10)
	require.Error(t, err)
	_, err = readNDJSON(strings.NewReader("{}\n{}"), 1)
	require.Error(t, err)
}

func TestCacheBudgetTTLAndImmutableInput(t *testing.T) {
	t.Parallel()

	cache := newCache(12, 5)
	data := []byte("value")
	now := time.Now()
	cache.put("a", data, time.Minute, now)
	data[0] = 'X'
	got, _, exists := cache.get("a")
	require.True(t, exists)
	require.Equal(t, "value", string(got))
	cache.put("huge", []byte("123456"), time.Minute, now)
	_, _, exists = cache.get("huge")
	require.False(t, exists)
	cache.put("b", []byte("value"), time.Minute, now)
	cache.put("c", []byte("value"), time.Minute, now)
	_, _, exists = cache.get("a")
	require.False(t, exists)
	require.LessOrEqual(t, cache.bytes, 12)
	cache.put("d", []byte("old"), time.Second, now.Add(-time.Minute))
	_, _, exists = cache.get("d")
	require.False(t, exists)
}

func TestPeerAuthBeforeCacheAndTrustedProxy(t *testing.T) {
	t.Parallel()

	gate := &authGate{secret: sha256.Sum256([]byte("correct")), peers: map[string]peerBucket{}, burst: 2, rate: 1, max: 2}
	calls := 0
	handler := gate.middleware(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		calls++

		writer.WriteHeader(http.StatusOK)
	}))
	request := httptest.NewRequest(http.MethodGet, "/api/v1/capabilities", http.NoBody)
	request.RemoteAddr = "192.0.2.1:1234"
	request.Header.Set("X-Forwarded-For", "198.51.100.1")
	require.Equal(t, "192.0.2.1", gate.peer(request))

	for _, token := range []string{"first", "second", "third"} {
		request.Header.Set("Authorization", "Bearer "+token)

		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		expected := http.StatusUnauthorized
		if token == "third" {
			expected = http.StatusTooManyRequests
		}

		require.Equal(t, expected, response.Code)
	}

	require.Zero(t, calls)
	request.Header.Set("Authorization", "Bearer correct")

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	require.Equal(t, http.StatusOK, response.Code)
	require.Equal(t, 1, calls)

	gate.proxies = []netip.Prefix{netip.MustParsePrefix("192.0.2.0/24")}
	require.Equal(t, "198.51.100.1", gate.peer(request))
}

func TestGeneratedAPIAuthOnCacheHitAndTimeout(t *testing.T) {
	t.Setenv("APP_DEBUG_API_TOKEN", "correct")

	var calls atomic.Int32

	var fail atomic.Bool

	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)

		_, _ = io.Copy(io.Discard, request.Body)

		if fail.Load() {
			<-request.Context().Done()

			return
		}

		writer.Header().Set("Content-Type", "application/stream+json")
		writer.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	config, err := LoadConfig("")
	require.NoError(t, err)

	config.Logs.BaseURL = upstream.URL
	config.Queries.Timeout = 50 * time.Millisecond
	application, err := New(&config, nil)
	require.NoError(t, err)

	defer application.Close()
	handler := application.Handler()
	search := `{"range":{"startUnixNano":"1000000000000000000","endUnixNano":"1000000001000000000"},"origin":"sdk"}`
	send := func(token string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/occurrences/search", strings.NewReader(search))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")

		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		return response
	}
	require.Equal(t, http.StatusOK, send("correct").Code)
	cached := send("correct")
	require.Equal(t, "hit", cached.Header().Get("X-Errotel-Cache"))
	require.EqualValues(t, 1, calls.Load())
	require.Equal(t, http.StatusUnauthorized, send("wrong").Code)
	require.EqualValues(t, 1, calls.Load())

	application.cache = newCache(0, 0)

	fail.Store(true)
	require.Equal(t, http.StatusGatewayTimeout, send("correct").Code)
	fail.Store(false)
	require.Equal(t, http.StatusOK, send("correct").Code)
	require.EqualValues(t, 3, calls.Load())
}

func TestQueryCancellation(t *testing.T) {
	t.Parallel()

	application := &App{http: http.DefaultClient, logsHeaders: make(http.Header)}
	application.cfg.Queries.Timeout = time.Second
	application.cfg.Logs.BaseURL = "http://127.0.0.1:1"
	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	_, _, err := application.logs(ctx, "*", Range{"1000000000000000000", "1000000001000000000"}, 1)
	require.Error(t, err)
}
