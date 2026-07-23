package agenttoken

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liveagent/agent-gateway/internal/db"
)

// openTestDB 打开共享池并在其上初始化凭证表（生命周期由测试清理关闭）。
func openTestDB(t *testing.T, path string) (*db.DB, *Store) {
	t.Helper()
	database, err := db.Open(path)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	store, err := NewStore(database)
	if err != nil {
		t.Fatalf("init store: %v", err)
	}
	return database, store
}

func openTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agents.db")
	_, store := openTestDB(t, path)
	return store, path
}

func tokenAuthenticates(t *testing.T, store *Store, agentID, token string) bool {
	t.Helper()
	_, err := store.AuthenticateAndRegister(agentID, token, false)
	if err == nil {
		return true
	}
	if errors.Is(err, ErrUnauthorized) {
		return false
	}
	t.Fatalf("authenticate agent token: %v", err)
	return false
}

func TestOpenRequiresDatabasePath(t *testing.T) {
	t.Parallel()

	if _, err := db.Open(""); err == nil {
		t.Fatal("empty database path must be rejected")
	}
}

func TestOpenCreatesDatabaseParentDirectory(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "nested", "gateway.db")
	database, err := db.Open(path)
	if err != nil {
		t.Fatalf("open nested gateway db: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("automatic gateway db was not created: %v", err)
	}
}

func TestNewStoreCreatesOnlyAgentsTable(t *testing.T) {
	t.Parallel()

	store, _ := openTestStore(t)
	rows, err := store.pool.Query(`
		SELECT name
		FROM sqlite_schema
		WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
		ORDER BY name
	`)
	if err != nil {
		t.Fatalf("list gateway tables: %v", err)
	}
	defer func() { _ = rows.Close() }()
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan gateway table: %v", err)
		}
		tables = append(tables, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate gateway tables: %v", err)
	}
	if len(tables) != 1 || tables[0] != "agents" {
		t.Fatalf("gateway tables = %v, want [agents]", tables)
	}
}

func TestIssueValidateDeleteLifecycle(t *testing.T) {
	t.Parallel()

	store, _ := openTestStore(t)
	token, err := store.Issue("agent-a", "备注")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if !strings.HasPrefix(token, "agt_") {
		t.Fatalf("token prefix = %q", token)
	}

	if !tokenAuthenticates(t, store, "agent-a", token) {
		t.Fatal("issued token must validate")
	}
	if tokenAuthenticates(t, store, "agent-a", "wrong") || tokenAuthenticates(t, store, "agent-b", token) {
		t.Fatal("wrong token / wrong agent must be rejected")
	}

	entries, err := store.Registered()
	if err != nil {
		t.Fatalf("registered: %v", err)
	}
	if len(entries) != 1 || entries[0].AgentID != "agent-a" || entries[0].Name != "备注" {
		t.Fatalf("registered = %#v", entries)
	}

	if deleted, err := store.Delete("agent-a"); err != nil || !deleted {
		t.Fatalf("delete = %v, %v", deleted, err)
	}
	if tokenAuthenticates(t, store, "agent-a", token) {
		t.Fatal("deleted token must be invalid")
	}
	if deleted, _ := store.Delete("agent-a"); deleted {
		t.Fatal("second delete must report nothing deleted")
	}
	page, err := store.List(PageParams{})
	if err != nil || len(page.Entries) != 0 {
		t.Fatalf("deleted agent must leave the directory: page=%#v err=%v", page, err)
	}
}

func TestRotationInvalidatesOldToken(t *testing.T) {
	t.Parallel()

	store, _ := openTestStore(t)
	oldToken, err := store.Issue("agent-a", "")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	newToken, err := store.Issue("agent-a", "")
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if tokenAuthenticates(t, store, "agent-a", oldToken) {
		t.Fatal("rotated-out token must be invalid")
	}
	if !tokenAuthenticates(t, store, "agent-a", newToken) {
		t.Fatal("rotated-in token must be valid")
	}
	if entries, err := store.Registered(); err != nil || len(entries) != 1 {
		t.Fatalf("rotation must not duplicate entries: entries=%d err=%v", len(entries), err)
	}
}

