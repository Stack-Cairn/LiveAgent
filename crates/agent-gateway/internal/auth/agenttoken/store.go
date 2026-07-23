// Package agenttoken 维护持久化 Agent 目录及每 Agent 独立、可轮换和删除的接入凭证。
// 凭证明文只在签发响应中出现一次，落库仅存 SHA-256。
package agenttoken

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/db"
)

// tokenPrefix 便于在日志/配置里一眼识别凭证类型（不参与校验）。
const tokenPrefix = "agt_"

// tokenEntropyBytes 是凭证随机部分的字节数（32 字节 ≈ 43 个 base64url 字符）。
const tokenEntropyBytes = 32

const maxAgentNameLength = 64

var ErrAgentIDRequired = errors.New("agent id is required")

var ErrInvalidAgentID = errors.New("agent id must be a canonical agent UUID v4")

var ErrAgentNameTooLong = errors.New("agent name must not exceed 64 characters")

var ErrAgentNotFound = errors.New("agent not found")

var ErrInvalidStatusFilter = errors.New("invalid agent status filter")

var ErrUnauthorized = errors.New("unauthorized agent credential")

// dummyHashHex 是未知 agent_id 时参与比较的占位哈希（长度与真实哈希一致、
// 恒不匹配），保证未知 id 与错误凭证的校验路径耗时一致、不暴露 id 是否存在。
var dummyHashHex = strings.Repeat("0", sha256.Size*2)

// DirectoryEntry 是持久化 Agent 目录条目。
type DirectoryEntry struct {
	AgentID        string
	Name           string
	RegisteredAt   time.Time
	HasToken       bool
	TokenCreatedAt time.Time
}

// Store 是 Agent 目录和凭证子系统句柄；由 Gateway 启动时创建并始终可用。
type Store struct {
	pool             *sql.DB
	knownAgents      sync.Map
	credentialMu     sync.RWMutex
	credentialEpochs map[string]uint64
}

// NewStore 在 Gateway 共享库上初始化首版 Agent 单表结构。
func NewStore(database *db.DB) (*Store, error) {
	if database == nil || !database.Enabled() {
		return nil, errors.New("gateway database is required")
	}
	pool := database.Pool()
	if _, err := pool.Exec(`
		CREATE TABLE IF NOT EXISTS agents (
			agent_id        TEXT PRIMARY KEY,
			name            TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 64),
			token_sha256    TEXT,
			created_at      INTEGER NOT NULL,
			token_issued_at INTEGER,
			CHECK ((token_sha256 IS NULL) = (token_issued_at IS NULL))
		);
		CREATE INDEX IF NOT EXISTS idx_agents_created_at_agent_id
			ON agents(created_at, agent_id);
	`); err != nil {
		return nil, fmt.Errorf("init agent schema: %w", err)
	}
	store := &Store{pool: pool, credentialEpochs: make(map[string]uint64)}
	if err := store.loadKnownAgents(); err != nil {
		return nil, err
	}
	return store, nil
}

// loadKnownAgents 在 Gateway 开始监听前一次性恢复已登记 ID 缓存。只读取主键，
// 不缓存凭证；独立 Token 的轮换和撤销仍由每次连接时的数据库校验保证。
func (s *Store) loadKnownAgents() error {
	rows, err := s.pool.Query(`SELECT agent_id FROM agents`)
	if err != nil {
		return fmt.Errorf("load known agents: %w", err)
	}
	for rows.Next() {
		var agentID string
		if err := rows.Scan(&agentID); err != nil {
			_ = rows.Close()
			return fmt.Errorf("load known agents: %w", err)
		}
		s.knownAgents.Store(agentID, struct{}{})
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return fmt.Errorf("load known agents: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("load known agents: %w", err)
	}
	return nil
}

// NormalizeAgentID 接受桌面端自动生成的规范 agent-UUIDv4 标识。
func NormalizeAgentID(raw string) (string, error) {
	agentID := strings.TrimSpace(raw)
	if agentID == "" {
		return "", ErrAgentIDRequired
	}
	const prefix = "agent-"
	if !strings.HasPrefix(agentID, prefix) {
		return "", ErrInvalidAgentID
	}
	parsed, err := uuid.Parse(strings.TrimPrefix(agentID, prefix))
	if err != nil || parsed.Version() != 4 || prefix+parsed.String() != agentID {
		return "", ErrInvalidAgentID
	}
	return agentID, nil
}

func normalizeName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if utf8.RuneCountInString(name) > maxAgentNameLength {
		return "", ErrAgentNameTooLong
	}
	return name, nil
}

