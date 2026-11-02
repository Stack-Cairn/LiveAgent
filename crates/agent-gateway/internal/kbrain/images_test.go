package kbrain

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestImageDelegationSignerRequiresKeyAndUniqueNonces(t *testing.T) {
	if _, err := (ImageDelegationSigner{}).Sign("alice", "target", false); err == nil {
		t.Fatal("missing signing configuration accepted")
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer := ImageDelegationSigner{KeyID: "key", PrivateKey: priv}
	first, err := signer.Sign("alice", "target", false)
	if err != nil {
		t.Fatal(err)
	}
	second, err := signer.Sign("alice", "target", false)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("nonce repeated")
	}
}

type imageRoundTripFunc func(*http.Request) (*http.Response, error)

func (f imageRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestImageRequestPreservesBodyAndDeadlineWithoutReplay(t *testing.T) {
	upstreamErr := errors.New("transport failed")
	calls := 0
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	client := &Client{BaseURL: "http://backend.test/prefix", Token: "private", HTTP: &http.Client{Timeout: time.Millisecond, Transport: imageRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.GetBody != nil {
			t.Error("request is replayable")
		}
		if r.URL.Path != "/prefix/v1/image/jobs" || r.URL.Query().Get("projectId") != "ip_1" || r.URL.Query().Has("ownerId") || r.URL.Query().Has("backendId") {
			t.Error("unsafe query or route")
		}
		if deadline, ok := r.Context().Deadline(); !ok || time.Until(deadline) < time.Minute {
			t.Error("operation deadline replaced with generic timeout")
		}
		return nil, upstreamErr
	})}}
	req := httptest.NewRequest("POST", "/api/image/jobs?backendId=selected&ownerId=local&projectId=ip_1", strings.NewReader(`{"prompt":"hello"}`))
	req.Header.Set("Idempotency-Key", "stable")
	_, err := client.ImageRequest(ctx, req, "/v1/image/jobs", "signed")
	if !errors.Is(err, upstreamErr) || calls != 1 {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
}

type imageFailingBody struct{ sent bool }

func (b *imageFailingBody) Read(p []byte) (int, error) {
	if b.sent {
		return 0, io.ErrUnexpectedEOF
	}
	b.sent = true
	return copy(p, "partial"), nil
}
func (b *imageFailingBody) Close() error { return nil }

func TestStreamImageResponsePropagatesFailure(t *testing.T) {
	w := httptest.NewRecorder()
	err := StreamImageResponse(w, &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"image/png"}}, Body: &imageFailingBody{}})
	if !errors.Is(err, io.ErrUnexpectedEOF) || w.Body.String() != "partial" || !w.Flushed {
		t.Fatalf("body=%q flushed=%v err=%v", w.Body.String(), w.Flushed, err)
	}
}

func TestImageRequestHEAD(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "HEAD" {
			t.Error("HEAD changed")
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Content-Length", "123")
		w.Header().Set("X-Image-Version", "kbrain.image.v1")
	}))
	defer upstream.Close()
	client, _ := New(upstream.URL, "private", upstream.Client())
	resp, err := client.ImageRequest(context.Background(), httptest.NewRequest("HEAD", "/api/image/assets/ia_1/content?variant=original", nil), "/v1/image/assets/ia_1/content", "signed")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	w := httptest.NewRecorder()
	if err := StreamImageResponse(w, resp); err != nil {
		t.Fatal(err)
	}
	if w.Body.Len() != 0 || w.Header().Get("Content-Length") != "123" || w.Header().Get("X-Image-Version") != "kbrain.image.v1" {
		t.Fatalf("HEAD response %+v", w)
	}
}
