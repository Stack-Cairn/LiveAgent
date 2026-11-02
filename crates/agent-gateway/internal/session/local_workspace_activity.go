package session

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

const (
	localWorkspaceAgentVersion = "gateway-local-workspace"
	localWorkspacePollPeriod   = 250 * time.Millisecond
	localWorkspaceMaxPaths     = 64
)

type localWorkspaceActivityOwner struct {
	agentID  string
	session  *AgentSession
	workdir  string
	baseline workspaceSnapshotState
	stop     chan struct{}
	refs     int
}

// EnsureLocalWorkspaceActivityOwner supplies the browser path with a local
// workspace owner when no desktop Agent session is online. The owner uses the
// same authenticated-session identity and broadcast path as a desktop Agent.
func (m *Manager) EnsureLocalWorkspaceActivityOwner(agentID, workdir string) (string, string, func(), error) {
	agentID = strings.TrimSpace(agentID)
	workdir = strings.TrimSpace(workdir)
	if agentID == "" {
		return "", "", nil, ErrAgentIDRequired
	}
	if workdir == "" {
		return "", "", nil, os.ErrInvalid
	}
	if _, err := os.Stat(workdir); err != nil {
		return "", "", nil, err
	}

	key := agentID + "\x00" + workdir
	// Keep the virtual owner out of the authenticated Agent registry. The
	// requested id may also be the K-brain relay target; replacing that entry
	// would make unrelated terminal and resource requests target a watcher that
	// cannot answer them.
	m.registry.mu.Lock()
	if existing := m.localWorkspaceOwners[key]; existing != nil {
		existing.refs++
		sessionID := existing.session.SessionID
		ownerID := existing.agentID
		m.registry.mu.Unlock()
		return ownerID, sessionID, m.releaseLocalWorkspaceActivityOwner(key), nil
	}

	ownerID := localWorkspaceAgentID(agentID, workdir)
	sessionID := "workspace-" + stableWorkspaceID(agentID+"\x00"+workdir)
	ownerSession := NewAgentSession(AuthSnapshot{AgentID: ownerID, AgentVersion: localWorkspaceAgentVersion, SessionID: sessionID})
	owner := &localWorkspaceActivityOwner{
		agentID:  ownerID,
		session:  ownerSession,
		workdir:  workdir,
		baseline: workspaceSnapshot(workdir),
		stop:     make(chan struct{}),
		refs:     1,
	}
	entry := m.registry.entryLocked(ownerID)
	entry.lastAuth = AuthSnapshot{AgentID: ownerID, AgentVersion: ownerSession.AgentVersion, SessionID: sessionID}
	entry.authValid = true
	entry.session = ownerSession
	m.localWorkspaceOwners[key] = owner
	m.registry.mu.Unlock()

	go m.runLocalWorkspaceActivityOwner(owner)
	return ownerID, sessionID, m.releaseLocalWorkspaceActivityOwner(key), nil
}

func localWorkspaceAgentID(requestedAgentID, workdir string) string {
	return "gateway-local-workspace-" + stableWorkspaceID(requestedAgentID+"\x00"+workdir)
}

func stableWorkspaceID(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:8])
}

func (m *Manager) releaseLocalWorkspaceActivityOwner(key string) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			m.registry.mu.Lock()
			owner := m.localWorkspaceOwners[key]
			if owner == nil {
				m.registry.mu.Unlock()
				return
			}
			owner.refs--
			if owner.refs > 0 {
				m.registry.mu.Unlock()
				return
			}
			delete(m.localWorkspaceOwners, key)
			if entry := m.registry.agents[owner.agentID]; entry != nil && entry.session == owner.session {
				entry.session = nil
				entry.authValid = false
				delete(m.registry.agents, owner.agentID)
			}
			m.registry.mu.Unlock()
			close(owner.stop)
			owner.session.Close()
		})
	}
}

func (m *Manager) runLocalWorkspaceActivityOwner(owner *localWorkspaceActivityOwner) {
	previous := owner.baseline
	ticker := time.NewTicker(localWorkspacePollPeriod)
	defer ticker.Stop()
	for {
		select {
		case <-owner.stop:
			return
		case <-ticker.C:
			next := workspaceSnapshot(owner.workdir)
			if next.digest == previous.digest {
				continue
			}
			previous = next
			m.broadcastWorkspaceActivity(owner.agentID, &gatewayv2.WorkspaceActivityEvent{
				Workdir:      owner.workdir,
				Revision:     next.revision,
				Fs:           next.fs,
				Git:          next.git,
				ChangedPaths: next.changedPaths,
				Truncated:    next.truncated,
			})
		}
	}
}

type workspaceSnapshotState struct {
	digest       string
	revision     uint64
	fs           bool
	git          bool
	changedPaths []string
	truncated    bool
}

func workspaceSnapshot(workdir string) workspaceSnapshotState {
	// WalkDir does not follow a symlink used as the workspace root.
	if resolved, err := filepath.EvalSymlinks(workdir); err == nil {
		workdir = resolved
	}
	files := make([]string, 0, 256)
	_ = filepath.WalkDir(workdir, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry == nil {
			return nil
		}
		if entry.IsDir() {
			if path != workdir && (entry.Name() == ".git" || entry.Name() == "node_modules" || entry.Name() == ".cache") {
				return filepath.SkipDir
			}
			return nil
		}
		info, statErr := entry.Info()
		if statErr != nil {
			return nil
		}
		rel, relErr := filepath.Rel(workdir, path)
		if relErr != nil {
			return nil
		}
		files = append(files, rel+":"+info.ModTime().UTC().Format(time.RFC3339Nano)+":"+formatFileSize(info.Size()))
		return nil
	})
	sort.Strings(files)
	sum := sha256.Sum256([]byte(strings.Join(files, "\n")))
	changed := make([]string, 0, localWorkspaceMaxPaths)
	for _, file := range files {
		name := strings.SplitN(file, ":", 2)[0]
		if len(changed) == localWorkspaceMaxPaths {
			break
		}
		changed = append(changed, filepath.ToSlash(name))
	}
	return workspaceSnapshotState{
		digest:       hex.EncodeToString(sum[:]),
		revision:     uint64(time.Now().UnixNano()),
		fs:           len(files) > 0,
		git:          fileExists(filepath.Join(workdir, ".git")),
		changedPaths: changed,
		truncated:    len(files) > localWorkspaceMaxPaths,
	}
}

func formatFileSize(size int64) string {
	if size == 0 {
		return "0"
	}
	negative := size < 0
	if negative {
		size = -size
	}
	var buf [32]byte
	i := len(buf)
	for size > 0 {
		i--
		buf[i] = byte('0' + size%10)
		size /= 10
	}
	if negative {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