func TestAuthenticationEpochInvalidatedByRotationAndDelete(t *testing.T) {
	t.Parallel()

	store, _ := openTestStore(t)
	oldToken, err := store.Issue("agent-a", "")
	if err != nil {
		t.Fatalf("issue old token: %v", err)
	}
	rotationEpoch, err := store.AuthenticateAndRegister("agent-a", oldToken, false)
	if err != nil {
		t.Fatalf("authenticate old token: %v", err)
	}
	if !store.AuthenticationCurrent("agent-a", rotationEpoch) {
		t.Fatal("fresh authentication epoch should be current")
	}
	newToken, err := store.Issue("agent-a", "")
	if err != nil {
		t.Fatalf("rotate token: %v", err)
	}
	if store.AuthenticationCurrent("agent-a", rotationEpoch) {
		t.Fatal("rotation must invalidate an in-flight authentication epoch")
	}
	if _, err := store.AuthenticateAndRegister("agent-a", oldToken, false); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("old token authentication error = %v, want ErrUnauthorized", err)
	}

	deleteEpoch, err := store.AuthenticateAndRegister("agent-a", newToken, false)
	if err != nil {
		t.Fatalf("authenticate new token: %v", err)
	}
	if deleted, err := store.Delete("agent-a"); err != nil || !deleted {
		t.Fatalf("delete agent = %v, %v", deleted, err)
	}
	if store.AuthenticationCurrent("agent-a", deleteEpoch) {
		t.Fatal("delete must invalidate an in-flight authentication epoch")
	}
}

func TestAuthenticationEpochIsScopedPerAgent(t *testing.T) {
	t.Parallel()

	store, _ := openTestStore(t)
	tokenA, err := store.Issue("agent-a", "")
	if err != nil {
		t.Fatalf("issue agent-a token: %v", err)
	}
	tokenB, err := store.Issue("agent-b", "")
	if err != nil {
		t.Fatalf("issue agent-b token: %v", err)
	}
	epochA, err := store.AuthenticateAndRegister("agent-a", tokenA, false)
	if err != nil {
		t.Fatalf("authenticate agent-a: %v", err)
	}
	epochB, err := store.AuthenticateAndRegister("agent-b", tokenB, false)
	if err != nil {
		t.Fatalf("authenticate agent-b: %v", err)
	}

	if _, err := store.Issue("agent-a", ""); err != nil {
		t.Fatalf("rotate agent-a token: %v", err)
	}
	if store.AuthenticationCurrent("agent-a", epochA) {
		t.Fatal("agent-a rotation must invalidate agent-a authentication")
	}
	if !store.AuthenticationCurrent("agent-b", epochB) {
		t.Fatal("agent-a rotation must not invalidate agent-b authentication")
	}
}

func TestRegisteredReturnsDatabaseError(t *testing.T) {
	t.Parallel()

	database, store := openTestDB(t, filepath.Join(t.TempDir(), "agents.db"))
	if err := database.Close(); err != nil {
		t.Fatalf("close database: %v", err)
	}
	if _, err := store.Registered(); err == nil {
		t.Fatal("registered must return the database error instead of an empty directory")
	}
}

func TestAuthenticationReturnsDatabaseError(t *testing.T) {
	t.Parallel()

	database, store := openTestDB(t, filepath.Join(t.TempDir(), "agents.db"))
	if err := database.Close(); err != nil {
		t.Fatalf("close database: %v", err)
	}
	if _, err := store.AuthenticateAndRegister("agent-a", "token", false); err == nil || errors.Is(err, ErrUnauthorized) {
		t.Fatalf("authentication error = %v, want database error", err)
	}
}

