package kbrain

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// Round 5 evidence (expected to pass): cron_apply payloads that try to smuggle
// work past cronOpsAdvanceWork with case-variant keys. Gateway re-encodes the
// decoded map, so the exact lowercase key sorts last, and K-brain's
// encoding/json struct decode (case-insensitive, last key wins, maps merge)
// ends with the value Gateway classified. The struct below copies K-brain
// internal/backend/cron_types.go CronApplyInput/CronOperation at 894612f.
type r5KBrainCronApply struct {
	BaseRevision uint64 `json:"baseRevision"`
	Ops          []struct {
		Op    string         `json:"op"`
		ID    string         `json:"id,omitempty"`
		Item  map[string]any `json:"item,omitempty"`
		Patch map[string]any `json:"patch,omitempty"`
		IDs   []string       `json:"ids,omitempty"`
	} `json:"ops"`
}

func TestR5CronApplyCaseVariantKeysCannotSmuggleWork(t *testing.T) {
	cases := map[string]string{
		"Op create beside op delete":      `{"baseRevision":1,"ops":[{"Op":"create","op":"delete","id":"nightly","Item":{"id":"evil","enabled":true}}]}`,
		"Patch enabling beside patch off": `{"baseRevision":1,"ops":[{"op":"update","id":"nightly","patch":{"enabled":false},"Patch":{"enabled":true,"Enabled":true,"cron":"* * * * *"}}]}`,
		"Ops create beside ops delete":    `{"baseRevision":1,"Ops":[{"op":"create","item":{"id":"evil","enabled":true}}],"ops":[{"op":"delete","id":"nightly"}]}`,
		"empty ops is a no-op":            `{"baseRevision":1,"ops":[]}`,
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			var mu sync.Mutex
			var forwarded []byte
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/v1/health" {
					_, _ = w.Write([]byte(r3ContradictingHealth))
					return
				}
				body, _ := io.ReadAll(r.Body)
				mu.Lock()
				forwarded = body
				mu.Unlock()
				_, _ = w.Write([]byte(`{"status":"ok","cron":{"revision":2,"tasks":[]}}`))
			}))
			defer server.Close()
			client, _ := New(server.URL, "", server.Client())
			if _, err := client.CronManage(context.Background(), "cron_apply", "", payload); err != nil {
				return // gated: nothing reached the contradicting backend
			}
			mu.Lock()
			defer mu.Unlock()
			var decoded r5KBrainCronApply
			dec := json.NewDecoder(bytes.NewReader(forwarded))
			dec.DisallowUnknownFields()
			if err := dec.Decode(&decoded); err != nil {
				return // K-brain would answer 400
			}
			t.Logf("forwarded ungated: %s -> %+v", forwarded, decoded.Ops)
			for _, op := range decoded.Ops {
				enabled, set := op.Patch["enabled"]
				capital, capitalSet := op.Patch["Enabled"]
				reenables := (set && enabled != false) || (capitalSet && capital == true && !set)
				if op.Op == "create" || (op.Op == "update" && reenables) {
					t.Fatalf("ungated cron_apply reached K-brain as %+v (forwarded %s)", op, forwarded)
				}
			}
		})
	}
}
