package server

import (
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"strings"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

func websocketProtoPayload(message proto.Message, useProtoNames bool) map[string]any {
	if isNilProtoMessage(message) {
		return nil
	}
	raw, err := protojson.MarshalOptions{
		UseProtoNames:   useProtoNames,
		EmitUnpopulated: true,
	}.Marshal(message)
	if err != nil {
		return map[string]any{}
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return map[string]any{}
	}
	coerceProtoJSONNumbers(payload, message.ProtoReflect().Descriptor(), useProtoNames)
	return payload
}

func isNilProtoMessage(message proto.Message) bool {
	if message == nil {
		return true
	}
	value := reflect.ValueOf(message)
	return value.Kind() == reflect.Pointer && value.IsNil()
}

func coerceProtoJSONNumbers(payload map[string]any, descriptor protoreflect.MessageDescriptor, useProtoNames bool) {
	if payload == nil || descriptor == nil {
		return
	}
	fields := descriptor.Fields()
	for i := 0; i < fields.Len(); i++ {
		field := fields.Get(i)
		key := field.JSONName()
		if useProtoNames {
			key = field.TextName()
		}
		value, ok := payload[key]
		if !ok {
			continue
		}
		payload[key] = coerceProtoJSONField(value, field, useProtoNames)
	}
}

func coerceProtoJSONField(value any, field protoreflect.FieldDescriptor, useProtoNames bool) any {
	if field == nil || value == nil {
		return value
	}
	if field.IsList() {
		items, ok := value.([]any)
		if !ok {
			return value
		}
		for i, item := range items {
			items[i] = coerceProtoJSONScalarOrMessage(item, field, useProtoNames)
		}
		return items
	}
	return coerceProtoJSONScalarOrMessage(value, field, useProtoNames)
}

func coerceProtoJSONScalarOrMessage(value any, field protoreflect.FieldDescriptor, useProtoNames bool) any {
	if field.Kind() == protoreflect.MessageKind || field.Kind() == protoreflect.GroupKind {
		if nested, ok := value.(map[string]any); ok {
			coerceProtoJSONNumbers(nested, field.Message(), useProtoNames)
		}
		return value
	}
	switch field.Kind() {
	case protoreflect.Int32Kind, protoreflect.Sint32Kind, protoreflect.Sfixed32Kind:
		if number, ok := value.(float64); ok {
			return int32(number)
		}
	case protoreflect.Uint32Kind, protoreflect.Fixed32Kind:
		if number, ok := value.(float64); ok {
			return uint32(number)
		}
	case protoreflect.Int64Kind, protoreflect.Sint64Kind, protoreflect.Sfixed64Kind:
		if text, ok := value.(string); ok {
			if parsed, err := strconv.ParseInt(text, 10, 64); err == nil {
				return parsed
			}
		}
	case protoreflect.Uint64Kind, protoreflect.Fixed64Kind:
		if text, ok := value.(string); ok {
			if parsed, err := strconv.ParseUint(text, 10, 64); err == nil {
				return parsed
			}
		}
	}
	return value
}

func websocketConversationSummaryPayload(conversation *gatewayv1.ConversationSummary) map[string]any {
	return websocketProtoPayload(conversation, true)
}

func websocketActiveChatRunSummariesPayload(summaries []session.ActiveChatRunSummary) []map[string]any {
	payload := make([]map[string]any, 0, len(summaries))
	for _, summary := range summaries {
		conversationID := strings.TrimSpace(summary.ConversationID)
		if conversationID == "" {
			continue
		}
		item := map[string]any{
			"conversation_id": conversationID,
			"cwd":             strings.TrimSpace(summary.Workdir),
			"updated_at":      summary.UpdatedAt,
		}
		if requestID := strings.TrimSpace(summary.RequestID); requestID != "" {
			item["run_id"] = requestID
		}
		if summary.FirstSeq > 0 {
			item["first_seq"] = summary.FirstSeq
		}
		if summary.LatestSeq > 0 {
			item["latest_seq"] = summary.LatestSeq
		}
		if summary.RunEpoch > 0 {
			item["run_epoch"] = summary.RunEpoch
		}
		payload = append(payload, item)
	}
	return payload
}

func websocketHistoryShareStatusPayload(share *gatewayv1.HistoryShareStatus) map[string]any {
	return websocketProtoPayload(share, true)
}

func websocketHistorySyncPayload(event *gatewayv1.HistorySyncEvent) map[string]any {
	payload := map[string]any{
		"kind":            strings.TrimSpace(event.GetKind()),
		"conversation_id": strings.TrimSpace(event.GetConversationId()),
	}

	if conversation := event.GetConversation(); conversation != nil {
		payload["conversation"] = websocketConversationSummaryPayload(conversation)
	}

	return payload
}

func websocketSettingsSyncPayload(event *gatewayv1.SettingsSyncEvent) (map[string]any, error) {
	return websocketSettingsJSONPayload(event.GetSettingsJson())
}

func websocketSettingsJSONPayload(raw string) (map[string]any, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return map[string]any{}, nil
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
		return nil, errors.New("gateway settings payload is not valid JSON")
	}
	if payload == nil {
		return map[string]any{}, nil
	}
	return payload, nil
}