func TestRegisterAddsGatewayTokenAgentWithoutCredential(t *testing.T) {
	t.Parallel()

	store, _ := openTestStore(t)
	if err := store.Register("shared-token-agent"); err != nil {
		t.Fatalf("register: %v", err)
	}
	if err := store.Register("shared-token-agent"); err != nil {
		t.Fatalf("repeat register: %v", err)
	}
	page, err := store.List(PageParams{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if page.Total != 1 || len(page.Entries) != 1 || page.Entries[0].AgentID != "shared-token-agent" || page.Entries[0].HasToken {
		t.Fatalf("registered gateway-token agent = %#v", page)
	}
	if page.Entries[0].Name != "" {
		t.Fatalf("automatic registration name = %q, want empty", page.Entries[0].Name)
	}

	if err := store.UpdateName("shared-token-agent", " Office desktop "); err != nil {
		t.Fatalf("update name: %v", err)
	}
	page, err = store.List(PageParams{})
	if err != nil || page.Entries[0].Name != "Office desktop" {
		t.Fatalf("updated name page = %#v err=%v", page, err)
	}
	if err := store.UpdateName("shared-token-agent", ""); err != nil {
		t.Fatalf("clear name: %v", err)
	}
	if err := store.UpdateName("shared-token-agent", strings.Repeat("名", 65)); !errors.Is(err, ErrAgentNameTooLong) {
		t.Fatalf("long name error = %v", err)
	}

	if deleted, err := store.Delete("shared-token-agent"); err != nil || !deleted {
		t.Fatalf("delete shared-token agent = %v, %v", deleted, err)
	}
	if err := store.Register("shared-token-agent"); err != nil {
		t.Fatalf("register after delete: %v", err)
	}
	page, err = store.List(PageParams{})
	if err != nil || page.Total != 1 || page.Entries[0].Name != "" {
		t.Fatalf("re-registered gateway-token agent = %#v err=%v", page, err)
	}
}

func TestNormalizeAgentIDRequiresCanonicalUUIDv4(t *testing.T) {
	t.Parallel()

	const valid = "agent-550e8400-e29b-41d4-a716-446655440000"
	if got, err := NormalizeAgentID("  " + valid + "  "); err != nil || got != valid {
		t.Fatalf("normalize valid id = %q, %v", got, err)
	}
	for _, invalid := range []string{"", "hhhh", "agent-550e8400-e29b-11d4-a716-446655440000", "agent-550E8400-E29B-41D4-A716-446655440000"} {
		if _, err := NormalizeAgentID(invalid); err == nil {
			t.Fatalf("invalid id %q was accepted", invalid)
		}
	}
}

func TestTokensSurviveReopen(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "agents.db")
	database, store := openTestDB(t, path)
	token, err := store.Issue("agent-a", "prod")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	// 模拟网关重启：重开库后凭证仍有效，删除也持久化。
	_, reopened := openTestDB(t, path)
	if !tokenAuthenticates(t, reopened, "agent-a", token) {
		t.Fatal("token must survive reopen")
	}
	if deleted, err := reopened.Delete("agent-a"); err != nil || !deleted {
		t.Fatalf("delete after reopen = %v, %v", deleted, err)
	}

	_, third := openTestDB(t, path)
	if tokenAuthenticates(t, third, "agent-a", token) {
		t.Fatal("deletion must survive reopen")
	}
}

func TestNewStorePreloadsKnownAgentsAfterReopen(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "agents.db")
	database, store := openTestDB(t, path)
	if err := store.Register("shared-token-agent"); err != nil {
		t.Fatalf("register shared-token agent: %v", err)
	}
	agentToken, err := store.Issue("independent-token-agent", "")
	if err != nil {
		t.Fatalf("issue independent agent token: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("close database: %v", err)
	}

	// 模拟 Gateway 重启。把重开的单连接切为只读，确保已有 Agent 重连完全依赖
	// 启动预加载缓存；如果仍执行 INSERT OR IGNORE，此处会因只读而失败。
	reopenedDB, reopened := openTestDB(t, path)
	reopenedDB.Pool().SetMaxOpenConns(1)
	reopenedDB.Pool().SetMaxIdleConns(1)
	if _, err := reopenedDB.Pool().Exec(`PRAGMA query_only = ON`); err != nil {
		t.Fatalf("enable query-only mode: %v", err)
	}
	if _, ok := reopened.knownAgents.Load("shared-token-agent"); !ok {
		t.Fatal("shared-token agent was not preloaded")
	}
	if _, ok := reopened.knownAgents.Load("independent-token-agent"); !ok {
		t.Fatal("independent-token agent was not preloaded")
	}
	if _, err := reopened.AuthenticateAndRegister("shared-token-agent", "", true); err != nil {
		t.Fatalf("reconnect preloaded shared-token agent: %v", err)
	}
	if _, err := reopened.AuthenticateAndRegister(
		"independent-token-agent", agentToken, false,
	); err != nil {
		t.Fatalf("reconnect preloaded independent-token agent: %v", err)
	}
	if _, err := reopened.AuthenticateAndRegister("new-agent", "", true); err == nil {
		t.Fatal("new shared-token agent unexpectedly registered in query-only mode")
	}
}

func TestDBFilePermissionsAndNoPlaintext(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "agents.db")
	database, store := openTestDB(t, path)
	token, err := store.Issue("agent-a", "")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat db: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("db file perm = %o, want 0600", perm)
	}
	// 明文绝不落库：直接扫库文件字节。
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read db: %v", err)
	}
	if strings.Contains(string(raw), token) {
		t.Fatal("plaintext token must never be stored")
	}
}