// 分页默认与上限（沿用项目 history 列表的钳制风格）。
const (
	defaultPageSize = 50
	maxPageSize     = 200
)

// StatusFilter 是 Agent 目录的实时在线状态筛选条件。
type StatusFilter string

const (
	StatusAll     StatusFilter = "all"
	StatusOnline  StatusFilter = "online"
	StatusOffline StatusFilter = "offline"
)

// ParseStatusFilter 解析管理 API 的状态筛选；空值等同于 all。
func ParseStatusFilter(raw string) (StatusFilter, error) {
	filter := StatusFilter(strings.ToLower(strings.TrimSpace(raw)))
	if filter == "" {
		return StatusAll, nil
	}
	switch filter {
	case StatusAll, StatusOnline, StatusOffline:
		return filter, nil
	default:
		return "", ErrInvalidStatusFilter
	}
}

// PageParams 分页入参；状态筛选和分页都由 SQLite 执行。
type PageParams struct {
	Page           int
	PageSize       int
	Status         StatusFilter
	OnlineAgentIDs []string
}

func (p PageParams) normalized() (page, pageSize, offset int) {
	page = p.Page
	if page < 1 {
		page = 1
	}
	pageSize = p.PageSize
	switch {
	case pageSize <= 0:
		pageSize = defaultPageSize
	case pageSize > maxPageSize:
		pageSize = maxPageSize
	}
	return page, pageSize, (page - 1) * pageSize
}

// Page 是一页 Agent 目录及分页元信息。
type Page struct {
	Entries  []DirectoryEntry
	Total    int
	Page     int
	PageSize int
	HasMore  bool
}

func (s *Store) validateLocked(agentID, token string) (bool, error) {
	agentID = strings.TrimSpace(agentID)
	token = strings.TrimSpace(token)
	if agentID == "" || token == "" {
		return false, nil
	}

	stored := dummyHashHex
	known := false
	var fetched sql.NullString
	err := s.pool.QueryRow(`SELECT token_sha256 FROM agents WHERE agent_id = ?`, agentID).Scan(&fetched)
	if err == nil && fetched.Valid && fetched.String != "" {
		stored = fetched.String
		known = true
	}

	presented := sha256.Sum256([]byte(token))
	presentedHex := hex.EncodeToString(presented[:])
	valid := subtle.ConstantTimeCompare([]byte(presentedHex), []byte(stored)) == 1 && known
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, fmt.Errorf("query agent credential: %w", err)
	}
	return valid, nil
}

// Register 持久化首次成功接入的 Agent。进程内已知 ID 不访问数据库；缓存未命中
// 时用 INSERT OR IGNORE 原子补登记，避免重复连接产生 WAL 更新。
func (s *Store) Register(agentID string) error {
	if s == nil {
		return errors.New("agent registry is not enabled")
	}
	s.credentialMu.RLock()
	defer s.credentialMu.RUnlock()
	return s.registerLocked(agentID)
}

func (s *Store) registerLocked(agentID string) error {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return ErrAgentIDRequired
	}
	if _, known := s.knownAgents.Load(agentID); known {
		return nil
	}
	if _, err := s.pool.Exec(
		`INSERT OR IGNORE INTO agents (agent_id, name, created_at) VALUES (?, '', ?)`,
		agentID, time.Now().Unix(),
	); err != nil {
		return fmt.Errorf("register agent: %w", err)
	}
	s.knownAgents.Store(agentID, struct{}{})
	return nil
}

