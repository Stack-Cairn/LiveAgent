package session

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	_ "modernc.org/sqlite"
)

type ChatEventStore interface {
	StartRun(input ChatRunStoreStart) (ChatRunSnapshot, bool, error)
	AppendEvents(inputs []ChatRunEventAppend) error
	Replay(requestID string, conversationID string, afterSeq int64, limit int) (ChatRunSnapshot, []*ChatBroadcastEvent, bool, error)
	FailOpenRuns(message string) error
	Close() error
}

type ChatRunStoreStart struct {
	RequestID       string
	ConversationID  string
	ClientRequestID string
	Workdir         string
	CreatedAt       time.Time
}

type ChatRunEventAppend struct {
	RequestID       string
	ConversationID  string
	ClientRequestID string
	Workdir         string
	RunEpoch        int64
	State           string
	ErrorCode       string
	Done            bool
	Event           *ChatBroadcastEvent
	CreatedAt       time.Time
}

type sqliteChatEventStore struct {
	db *sql.DB
}

func OpenSQLiteChatEventStore(path string) (ChatEventStore, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("chat event store path is required")
	}
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, fmt.Errorf("create chat event store directory: %w", err)
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)
	store := &sqliteChatEventStore{db: db}
	if err := store.configure(); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := store.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *sqliteChatEventStore) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *sqliteChatEventStore) configure() error {
	if s == nil || s.db == nil {
		return errors.New("chat event store is not open")
	}
	pragmas := []string{
		"PRAGMA busy_timeout = 5000",
		"PRAGMA foreign_keys = ON",
		"PRAGMA journal_mode = WAL",
		"PRAGMA synchronous = NORMAL",
	}
	for _, pragma := range pragmas {
		if _, err := s.db.Exec(pragma); err != nil {
			return fmt.Errorf("configure sqlite chat event store: %w", err)
		}
	}
	return nil
}