func TestListPaginates(t *testing.T) {
	t.Parallel()

	store, _ := openTestStore(t)
	// 混合登记 120 个 Agent：一半有独立凭证，一半仅在目录中。
	for i := 0; i < 120; i++ {
		agentID := fmt.Sprintf("agent-%03d", i)
		if i%2 == 0 {
			if _, err := store.Issue(agentID, ""); err != nil {
				t.Fatalf("issue %d: %v", i, err)
			}
		} else if err := store.Register(agentID); err != nil {
			t.Fatalf("register %d: %v", i, err)
		}
	}

	first, err := store.List(PageParams{Page: 1, PageSize: 50})
	if err != nil {
		t.Fatalf("list page 1: %v", err)
	}
	if first.Total != 120 || len(first.Entries) != 50 || !first.HasMore {
		t.Fatalf("page 1 = total %d, len %d, hasMore %v", first.Total, len(first.Entries), first.HasMore)
	}
	if !first.Entries[0].HasToken || first.Entries[1].HasToken {
		t.Fatalf("mixed credential flags = %#v, %#v", first.Entries[0], first.Entries[1])
	}

	last, err := store.List(PageParams{Page: 3, PageSize: 50})
	if err != nil {
		t.Fatalf("list page 3: %v", err)
	}
	if len(last.Entries) != 20 || last.HasMore {
		t.Fatalf("page 3 = len %d, hasMore %v, want 20 entries no-more", len(last.Entries), last.HasMore)
	}

	// 超末页返回空、total 仍准确。
	beyond, err := store.List(PageParams{Page: 99, PageSize: 50})
	if err != nil {
		t.Fatalf("list beyond: %v", err)
	}
	if len(beyond.Entries) != 0 || beyond.Total != 120 || beyond.HasMore {
		t.Fatalf("beyond = len %d total %d hasMore %v", len(beyond.Entries), beyond.Total, beyond.HasMore)
	}
}

func TestListFiltersInDatabaseBeforePaging(t *testing.T) {
	t.Parallel()

	store, _ := openTestStore(t)
	for i := 0; i < 120; i++ {
		if _, err := store.Issue(fmt.Sprintf("agent-%03d", i), ""); err != nil {
			t.Fatalf("issue %d: %v", i, err)
		}
	}
	onlineIDs := make([]string, 0, 60)
	for i := 0; i < 120; i += 2 {
		onlineIDs = append(onlineIDs, fmt.Sprintf("agent-%03d", i))
	}

	page, err := store.List(PageParams{
		Page:           2,
		PageSize:       10,
		Status:         StatusOnline,
		OnlineAgentIDs: onlineIDs,
	})
	if err != nil {
		t.Fatalf("online list: %v", err)
	}
	if page.Total != 60 || len(page.Entries) != 10 || !page.HasMore || page.Entries[0].AgentID != "agent-020" {
		t.Fatalf("online page = total %d len %d hasMore %v first %q", page.Total, len(page.Entries), page.HasMore, page.Entries[0].AgentID)
	}

	offline, err := store.List(PageParams{
		Page:           6,
		PageSize:       10,
		Status:         StatusOffline,
		OnlineAgentIDs: onlineIDs,
	})
	if err != nil {
		t.Fatalf("offline list: %v", err)
	}
	if offline.Total != 60 || len(offline.Entries) != 10 || offline.HasMore || offline.Entries[0].AgentID != "agent-101" {
		t.Fatalf("offline last page = total %d len %d hasMore %v first %q", offline.Total, len(offline.Entries), offline.HasMore, offline.Entries[0].AgentID)
	}
}

