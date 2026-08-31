package handler

import (
	"fmt"
	"strings"
	"unicode"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

type ChatSelectedModelBody struct {
	CustomProviderID string `json:"custom_provider_id"`
	Model            string `json:"model"`
	ProviderType     string `json:"provider_type"`
}

type ChatRuntimeControlsBody struct {
	ThinkingEnabled        *bool  `json:"thinking_enabled,omitempty"`
	NativeWebSearchEnabled *bool  `json:"native_web_search_enabled,omitempty"`
	Reasoning              string `json:"reasoning"`
	// Plan mode 是限制性开关:缺省按 false 归一(桌面端"只能收紧"合并,false
	// 不会关闭本地已开启的 plan mode),与 thinking/webSearch 的缺省 true 相反。
	PlanModeEnabled *bool `json:"plan_mode_enabled,omitempty"`
}

type ChatUploadedFileBody struct {
	RelativePath string `json:"relative_path"`
	AbsolutePath string `json:"absolute_path,omitempty"`
	FileName     string `json:"file_name"`
	Kind         string `json:"kind"`
	SizeBytes    int64  `json:"size_bytes"`
}

type ChatConversationReferenceBody struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Cwd       string `json:"cwd,omitempty"`
	UpdatedAt int64  `json:"updated_at,omitempty"`
}

type ChatRequestBody struct {
	ConversationID          string                          `json:"conversation_id"`
	ClientRequestID         string                          `json:"client_request_id,omitempty"`
	Message                 string                          `json:"message"`
	SelectedModel           *ChatSelectedModelBody          `json:"selected_model,omitempty"`
	RuntimeControls         *ChatRuntimeControlsBody        `json:"runtime_controls,omitempty"`
	ExecutionMode           string                          `json:"execution_mode,omitempty"`
	Workdir                 string                          `json:"workdir,omitempty"`
	CommandSafetyMode       string                          `json:"command_safety_mode,omitempty"`
	UploadedFiles           []ChatUploadedFileBody          `json:"uploaded_files,omitempty"`
	ReferencedConversations []ChatConversationReferenceBody `json:"referenced_conversations,omitempty"`
	QueuePolicy             string                          `json:"queue_policy,omitempty"`
}

type CancelChatRequestBody struct {
	ConversationID string `json:"conversation_id"`
}

type UploadedImagePreviewRequestBody struct {
	Workdir      string `json:"workdir"`
	AbsolutePath string `json:"absolute_path"`
}

type CronManageRequestBody struct {
	Action   string `json:"action"`
	TaskID   string `json:"task_id"`
	TaskJSON string `json:"task_json"`
}

type ProviderModelsRequestBody struct {
	Type           string `json:"type"`
	BaseURL        string `json:"base_url"`
	APIKey         string `json:"api_key"`
	UseSystemProxy bool   `json:"use_system_proxy"`
}

func boolPtr(value bool) *bool {
	return &value
}

func boolValue(input *bool, fallback bool) bool {
	if input == nil {
		return fallback
	}
	return *input
}

func NormalizeChatSelectedModel(
	input *ChatSelectedModelBody,
) (*ChatSelectedModelBody, error) {
	if input == nil {
		return nil, nil
	}

	selectedModel := &ChatSelectedModelBody{
		CustomProviderID: normalizeTrimmedText(input.CustomProviderID),
		Model:            normalizeTrimmedText(input.Model),
		ProviderType:     normalizeTrimmedText(input.ProviderType),
	}

	if selectedModel.CustomProviderID == "" {
		return nil, fmt.Errorf("selected_model.custom_provider_id is required")
	}
	if selectedModel.Model == "" {
		return nil, fmt.Errorf("selected_model.model is required")
	}

	switch selectedModel.ProviderType {
	case "codex", "claude_code", "gemini", "xai", "deepseek":
		return selectedModel, nil
	case "":
		return nil, fmt.Errorf("selected_model.provider_type is required")
	default:
		return nil, fmt.Errorf(
			"selected_model.provider_type must be codex, claude_code, gemini, xai, or deepseek",
		)
	}
}

func NormalizeChatRuntimeControls(input *ChatRuntimeControlsBody) *ChatRuntimeControlsBody {
	if input == nil {
		return nil
	}

	return &ChatRuntimeControlsBody{
		ThinkingEnabled:        boolPtr(boolValue(input.ThinkingEnabled, true)),
		NativeWebSearchEnabled: boolPtr(boolValue(input.NativeWebSearchEnabled, true)),
		Reasoning:              normalizeChatRuntimeReasoning(input.Reasoning),
		PlanModeEnabled:        boolPtr(boolValue(input.PlanModeEnabled, false)),
	}
}

func normalizeChatRuntimeReasoning(value string) string {
	switch normalizeTrimmedText(value) {
	case "minimal", "low", "medium", "high", "xhigh", "max":
		return normalizeTrimmedText(value)
	default:
		return "high"
	}
}

