package server

import (
	"testing"
	"time"
)

func TestChatRateLimiterFixedWindow(t *testing.T) {
	limiter := newChatRateLimiter()
	now := time.Unix(100, 0)
	if !limiter.allow("chat.commands:127.0.0.1", 2, time.Minute, now) {
		t.Fatal("first request should be allowed")
	}
	if !limiter.allow("chat.commands:127.0.0.1", 2, time.Minute, now.Add(time.Second)) {
		t.Fatal("second request should be allowed")
	}
	if limiter.allow("chat.commands:127.0.0.1", 2, time.Minute, now.Add(2*time.Second)) {
		t.Fatal("third request should be rate limited")
	}
	if !limiter.allow("chat.commands:127.0.0.1", 2, time.Minute, now.Add(time.Minute)) {
		t.Fatal("request in next window should be allowed")
	}
}