func TestListRejectsInvalidStatusFilter(t *testing.T) {
	t.Parallel()

	store, _ := openTestStore(t)
	if _, err := store.List(PageParams{Status: StatusFilter("unknown")}); err == nil {
		t.Fatal("invalid status filter must be rejected")
	}
}

func TestListParamsClamped(t *testing.T) {
	t.Parallel()

	store, _ := openTestStore(t)
	for i := 0; i < 5; i++ {
		if _, err := store.Issue(fmt.Sprintf("a-%d", i), ""); err != nil {
			t.Fatalf("issue: %v", err)
		}
	}

	// page<1 归一到 1，page_size<=0 用默认，超上限钳制到 maxPageSize。
	zero, _ := store.List(PageParams{Page: 0, PageSize: 0})
	if zero.Page != 1 || zero.PageSize != defaultPageSize {
		t.Fatalf("clamp low = page %d size %d", zero.Page, zero.PageSize)
	}
	big, _ := store.List(PageParams{Page: 1, PageSize: 9999})
	if big.PageSize != maxPageSize {
		t.Fatalf("clamp high = size %d, want %d", big.PageSize, maxPageSize)
	}
}

func TestListOrderUsesIndexNotFullScan(t *testing.T) {
	t.Parallel()

	store, _ := openTestStore(t)
	for i := 0; i < 3; i++ {
		if _, err := store.Issue(fmt.Sprintf("a-%d", i), ""); err != nil {
			t.Fatalf("issue: %v", err)
		}
	}
	// 分页排序不得触发临时 B-Tree 排序（全表 sort），应走 created_at 索引。
	var plan strings.Builder
	rows, err := store.pool.Query(
		`EXPLAIN QUERY PLAN
		 SELECT a.agent_id, a.name, a.created_at, a.token_issued_at
		 FROM agents AS a
		 ORDER BY a.created_at, a.agent_id LIMIT 50 OFFSET 0`,
	)
	if err != nil {
		t.Fatalf("explain: %v", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id, parent, notused int
		var detail string
		if err := rows.Scan(&id, &parent, &notused, &detail); err != nil {
			t.Fatalf("scan plan: %v", err)
		}
		plan.WriteString(detail)
		plan.WriteString("\n")
	}
	if strings.Contains(plan.String(), "USE TEMP B-TREE FOR ORDER BY") {
		t.Fatalf("ORDER BY fell back to temp b-tree sort:\n%s", plan.String())
	}
	if !strings.Contains(plan.String(), "idx_agents_created_at_agent_id") {
		t.Fatalf("ORDER BY did not use the paging index:\n%s", plan.String())
	}

	plan.Reset()
	rows, err = store.pool.Query(
		`EXPLAIN QUERY PLAN
		 SELECT a.agent_id, a.name, a.created_at, a.token_issued_at
		 FROM agents AS a
		 WHERE a.agent_id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?))
		 ORDER BY a.created_at, a.agent_id LIMIT 50 OFFSET 0`,
		`["a-0"]`,
	)
	if err != nil {
		t.Fatalf("explain offline: %v", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id, parent, notused int
		var detail string
		if err := rows.Scan(&id, &parent, &notused, &detail); err != nil {
			t.Fatalf("scan offline plan: %v", err)
		}
		plan.WriteString(detail)
		plan.WriteString("\n")
	}
	if strings.Contains(plan.String(), "USE TEMP B-TREE FOR ORDER BY") ||
		!strings.Contains(plan.String(), "idx_agents_created_at_agent_id") {
		t.Fatalf("offline paging did not use the ordering index:\n%s", plan.String())
	}

	plan.Reset()
	rows, err = store.pool.Query(
		`EXPLAIN QUERY PLAN SELECT token_sha256 FROM agents WHERE agent_id = ?`,
		"a-0",
	)
	if err != nil {
		t.Fatalf("explain lookup: %v", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id, parent, notused int
		var detail string
		if err := rows.Scan(&id, &parent, &notused, &detail); err != nil {
			t.Fatalf("scan lookup plan: %v", err)
		}
		plan.WriteString(detail)
		plan.WriteString("\n")
	}
	if !strings.Contains(plan.String(), "agent_id=?") {
		t.Fatalf("credential lookup did not use the agent_id primary key:\n%s", plan.String())
	}
}
