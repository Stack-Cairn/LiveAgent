package session

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestEnsureLocalWorkspaceActivityOwnerEmitsCanonicalIdentity(t *testing.T) {
	workdir := t.TempDir()
	manager := NewManager()
	ownerID, sessionID, release, err := manager.EnsureLocalWorkspaceActivityOwner("kbrain", workdir)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if ownerID == "kbrain" || sessionID == "" {
		t.Fatalf("owner identity = (%q, %q), want a distinct agent and session", ownerID, sessionID)
	}
	if manager.IsOnline("kbrain") {
		t.Fatal("local workspace owner must not replace the requested offline Agent identity")
	}

	events, cancel := manager.SubscribeWorkspaceActivity(ownerID, workdir)
	defer cancel()
	path := filepath.Join(workdir, "identity.txt")
	if err := os.WriteFile(path, []byte("canonical workspace activity"), 0o600); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(3 * time.Second)
	for {
		select {
		case event := <-events:
			if event == nil {
				continue
			}
			if event.GetWorkdir() != workdir || event.GetRevision() == 0 || !event.GetFs() {
				t.Fatalf("workspace event = %v, want workdir/revision/fs identity", event)
			}
			return
		case <-deadline:
			t.Fatal("timed out waiting for local workspace activity")
		}
	}
}
