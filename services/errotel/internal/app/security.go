package app

import (
	"crypto/sha256"
	"crypto/subtle"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
)

type peerBucket struct {
	tokens float64
	last   time.Time
}
type authGate struct {
	mu               sync.Mutex
	secret           [32]byte
	peers            map[string]peerBucket
	burst, rate, max int
	proxies          []netip.Prefix
}

func (g *authGate) peer(record *http.Request) string {
	host, _, err := net.SplitHostPort(record.RemoteAddr)
	if err != nil {
		host = record.RemoteAddr
	}

	address, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}

	trusted := func(a netip.Addr) bool {
		for _, p := range g.proxies {
			if p.Contains(a) {
				return true
			}
		}

		return false
	}
	if trusted(address) {
		parts := strings.Split(record.Header.Get("X-Forwarded-For"), ",")
		for i := len(parts) - 1; i >= 0; i-- {
			next, err := netip.ParseAddr(strings.TrimSpace(parts[i]))
			if err != nil {
				break
			}

			address = next
			if !trusted(address) {
				break
			}
		}
	}

	return address.Unmap().String()
}

func (g *authGate) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, record *http.Request) {
		h := record.Header.Get("Authorization")
		candidate := strings.TrimPrefix(h, "Bearer ")
		sum := sha256.Sum256([]byte(candidate))
		valid := subtle.ConstantTimeCompare(sum[:], g.secret[:]) == 1 && strings.HasPrefix(h, "Bearer ")
		// A correct token is never locked out by another client's failed guesses.
		if valid {
			next.ServeHTTP(writer, record)

			return
		}

		peer, now := g.peer(record), time.Now()
		g.mu.Lock()

		data, ok := g.peers[peer]
		if !ok {
			if len(g.peers) >= g.max {
				for key, value := range g.peers {
					if now.Sub(value.last) > time.Minute {
						delete(g.peers, key)
					}
				}
			}
			// Fail closed for new peers when full, instead of evicting blocked peers.
			if len(g.peers) >= g.max {
				g.mu.Unlock()
				writer.Header().Set("Retry-After", "60")
				apiError(writer, http.StatusTooManyRequests, "auth_rate_limited")

				return
			}

			data = peerBucket{tokens: float64(g.burst), last: now}
		}

		data.tokens = min(float64(g.burst), data.tokens+now.Sub(data.last).Minutes()*float64(g.rate))
		data.last = now
		limited := data.tokens < 1

		if !limited {
			data.tokens--
		}

		g.peers[peer] = data
		g.mu.Unlock()

		if limited {
			writer.Header().Set("Retry-After", "60")
			apiError(writer, http.StatusTooManyRequests, "auth_rate_limited")

			return
		}

		writer.Header().Set("WWW-Authenticate", "Bearer")
		apiError(writer, http.StatusUnauthorized, "unauthorized")
	})
}
