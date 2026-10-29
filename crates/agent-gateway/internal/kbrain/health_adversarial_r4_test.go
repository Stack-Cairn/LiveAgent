package kbrain

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Round 4: CronManage gates every cron_apply. cron_apply is also the only way
// to delete or disable a scheduled task (agent-ui applyCronOps sends
// {op:"delete"} / {op:"update", patch:{enabled:false}}). Against a backend whose
// health turned contradictory the user can no longer stop a task the backend
// keeps firing, which is the same "stopping work is refused" class fixed for
// queue remove/pause in round 3 (loop cancel and cron cancel_run already pass).
func TestR4DeletingScheduledTaskIsRefusedOnContradictingBackend(t *testing.T) {
	for name, ops := range map[string]string{
		"delete":  `{"baseRevision":1,"ops":[{"op":"delete","id":"nightly"}]}`,
		"disable": `{"baseRevision":1,"ops":[{"op":"update","id":"nightly","patch":{"enabled":false}}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			backend := &r3Backend{}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				backend.record(r)
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/v1/health" {
					_, _ = w.Write([]byte(r3ContradictingHealth))
					return
				}
				_, _ = w.Write([]byte(`{"status":"ok","cron":{"revision":2,"items":[]}}`))
			}))
			defer server.Close()
			client, _ := New(server.URL, "", server.Client())
			_, err := client.CronManage(context.Background(), "cron_apply", "", ops)
			if err != nil || !backend.saw("PUT /v1/cron") {
				t.Fatalf("stopping a scheduled task was refused: err=%v requests=%v", err, backend.list())
			}
		})
	}
}