// AuthenticateAndRegister 在凭证变更读锁内完成独立凭证校验与目录登记，并返回
// 当前凭证纪元。sharedAuthenticated 只能由网关共享 Token 的常量时间校验结果提供。
// Issue/Delete 必须等待本方法退出，避免“旧凭证已校验、轮换后才登记”的窗口。
func (s *Store) AuthenticateAndRegister(
	agentID, token string,
	sharedAuthenticated bool,
) (uint64, error) {
	if s == nil {
		return 0, errors.New("agent token store is not enabled")
	}
	s.credentialMu.RLock()
	defer s.credentialMu.RUnlock()
	if !sharedAuthenticated {
		valid, err := s.validateLocked(agentID, token)
		if err != nil {
			return 0, err
		}
		if !valid {
			return 0, ErrUnauthorized
		}
	}
	if err := s.registerLocked(agentID); err != nil {
		return 0, err
	}
	return s.credentialEpochs[strings.TrimSpace(agentID)], nil
}

// AuthenticationCurrent 供会话在登记锁内确认：从鉴权到登记之间没有发生任何
// 同 Agent 的凭证轮换或删除；不同 Agent 的并发管理操作互不影响。
func (s *Store) AuthenticationCurrent(agentID string, epoch uint64) bool {
	if s == nil {
		return false
	}
	s.credentialMu.RLock()
	defer s.credentialMu.RUnlock()
	return s.credentialEpochs[strings.TrimSpace(agentID)] == epoch
}

// Issue 为 agent_id 生成新凭证并落库，返回明文（仅此一次）；已有凭证被轮换顶替。
func (s *Store) Issue(agentID, name string) (string, error) {
	if s == nil {
		return "", errors.New("agent token store is not enabled")
	}
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return "", ErrAgentIDRequired
	}
	var err error
	name, err = normalizeName(name)
	if err != nil {
		return "", err
	}

	buf := make([]byte, tokenEntropyBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate agent token: %w", err)
	}
	token := tokenPrefix + base64.RawURLEncoding.EncodeToString(buf)
	digest := sha256.Sum256([]byte(token))
	now := time.Now().Unix()

	s.credentialMu.Lock()
	defer s.credentialMu.Unlock()
	if _, err := s.pool.Exec(
		`INSERT INTO agents (agent_id, name, token_sha256, created_at, token_issued_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(agent_id) DO UPDATE SET
		   name = excluded.name,
		   token_sha256 = excluded.token_sha256,
		   token_issued_at = excluded.token_issued_at`,
		agentID, name, hex.EncodeToString(digest[:]), now, now,
	); err != nil {
		return "", fmt.Errorf("persist agent credential: %w", err)
	}
	s.knownAgents.Store(agentID, struct{}{})
	s.credentialEpochs[agentID] += 1
	return token, nil
}

// UpdateName 修改已登记 Agent 的可选名称。
func (s *Store) UpdateName(agentID, name string) error {
	if s == nil {
		return ErrAgentNotFound
	}
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return ErrAgentIDRequired
	}
	name, err := normalizeName(name)
	if err != nil {
		return err
	}
	s.credentialMu.RLock()
	defer s.credentialMu.RUnlock()
	result, err := s.pool.Exec(`UPDATE agents SET name = ? WHERE agent_id = ?`, name, agentID)
	if err != nil {
		return fmt.Errorf("update agent name: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("update agent name: %w", err)
	}
	if affected == 0 {
		return ErrAgentNotFound
	}
	return nil
}

// Delete 删除 Agent 目录行及其独立凭证。
func (s *Store) Delete(agentID string) (bool, error) {
	if s == nil {
		return false, nil
	}
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return false, ErrAgentIDRequired
	}
	s.credentialMu.Lock()
	defer s.credentialMu.Unlock()
	result, err := s.pool.Exec(`DELETE FROM agents WHERE agent_id = ?`, agentID)
	if err != nil {
		return false, fmt.Errorf("delete agent: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("delete agent: %w", err)
	}
	if affected > 0 {
		s.knownAgents.Delete(agentID)
		s.credentialEpochs[agentID] += 1
	}
	return affected > 0, nil
}

// Count 返回持久化 Agent 目录总数。
func (s *Store) Count() (int, error) {
	if s == nil {
		return 0, nil
	}
	var total int
	if err := s.pool.QueryRow(`SELECT COUNT(*) FROM agents`).Scan(&total); err != nil {
		return 0, fmt.Errorf("count agents: %w", err)
	}
	return total, nil
}

