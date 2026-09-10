package app

import (
	"container/list"
	"sync"
	"time"
)

type cacheEntry struct {
	key              string
	body             []byte
	fetched, expires time.Time
}
type memoryCache struct {
	mu                   sync.Mutex
	entries              map[string]*list.Element
	lru                  *list.List
	bytes, max, maxEntry int
}

func newCache(maxBytes, maxEntry int) *memoryCache {
	return &memoryCache{entries: map[string]*list.Element{}, lru: list.New(), max: maxBytes, maxEntry: maxEntry}
}

func (c *memoryCache) remove(element *list.Element) {
	value, exists := element.Value.(cacheEntry)
	if !exists {
		panic("cache entry type invariant")
	}

	c.bytes -= len(value.body) + len(value.key)
	delete(c.entries, value.key)
	c.lru.Remove(element)
}

func (c *memoryCache) get(key string) ([]byte, time.Time, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	element, exists := c.entries[key]
	if !exists {
		return nil, time.Time{}, false
	}

	value, exists := element.Value.(cacheEntry)
	if !exists {
		panic("cache entry type invariant")
	}

	if time.Now().After(value.expires) {
		c.remove(element)

		return nil, time.Time{}, false
	}

	c.lru.MoveToFront(element)

	return value.body, value.fetched, true
}

func (c *memoryCache) put(key string, data []byte, ttl time.Duration, fetched time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if len(data) > c.maxEntry || len(data)+len(key) > c.max || ttl <= 0 {
		return
	}

	if old := c.entries[key]; old != nil {
		c.remove(old)
	}

	for c.bytes+len(data)+len(key) > c.max {
		c.remove(c.lru.Back())
	}

	c.entries[key] = c.lru.PushFront(cacheEntry{key, append([]byte(nil), data...), fetched, fetched.Add(ttl)})
	c.bytes += len(data) + len(key)
}