func websocketTerminalSessionPayload(session *gatewayv1.TerminalSession) map[string]any {
	if session == nil {
		return nil
	}
	kind := terminalSessionKind(session)
	payload := map[string]any{
		"id":               strings.TrimSpace(session.GetId()),
		"project_path_key": strings.TrimSpace(session.GetProjectPathKey()),
		"cwd":              strings.TrimSpace(session.GetCwd()),
		"shell":            strings.TrimSpace(session.GetShell()),
		"title":            strings.TrimSpace(session.GetTitle()),
		"kind":             kind,
		"pid":              session.GetPid(),
		"cols":             session.GetCols(),
		"rows":             session.GetRows(),
		"created_at":       session.GetCreatedAt(),
		"updated_at":       session.GetUpdatedAt(),
		"finished_at":      session.GetFinishedAt(),
		"exit_code":        session.GetExitCode(),
		"running":          session.GetRunning(),
	}
	if session.GetPid() == 0 {
		payload["pid"] = nil
	}
	if session.GetFinishedAt() == 0 {
		payload["finished_at"] = nil
	}
	if kind == "ssh" {
		payload["pid"] = nil
	}
	if ssh := session.GetSsh(); ssh != nil {
		payload["ssh"] = map[string]any{
			"host_id":                strings.TrimSpace(ssh.GetHostId()),
			"host_name":              strings.TrimSpace(ssh.GetHostName()),
			"username":               strings.TrimSpace(ssh.GetUsername()),
			"host":                   strings.TrimSpace(ssh.GetHost()),
			"port":                   ssh.GetPort(),
			"auth_type":              strings.TrimSpace(ssh.GetAuthType()),
			"status":                 strings.TrimSpace(ssh.GetStatus()),
			"reconnect_attempt":      ssh.GetReconnectAttempt(),
			"reconnect_max_attempts": ssh.GetReconnectMaxAttempts(),
			"sftp_enabled":           ssh.GetSftpEnabled(),
			"sftpEnabled":            ssh.GetSftpEnabled(),
		}
	}
	return payload
}

func terminalSessionKind(session *gatewayv1.TerminalSession) string {
	kind := strings.TrimSpace(session.GetKind())
	if kind == "ssh" {
		return "ssh"
	}
	return "local"
}

func websocketTerminalShellOptionPayload(option *gatewayv1.TerminalShellOption) map[string]any {
	payload := websocketProtoPayload(option, false)
	if payload == nil {
		return nil
	}
	payload["id"] = strings.TrimSpace(option.GetId())
	payload["label"] = strings.TrimSpace(option.GetLabel())
	payload["command"] = strings.TrimSpace(option.GetCommand())
	return payload
}