// List 按状态筛选并分页返回 Agent 目录。在线 ID 作为单个 JSON 参数交给 SQLite
// json_each 展开，避免动态 IN 参数上限；Go 层不会读取全量凭证后再分页。
func (s *Store) List(params PageParams) (Page, error) {
	page, pageSize, offset := params.normalized()
	if s == nil {
		return Page{Page: page, PageSize: pageSize}, nil
	}

	filter, err := ParseStatusFilter(string(params.Status))
	if err != nil {
		return Page{}, err
	}
	whereClause := ""
	var filterArg any
	switch filter {
	case StatusOnline, StatusOffline:
		onlineIDs := params.OnlineAgentIDs
		if onlineIDs == nil {
			onlineIDs = []string{}
		}
		encoded, marshalErr := json.Marshal(onlineIDs)
		if marshalErr != nil {
			return Page{}, fmt.Errorf("encode online agent ids: %w", marshalErr)
		}
		filterArg = string(encoded)
		if filter == StatusOnline {
			whereClause = ` WHERE a.agent_id IN (
				SELECT CAST(value AS TEXT) FROM json_each(?)
			)`
		} else {
			whereClause = ` WHERE a.agent_id NOT IN (
				SELECT CAST(value AS TEXT) FROM json_each(?)
			)`
		}
	}

	countQuery := `SELECT COUNT(*) FROM agents AS a` + whereClause
	var total int
	if filter == StatusAll {
		err = s.pool.QueryRow(countQuery).Scan(&total)
	} else {
		err = s.pool.QueryRow(countQuery, filterArg).Scan(&total)
	}
	if err != nil {
		return Page{}, fmt.Errorf("count filtered agents: %w", err)
	}

	listQuery := `SELECT a.agent_id, a.name, a.created_at, a.token_issued_at
		FROM agents AS a` + whereClause +
		` ORDER BY a.created_at, a.agent_id LIMIT ? OFFSET ?`

	var rows *sql.Rows
	if filter == StatusAll {
		rows, err = s.pool.Query(listQuery, pageSize, offset)
	} else {
		rows, err = s.pool.Query(listQuery, filterArg, pageSize, offset)
	}
	if err != nil {
		return Page{}, fmt.Errorf("list filtered agent registry: %w", err)
	}
	defer func() { _ = rows.Close() }()

	entries := make([]DirectoryEntry, 0, pageSize)
	for rows.Next() {
		var entry DirectoryEntry
		var registeredAt int64
		var tokenCreatedAt sql.NullInt64
		if err := rows.Scan(&entry.AgentID, &entry.Name, &registeredAt, &tokenCreatedAt); err != nil {
			return Page{}, fmt.Errorf("scan agent directory: %w", err)
		}
		entry.RegisteredAt = time.Unix(registeredAt, 0).UTC()
		entry.HasToken = tokenCreatedAt.Valid
		if tokenCreatedAt.Valid {
			entry.TokenCreatedAt = time.Unix(tokenCreatedAt.Int64, 0).UTC()
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return Page{}, fmt.Errorf("iterate agent directory: %w", err)
	}

	return Page{
		Entries:  entries,
		Total:    total,
		Page:     page,
		PageSize: pageSize,
		HasMore:  offset+len(entries) < total,
	}, nil
}

// Registered 返回全部持久化 Agent（agent_id 序），供 WS Agent 选择器补全离线项；
// 管理页面的大目录展示必须走数据库分页的 List。
func (s *Store) Registered() ([]DirectoryEntry, error) {
	if s == nil {
		return nil, errors.New("agent registry is not enabled")
	}
	rows, err := s.pool.Query(`SELECT agent_id, name, created_at FROM agents ORDER BY agent_id`)
	if err != nil {
		return nil, fmt.Errorf("query agent directory: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []DirectoryEntry
	for rows.Next() {
		var entry DirectoryEntry
		var createdAt int64
		if err := rows.Scan(&entry.AgentID, &entry.Name, &createdAt); err != nil {
			return nil, fmt.Errorf("scan agent directory: %w", err)
		}
		entry.RegisteredAt = time.Unix(createdAt, 0).UTC()
		out = append(out, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate agent directory: %w", err)
	}
	return out, nil
}