func (s *sqliteChatEventStore) migrate() error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS chat_runs (
			run_id TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL DEFAULT '',
			client_request_id TEXT NOT NULL DEFAULT '',
			workdir TEXT NOT NULL DEFAULT '',
			run_epoch INTEGER NOT NULL,
			state TEXT NOT NULL,
			error_code TEXT NOT NULL DEFAULT '',
			done INTEGER NOT NULL DEFAULT 0,
			latest_seq INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS chat_command_dedup (
			client_request_id TEXT PRIMARY KEY,
			run_id TEXT NOT NULL,
			conversation_id TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS chat_events (
			event_id TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL DEFAULT '',
			run_id TEXT NOT NULL,
			client_request_id TEXT NOT NULL DEFAULT '',
			type TEXT NOT NULL,
			seq INTEGER NOT NULL,
			payload_json TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			UNIQUE(run_id, seq)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_runs_conversation_updated ON chat_runs(conversation_id, updated_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_events_run_seq ON chat_events(run_id, seq)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_events_conversation_seq ON chat_events(conversation_id, seq)`,
	}
	for _, statement := range statements {
		if _, err := s.db.Exec(statement); err != nil {
			return fmt.Errorf("migrate sqlite chat event store: %w", err)
		}
	}
	return nil
}

func (s *sqliteChatEventStore) StartRun(input ChatRunStoreStart) (ChatRunSnapshot, bool, error) {
	if s == nil || s.db == nil {
		return ChatRunSnapshot{}, false, errors.New("chat event store is not open")
	}
	input.RequestID = strings.TrimSpace(input.RequestID)
	input.ConversationID = strings.TrimSpace(input.ConversationID)
	input.ClientRequestID = strings.TrimSpace(input.ClientRequestID)
	input.Workdir = strings.TrimSpace(input.Workdir)
	if input.RequestID == "" {
		return ChatRunSnapshot{}, false, ErrChatRunNotFound
	}
	now := input.CreatedAt
	if now.IsZero() {
		now = time.Now()
	}
	nowMs := now.UnixMilli()

	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ChatRunSnapshot{}, false, err
	}
	defer rollbackUnlessCommitted(tx)

	if input.ClientRequestID != "" {
		snapshot, ok, err := s.lookupRunByClientRequestTx(ctx, tx, input.ClientRequestID)
		if err != nil {
			return ChatRunSnapshot{}, false, err
		}
		if ok {
			if err := tx.Commit(); err != nil {
				return ChatRunSnapshot{}, false, err
			}
			return snapshot, false, nil
		}
	}

	snapshot, ok, err := s.lookupRunByIDTx(ctx, tx, input.RequestID)
	if err != nil {
		return ChatRunSnapshot{}, false, err
	}
	if ok {
		if err := tx.Commit(); err != nil {
			return ChatRunSnapshot{}, false, err
		}
		return snapshot, false, nil
	}

	runEpoch, err := nextChatRunEpochTx(ctx, tx)
	if err != nil {
		return ChatRunSnapshot{}, false, err
	}
	latestSeq, err := latestConversationSeqTx(ctx, tx, input.ConversationID)
	if err != nil {
		return ChatRunSnapshot{}, false, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO chat_runs (
			run_id, conversation_id, client_request_id, workdir, run_epoch,
			state, error_code, done, latest_seq, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, '', 0, ?, ?, ?)
	`, input.RequestID, input.ConversationID, input.ClientRequestID, input.Workdir, runEpoch, ChatRunStateQueued, latestSeq, nowMs, nowMs); err != nil {
		return ChatRunSnapshot{}, false, err
	}
	if input.ClientRequestID != "" {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO chat_command_dedup (client_request_id, run_id, conversation_id, created_at)
			VALUES (?, ?, ?, ?)
		`, input.ClientRequestID, input.RequestID, input.ConversationID, nowMs); err != nil {
			return ChatRunSnapshot{}, false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return ChatRunSnapshot{}, false, err
	}
	return ChatRunSnapshot{
		RequestID:       input.RequestID,
		ConversationID:  input.ConversationID,
		ClientRequestID: input.ClientRequestID,
		Workdir:         input.Workdir,
		RunEpoch:        runEpoch,
		LatestSeq:       latestSeq,
		State:           ChatRunStateQueued,
	}, true, nil
}

func (s *sqliteChatEventStore) AppendEvents(inputs []ChatRunEventAppend) error {
	if s == nil || s.db == nil {
		return nil
	}
	validInputs := make([]ChatRunEventAppend, 0, len(inputs))
	for _, input := range inputs {
		if input.Event == nil || input.Event.Seq <= 0 {
			continue
		}
		input.RequestID = strings.TrimSpace(input.RequestID)
		if input.RequestID == "" {
			continue
		}
		validInputs = append(validInputs, input)
	}
	if len(validInputs) == 0 {
		return nil
	}

	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer rollbackUnlessCommitted(tx)

	for _, input := range validInputs {
		if err := s.appendEventTx(ctx, tx, input); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *sqliteChatEventStore) appendEventTx(
	ctx context.Context,
	tx *sql.Tx,
	input ChatRunEventAppend,
) error {
	input.RequestID = strings.TrimSpace(input.RequestID)
	input.ConversationID = strings.TrimSpace(input.ConversationID)
	input.ClientRequestID = strings.TrimSpace(input.ClientRequestID)
	input.Workdir = strings.TrimSpace(input.Workdir)
	input.State = normalizeChatRunState(input.State)
	input.ErrorCode = strings.TrimSpace(input.ErrorCode)
	if input.RequestID == "" {
		return nil
	}
	payload := storedChatBroadcastPayload(input)
	if len(payload) == 0 {
		return nil
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if input.CreatedAt.IsZero() {
		input.CreatedAt = time.Now()
	}
	createdMs := input.CreatedAt.UnixMilli()
	runID := input.RequestID
	conversationID := input.ConversationID
	clientRequestID := input.ClientRequestID
	workdir := input.Workdir
	eventType, _ := payload["type"].(string)
	eventType = strings.TrimSpace(eventType)
	if eventType == "" {
		eventType = "message"
	}
	doneValue := 0
	if input.Done {
		doneValue = 1
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO chat_runs (
			run_id, conversation_id, client_request_id, workdir, run_epoch,
			state, error_code, done, latest_seq, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(run_id) DO UPDATE SET
			conversation_id = excluded.conversation_id,
			client_request_id = excluded.client_request_id,
			workdir = excluded.workdir,
			run_epoch = excluded.run_epoch,
			state = excluded.state,
			error_code = excluded.error_code,
			done = excluded.done,
			latest_seq = max(chat_runs.latest_seq, excluded.latest_seq),
			updated_at = excluded.updated_at
	`, runID, conversationID, clientRequestID, workdir, input.RunEpoch, input.State, input.ErrorCode, doneValue, input.Event.Seq, createdMs, createdMs); err != nil {
		return err
	}
	if clientRequestID != "" {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO chat_command_dedup (client_request_id, run_id, conversation_id, created_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(client_request_id) DO NOTHING
		`, clientRequestID, runID, conversationID, createdMs); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO chat_events (
			event_id, conversation_id, run_id, client_request_id, type, seq, payload_json, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(run_id, seq) DO NOTHING
	`, fmt.Sprintf("%s/%d", runID, input.Event.Seq), conversationID, runID, clientRequestID, eventType, input.Event.Seq, string(payloadJSON), createdMs); err != nil {
		return err
	}
	return nil
}

func (s *sqliteChatEventStore) Replay(
	requestID string,
	conversationID string,
	afterSeq int64,
	limit int,
) (ChatRunSnapshot, []*ChatBroadcastEvent, bool, error) {
	if s == nil || s.db == nil {
		return ChatRunSnapshot{}, nil, false, errors.New("chat event store is not open")
	}
	if afterSeq < 0 {
		afterSeq = 0
	}
	if limit <= 0 {
		limit = maxBufferedChatRunEvents
	}

	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return ChatRunSnapshot{}, nil, false, err
	}
	defer rollbackUnlessCommitted(tx)

	snapshot, ok, err := s.lookupRunTx(ctx, tx, requestID, conversationID)
	if err != nil || !ok {
		return ChatRunSnapshot{}, nil, ok, err
	}
	var rows *sql.Rows
	if strings.TrimSpace(requestID) == "" && strings.TrimSpace(conversationID) != "" {
		rows, err = tx.QueryContext(ctx, `
			SELECT e.run_id, e.seq, e.payload_json, COALESCE(r.workdir, '')
			FROM chat_events e
			LEFT JOIN chat_runs r ON r.run_id = e.run_id
			WHERE e.conversation_id = ? AND e.seq > ?
			ORDER BY e.seq ASC
			LIMIT ?
		`, snapshot.ConversationID, afterSeq, limit)
	} else {
		rows, err = tx.QueryContext(ctx, `
			SELECT e.run_id, e.seq, e.payload_json, COALESCE(r.workdir, '')
			FROM chat_events e
			LEFT JOIN chat_runs r ON r.run_id = e.run_id
			WHERE e.run_id = ? AND e.seq > ?
			ORDER BY e.seq ASC
			LIMIT ?
		`, snapshot.RequestID, afterSeq, limit)
	}
	if err != nil {
		return ChatRunSnapshot{}, nil, false, err
	}
	defer rows.Close()

	events := make([]*ChatBroadcastEvent, 0)
	for rows.Next() {
		var runID string
		var seq int64
		var payloadJSON string
		var workdir string
		if err := rows.Scan(&runID, &seq, &payloadJSON, &workdir); err != nil {
			return ChatRunSnapshot{}, nil, false, err
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
			return ChatRunSnapshot{}, nil, false, err
		}
		events = append(events, &ChatBroadcastEvent{
			RequestID: strings.TrimSpace(runID),
			Payload:   payload,
			Seq:       seq,
			Workdir:   strings.TrimSpace(workdir),
		})
	}
	if err := rows.Err(); err != nil {
		return ChatRunSnapshot{}, nil, false, err
	}
	if err := tx.Commit(); err != nil {
		return ChatRunSnapshot{}, nil, false, err
	}
	return snapshot, events, true, nil
}

func (s *sqliteChatEventStore) FailOpenRuns(message string) error {
	if s == nil || s.db == nil {
		return nil
	}
	message = strings.TrimSpace(message)
	if message == "" {
		message = "Gateway restarted before the remote chat run finished. Please retry."
	}
	now := time.Now()
	nowMs := now.UnixMilli()

	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer rollbackUnlessCommitted(tx)

	rows, err := tx.QueryContext(ctx, `
		SELECT run_id, conversation_id, client_request_id, workdir, run_epoch, latest_seq
		FROM chat_runs
		WHERE done = 0
	`)
	if err != nil {
		return err
	}
	type openRun struct {
		runID           string
		conversationID  string
		clientRequestID string
		workdir         string
		runEpoch        int64
		latestSeq       int64
	}
	openRuns := make([]openRun, 0)
	for rows.Next() {
		var run openRun
		if err := rows.Scan(&run.runID, &run.conversationID, &run.clientRequestID, &run.workdir, &run.runEpoch, &run.latestSeq); err != nil {
			_ = rows.Close()
			return err
		}
		openRuns = append(openRuns, run)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}

	for _, run := range openRuns {
		seq := run.latestSeq + 1
		payload := map[string]any{
			"type":              "failed",
			"request_id":        run.runID,
			"client_request_id": run.clientRequestID,
			"conversation_id":   run.conversationID,
			"run_epoch":         run.runEpoch,
			"state":             ChatRunStateFailed,
			"error_code":        "gateway_restarted",
			"message":           message,
			"seq":               seq,
		}
		if run.workdir != "" {
			payload["workdir"] = run.workdir
		}
		payloadJSON, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO chat_events (
				event_id, conversation_id, run_id, client_request_id, type, seq, payload_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(run_id, seq) DO NOTHING
		`, fmt.Sprintf("%s/%d", run.runID, seq), run.conversationID, run.runID, run.clientRequestID, "failed", seq, string(payloadJSON), nowMs); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE chat_runs
			SET state = ?, error_code = ?, done = 1, latest_seq = max(latest_seq, ?), updated_at = ?
			WHERE run_id = ?
		`, ChatRunStateFailed, "gateway_restarted", seq, nowMs, run.runID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *sqliteChatEventStore) lookupRunByClientRequestTx(
	ctx context.Context,
	tx *sql.Tx,
	clientRequestID string,
) (ChatRunSnapshot, bool, error) {
	clientRequestID = strings.TrimSpace(clientRequestID)
	if clientRequestID == "" {
		return ChatRunSnapshot{}, false, nil
	}
	var runID string
	err := tx.QueryRowContext(ctx, `
		SELECT run_id FROM chat_command_dedup WHERE client_request_id = ?
	`, clientRequestID).Scan(&runID)
	if errors.Is(err, sql.ErrNoRows) {
		return ChatRunSnapshot{}, false, nil
	}
	if err != nil {
		return ChatRunSnapshot{}, false, err
	}
	snapshot, ok, err := s.lookupRunByIDTx(ctx, tx, runID)
	if err != nil || ok {
		return snapshot, ok, err
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM chat_command_dedup WHERE client_request_id = ?
	`, clientRequestID); err != nil {
		return ChatRunSnapshot{}, false, err
	}
	return ChatRunSnapshot{}, false, nil
}

func (s *sqliteChatEventStore) lookupRunByIDTx(
	ctx context.Context,
	tx *sql.Tx,
	requestID string,
) (ChatRunSnapshot, bool, error) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return ChatRunSnapshot{}, false, nil
	}
	return scanChatRunSnapshot(tx.QueryRowContext(ctx, chatRunSnapshotSQL(`r.run_id = ?`), requestID))
}

func (s *sqliteChatEventStore) lookupRunTx(
	ctx context.Context,
	tx *sql.Tx,
	requestID string,
	conversationID string,
) (ChatRunSnapshot, bool, error) {
	requestID = strings.TrimSpace(requestID)
	conversationID = strings.TrimSpace(conversationID)
	if requestID != "" {
		return s.lookupRunByIDTx(ctx, tx, requestID)
	}
	if conversationID == "" {
		return ChatRunSnapshot{}, false, nil
	}
	return scanChatRunSnapshot(tx.QueryRowContext(ctx, chatRunSnapshotSQL(`r.conversation_id = ? ORDER BY r.updated_at DESC LIMIT 1`), conversationID))
}

func chatRunSnapshotSQL(where string) string {
	return fmt.Sprintf(`
		SELECT
			r.run_id,
			r.conversation_id,
			r.client_request_id,
			r.workdir,
			COALESCE((SELECT MIN(e.seq) FROM chat_events e WHERE e.run_id = r.run_id), 0) AS first_seq,
			r.latest_seq,
			r.run_epoch,
			r.state,
			r.error_code,
			r.done
		FROM chat_runs r
		WHERE %s
	`, where)
}

type chatRunSnapshotScanner interface {
	Scan(dest ...any) error
}

func scanChatRunSnapshot(row chatRunSnapshotScanner) (ChatRunSnapshot, bool, error) {
	var snapshot ChatRunSnapshot
	var done int
	err := row.Scan(
		&snapshot.RequestID,
		&snapshot.ConversationID,
		&snapshot.ClientRequestID,
		&snapshot.Workdir,
		&snapshot.FirstSeq,
		&snapshot.LatestSeq,
		&snapshot.RunEpoch,
		&snapshot.State,
		&snapshot.ErrorCode,
		&done,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return ChatRunSnapshot{}, false, nil
	}
	if err != nil {
		return ChatRunSnapshot{}, false, err
	}
	snapshot.State = normalizeChatRunState(snapshot.State)
	snapshot.Done = done != 0 || isTerminalChatRunState(snapshot.State)
	return snapshot, true, nil
}

func nextChatRunEpochTx(ctx context.Context, tx *sql.Tx) (int64, error) {
	var epoch int64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(run_epoch), 0) + 1 FROM chat_runs`).Scan(&epoch); err != nil {
		return 0, err
	}
	return epoch, nil
}

func latestConversationSeqTx(ctx context.Context, tx *sql.Tx, conversationID string) (int64, error) {
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return 0, nil
	}
	var latestSeq int64
	if err := tx.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(seq), 0)
		FROM chat_events
		WHERE conversation_id = ?
	`, conversationID).Scan(&latestSeq); err != nil {
		return 0, err
	}
	return latestSeq, nil
}

func rollbackUnlessCommitted(tx *sql.Tx) {
	if tx != nil {
		_ = tx.Rollback()
	}
}

func storedChatBroadcastPayload(input ChatRunEventAppend) map[string]any {
	event := input.Event
	if event == nil {
		return nil
	}
	var payload map[string]any
	switch {
	case len(event.Payload) > 0:
		payload = cloneChatPayloadMap(event.Payload)
	case event.Control != nil:
		payload = storedChatControlPayload(event.Control)
	case event.Event != nil:
		payload = storedChatEventPayload(event.Event)
	default:
		payload = make(map[string]any)
	}
	if payload == nil {
		payload = make(map[string]any)
	}
	payload["request_id"] = strings.TrimSpace(input.RequestID)
	payload["client_request_id"] = strings.TrimSpace(input.ClientRequestID)
	payload["conversation_id"] = strings.TrimSpace(input.ConversationID)
	payload["run_epoch"] = input.RunEpoch
	payload["state"] = normalizeChatRunState(input.State)
	payload["seq"] = event.Seq
	if workdir := strings.TrimSpace(input.Workdir); workdir != "" {
		payload["workdir"] = workdir
	}
	if eventType, _ := payload["type"].(string); strings.TrimSpace(eventType) == "" {
		payload["type"] = "message"
	} else {
		payload["type"] = strings.TrimSpace(eventType)
	}
	return payload
}

func storedChatControlPayload(control *gatewayv1.ChatControlEvent) map[string]any {
	payload := map[string]any{
		"type":              strings.TrimSpace(control.GetType()),
		"request_id":        strings.TrimSpace(control.GetRequestId()),
		"client_request_id": strings.TrimSpace(control.GetClientRequestId()),
		"conversation_id":   strings.TrimSpace(control.GetConversationId()),
		"run_epoch":         control.GetRunEpoch(),
		"state":             strings.TrimSpace(control.GetState()),
	}
	if seq := control.GetSeq(); seq > 0 {
		payload["seq"] = seq
	}
	if errorCode := strings.TrimSpace(control.GetErrorCode()); errorCode != "" {
		payload["error_code"] = errorCode
	}
	if message := strings.TrimSpace(control.GetMessage()); message != "" {
		payload["message"] = message
	}
	return payload
}

func storedChatEventPayload(event *gatewayv1.ChatEvent) map[string]any {
	payload := map[string]any{
		"type": storedChatEventType(event.GetType()),
	}
	raw := strings.TrimSpace(event.GetData())
	if raw != "" {
		var decoded map[string]any
		if err := json.Unmarshal([]byte(raw), &decoded); err == nil {
			for key, value := range decoded {
				payload[key] = value
			}
		}
	}
	if conversationID := strings.TrimSpace(event.GetConversationId()); conversationID != "" {
		payload["conversation_id"] = conversationID
	}
	return payload
}

func storedChatEventType(eventType gatewayv1.ChatEvent_ChatEventType) string {
	switch eventType {
	case gatewayv1.ChatEvent_TOKEN:
		return "token"
	case gatewayv1.ChatEvent_THINKING:
		return "thinking"
	case gatewayv1.ChatEvent_TOOL_CALL:
		return "tool_call"
	case gatewayv1.ChatEvent_TOOL_RESULT:
		return "tool_result"
	case gatewayv1.ChatEvent_DONE:
		return "done"
	case gatewayv1.ChatEvent_ERROR:
		return "error"
	case gatewayv1.ChatEvent_TOOL_STATUS:
		return "tool_status"
	case gatewayv1.ChatEvent_HOSTED_SEARCH:
		return "hosted_search"
	default:
		return "message"
	}
}