func normalizeTrimmedText(value string) string {
	return strings.TrimSpace(value)
}

func NormalizeExecutionMode(value string) string {
	normalized := normalizeTrimmedText(value)
	switch normalized {
	case "tools", "agent-dev":
		return normalized
	default:
		return "text"
	}
}

func NormalizeWorkdir(value string) string {
	return normalizeTrimmedText(value)
}

// NormalizeCommandSafetyMode 归一化命令安全模式。仅放行四个合法值;空串或未知值
// 归为空串,表示"远端未指定",桌面端据此回落到本地 settings.system.commandSafetyMode。
func NormalizeCommandSafetyMode(value string) string {
	switch normalizeTrimmedText(value) {
	case "ask", "auto", "sandbox", "sandboxOffline":
		return normalizeTrimmedText(value)
	default:
		return ""
	}
}

func NormalizeChatUploadedFiles(input []ChatUploadedFileBody) []ChatUploadedFileBody {
	out := make([]ChatUploadedFileBody, 0, len(input))
	seen := make(map[string]struct{}, len(input))

	for _, item := range input {
		relativePath := normalizeTrimmedText(item.RelativePath)
		fileName := normalizeTrimmedText(item.FileName)
		kind := normalizeTrimmedText(item.Kind)
		if relativePath == "" || fileName == "" {
			continue
		}
		switch kind {
		case "text", "image", "pdf", "notebook", "word", "spreadsheet", "archive":
		default:
			continue
		}
		key := relativePath + "\n" + fileName
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, ChatUploadedFileBody{
			RelativePath: relativePath,
			AbsolutePath: normalizeTrimmedText(item.AbsolutePath),
			FileName:     fileName,
			Kind:         kind,
			SizeBytes:    item.SizeBytes,
		})
	}

	return out
}

func NormalizeChatConversationReferences(
	input []ChatConversationReferenceBody,
	currentConversationID string,
) []ChatConversationReferenceBody {
	out := make([]ChatConversationReferenceBody, 0, 3)
	seen := make(map[string]struct{}, len(input))
	currentConversationID = normalizeTrimmedText(currentConversationID)

	for _, item := range input {
		id := normalizeTrimmedText(item.ID)
		title := strings.Join(strings.Fields(item.Title), " ")
		if id == "" || title == "" || id == currentConversationID {
			continue
		}
		idRunes := []rune(id)
		if len(idRunes) > 256 {
			continue
		}
		invalidID := false
		for _, value := range idRunes {
			if unicode.IsControl(value) {
				invalidID = true
				break
			}
		}
		if invalidID {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		titleRunes := []rune(title)
		if len(titleRunes) > 240 {
			title = string(titleRunes[:240])
		}
		out = append(out, ChatConversationReferenceBody{
			ID:        id,
			Title:     title,
			Cwd:       normalizeTrimmedText(item.Cwd),
			UpdatedAt: item.UpdatedAt,
		})
		if len(out) == 3 {
			break
		}
	}

	return out
}

func ToProtoChatSelectedModel(input *ChatSelectedModelBody) *gatewayv2.ChatSelectedModel {
	if input == nil {
		return nil
	}

	return &gatewayv2.ChatSelectedModel{
		CustomProviderId: input.CustomProviderID,
		Model:            input.Model,
		ProviderType:     input.ProviderType,
	}
}

func ToProtoChatRuntimeControls(input *ChatRuntimeControlsBody) *gatewayv2.ChatRuntimeControls {
	if input == nil {
		return nil
	}

	return &gatewayv2.ChatRuntimeControls{
		ThinkingEnabled:        boolValue(input.ThinkingEnabled, true),
		NativeWebSearchEnabled: boolValue(input.NativeWebSearchEnabled, true),
		Reasoning:              normalizeChatRuntimeReasoning(input.Reasoning),
		PlanModeEnabled:        boolValue(input.PlanModeEnabled, false),
	}
}

func ToProtoChatUploadedFiles(input []ChatUploadedFileBody) []*gatewayv2.ChatUploadedFile {
	if len(input) == 0 {
		return nil
	}

	out := make([]*gatewayv2.ChatUploadedFile, 0, len(input))
	for _, item := range input {
		out = append(out, &gatewayv2.ChatUploadedFile{
			RelativePath: item.RelativePath,
			AbsolutePath: item.AbsolutePath,
			FileName:     item.FileName,
			Kind:         item.Kind,
			SizeBytes:    item.SizeBytes,
		})
	}
	return out
}

func ToProtoChatConversationReferences(
	input []ChatConversationReferenceBody,
) []*gatewayv2.ChatConversationReference {
	if len(input) == 0 {
		return nil
	}

	out := make([]*gatewayv2.ChatConversationReference, 0, len(input))
	for _, item := range input {
		out = append(out, &gatewayv2.ChatConversationReference{
			Id:        item.ID,
			Title:     item.Title,
			Cwd:       item.Cwd,
			UpdatedAt: item.UpdatedAt,
		})
	}
	return out
}