func websocketTerminalResponsePayload(resp *gatewayv1.TerminalResponse) map[string]any {
	sessions := make([]map[string]any, 0, len(resp.GetSessions()))
	for _, session := range resp.GetSessions() {
		if payload := websocketTerminalSessionPayload(session); payload != nil {
			sessions = append(sessions, payload)
		}
	}
	shellOptions := make([]map[string]any, 0, len(resp.GetShellOptions()))
	for _, option := range resp.GetShellOptions() {
		if payload := websocketTerminalShellOptionPayload(option); payload != nil {
			shellOptions = append(shellOptions, payload)
		}
	}
	payload := map[string]any{
		"action":        strings.TrimSpace(resp.GetAction()),
		"sessions":      sessions,
		"output":        resp.GetOutput(),
		"truncated":     resp.GetTruncated(),
		"shell_options": shellOptions,
		"default_shell": resp.GetDefaultShell(),
	}
	if resp.GetOutputStartOffset() != 0 || resp.GetOutputEndOffset() != 0 || resp.GetOutput() != "" {
		payload["output_start_offset"] = resp.GetOutputStartOffset()
		payload["output_end_offset"] = resp.GetOutputEndOffset()
	}
	if resp.GetLatencyMs() > 0 {
		payload["latency_ms"] = resp.GetLatencyMs()
	}
	if session := websocketTerminalSessionPayload(resp.GetSession()); session != nil {
		payload["session"] = session
	}
	if prompt := resp.GetSshPrompt(); prompt != nil {
		payload["ssh_prompt"] = map[string]any{
			"id":                 strings.TrimSpace(prompt.GetId()),
			"kind":               strings.TrimSpace(prompt.GetKind()),
			"host_id":            strings.TrimSpace(prompt.GetHostId()),
			"host_name":          strings.TrimSpace(prompt.GetHostName()),
			"host":               strings.TrimSpace(prompt.GetHost()),
			"port":               prompt.GetPort(),
			"message":            strings.TrimSpace(prompt.GetMessage()),
			"fingerprint_sha256": strings.TrimSpace(prompt.GetFingerprintSha256()),
			"key_type":           strings.TrimSpace(prompt.GetKeyType()),
			"answer_echo":        prompt.GetAnswerEcho(),
		}
	}
	return payload
}

func websocketTerminalEventPayload(event *gatewayv1.TerminalEvent) map[string]any {
	payload := map[string]any{
		"kind":             strings.TrimSpace(event.GetKind()),
		"session_id":       strings.TrimSpace(event.GetSessionId()),
		"project_path_key": strings.TrimSpace(event.GetProjectPathKey()),
		"data":             event.GetData(),
	}
	if event.GetOutputStartOffset() != 0 || event.GetOutputEndOffset() != 0 || event.GetData() != "" {
		payload["output_start_offset"] = event.GetOutputStartOffset()
		payload["output_end_offset"] = event.GetOutputEndOffset()
	}
	if session := websocketTerminalSessionPayload(event.GetSession()); session != nil {
		payload["session"] = session
	}
	return payload
}

func websocketMemoryResultPayload(raw string) (any, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return map[string]any{}, nil
	}

	var payload any
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
		return nil, errors.New("gateway memory response is not valid JSON")
	}
	if payload == nil {
		return map[string]any{}, nil
	}
	return payload, nil
}

func websocketGitResultPayload(raw string) (any, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return map[string]any{}, nil
	}
	var payload any
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
		return nil, errors.New("gateway git response is not valid JSON")
	}
	if payload == nil {
		return map[string]any{}, nil
	}
	return payload, nil
}

func websocketRawPayloadJSON(raw json.RawMessage) (string, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return "{}", nil
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
		return "", errors.New("invalid settings.update payload")
	}
	if payload == nil {
		return "{}", nil
	}

	normalized, err := json.Marshal(payload)
	if err != nil {
		return "", errors.New("invalid settings.update payload")
	}
	return string(normalized), nil
}

func nullableTrimmedString(value string) any {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

func websocketOptionalUint32(value *int, field string) (uint32, error) {
	if value == nil {
		return 0, nil
	}
	if *value < 0 {
		return 0, errors.New(field + " must be >= 0")
	}
	return uint32(*value), nil
}
