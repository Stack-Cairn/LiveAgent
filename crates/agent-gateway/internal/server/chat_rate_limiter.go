package server

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type chatRateLimiter struct {
	mu      sync.Mutex
	buckets map[string]chatRateLimitBucket
}

type chatRateLimitBucket struct {
	windowStart time.Time
	count       int
}

func newChatRateLimiter() *chatRateLimiter {
	return &chatRateLimiter{
		buckets: make(map[string]chatRateLimitBucket),
	}
}

func (l *chatRateLimiter) allow(key string, limit int, window time.Duration, now time.Time) bool {
	if l == nil || limit <= 0 || window <= 0 {
		return true
	}
	key = strings.TrimSpace(key)
	if key == "" {
		key = "unknown"
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	for bucketKey, bucket := range l.buckets {
		if now.Sub(bucket.windowStart) > 2*window {
			delete(l.buckets, bucketKey)
		}
	}
	bucket := l.buckets[key]
	if bucket.windowStart.IsZero() || now.Sub(bucket.windowStart) >= window {
		l.buckets[key] = chatRateLimitBucket{windowStart: now, count: 1}
		return true
	}
	if bucket.count >= limit {
		return false
	}
	bucket.count += 1
	l.buckets[key] = bucket
	return true
}

func chatRateLimitKey(r *http.Request, scope string) string {
	host := ""
	if r != nil {
		host = strings.TrimSpace(r.RemoteAddr)
	}
	if parsedHost, _, err := net.SplitHostPort(host); err == nil {
		host = parsedHost
	}
	if host == "" {
		host = "unknown"
	}
	return strings.TrimSpace(scope) + ":" + host
}
