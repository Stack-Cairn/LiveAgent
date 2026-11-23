package kbrain

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// K-brain has no mention index yet, so @ file mentions are built from its
// generic /v1/fs "list" walk with the desktop command's filtering and ranking
// (agent-gui src-tauri commands/workspace/fs.rs fs_mention_list_sync). The walk
// does not read .gitignore and rejects trees over 10000 entries, so deep
// workspaces fall back to shallower depths and report truncation.

var mentionListDepths = []int{8, 4, 2, 1}

const (
	mentionListWalkLimit     = 10000
	mentionDefaultMaxResults = 5000
)

var mentionIgnoredDirNames = map[string]bool{
	".cache": true, ".gradle": true, ".hg": true, ".idea": true, ".next": true, ".nox": true,
	".nuxt": true, ".parcel-cache": true, ".pnpm-store": true, ".pytest_cache": true,
	".ruff_cache": true, ".sass-cache": true, ".serverless": true, ".svn": true,
	".svelte-kit": true, ".tox": true, ".turbo": true, ".venv": true, ".vite": true,
	".webpack": true, ".yarn": true, "__pycache__": true, "bin": true,
	"bower_components": true, "build": true, "cmakefiles": true, "coverage": true,
	"deriveddata": true, "dist": true, "dist-ssr": true, "env": true, "gradle": true,
	"htmlcov": true, "node_modules": true, "obj": true, "out": true, "pods": true,
	"target": true, "venv": true, "vendor": true,
}

type mentionWalkEntry struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`
	Hidden bool   `json:"hidden"`
}

type mentionWalk struct {
	Entries []mentionWalkEntry `json:"entries"`
	HasMore bool               `json:"has_more"`
}

func (r *Relay) fileMentions(ctx context.Context, req *gatewayv2.FileMentionListRequest) (*gatewayv2.AgentEnvelope, bool, error) {
	workdir := strings.TrimSpace(req.GetWorkdir())
	if workdir == "" {
		return nil, true, fmt.Errorf("workdir is required")
	}
	maxResults := int(req.GetMaxResults())
	if maxResults <= 0 {
		maxResults = mentionDefaultMaxResults
	}
	query := normalizeMentionQuery(req.GetQuery())
	var lastErr error
	for index, depth := range mentionListDepths {
		input := map[string]any{"action": "list", "workdir": workdir, "path": "", "depth": depth, "max_results": mentionListWalkLimit, "show_hidden": req.GetShowHidden()}
		var raw json.RawMessage
		const maxWalkJSONBytes = 8 << 20
		response, err := r.client.requestLimited(ctx, "POST", "/v1/fs", input, &raw, 64<<10, maxWalkJSONBytes)
		if err != nil {
			return nil, true, err
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			lastErr = fmt.Errorf("kbrain command: %s: %s", response.Status, raw)
			if response.StatusCode == 422 && strings.Contains(string(raw), "exceeds") {
				continue
			}
			return nil, true, lastErr
		}
		var walk mentionWalk
		if err := json.Unmarshal(raw, &walk); err != nil {
			return nil, true, err
		}
		entries, truncated := rankMentionEntries(walk.Entries, query, maxResults)
		out := &gatewayv2.FileMentionListResponse{Entries: entries, Truncated: truncated || index > 0 || walk.HasMore}
		return &gatewayv2.AgentEnvelope{Payload: &gatewayv2.AgentEnvelope_FileMentionListResp{FileMentionListResp: out}}, true, nil
	}
	return nil, true, lastErr
}

func normalizeMentionQuery(query string) string {
	query = strings.TrimLeft(strings.TrimSpace(query), "@")
	return strings.ToLower(strings.ReplaceAll(query, `\`, "/"))
}

func mentionPathIgnored(path string) bool {
	for _, segment := range strings.Split(path, "/") {
		name := strings.ToLower(segment)
		if mentionIgnoredDirNames[name] || strings.HasPrefix(name, "cmake-build-") {
			return true
		}
	}
	return false
}

func mentionMatchRank(lower, query string) int {
	name := lower[strings.LastIndex(lower, "/")+1:]
	switch {
	case query == "" || strings.HasPrefix(name, query):
		return 0
	case strings.HasPrefix(lower, query):
		return 1
	case strings.Contains(name, query):
		return 2
	default:
		return 3
	}
}

func rankMentionEntries(raw []mentionWalkEntry, query string, maxResults int) ([]*gatewayv2.FileMentionEntry, bool) {
	type ranked struct {
		entry               *gatewayv2.FileMentionEntry
		lower               string
		match, depth, order int
	}
	items := make([]ranked, 0, len(raw))
	for _, entry := range raw {
		path := strings.TrimPrefix(entry.Path, "./")
		lower := strings.ToLower(path)
		if path == "" || mentionPathIgnored(path) || (query != "" && !strings.Contains(lower, query)) {
			continue
		}
		kind, order := "file", 1
		if entry.Kind == "dir" {
			kind, order = "dir", 0
		}
		items = append(items, ranked{
			entry: &gatewayv2.FileMentionEntry{Path: path, Kind: kind, Hidden: entry.Hidden},
			lower: lower, match: mentionMatchRank(lower, query), depth: strings.Count(lower, "/"), order: order,
		})
	}
	sort.Slice(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a.match != b.match {
			return a.match < b.match
		}
		if a.depth != b.depth {
			return a.depth < b.depth
		}
		if a.order != b.order {
			return a.order < b.order
		}
		return a.lower < b.lower
	})
	truncated := len(items) > maxResults
	if truncated {
		items = items[:maxResults]
	}
	entries := make([]*gatewayv2.FileMentionEntry, len(items))
	for i, item := range items {
		entries[i] = item.entry
	}
	return entries, truncated
}
