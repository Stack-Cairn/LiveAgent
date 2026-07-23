package handler

import (
	"fmt"
	"strings"

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
}

type ChatUploadedFileBody struct {
	RelativePath string `json:"relative_path"`
	AbsolutePath string `json:"absolute_path,omitempty"`
	FileName     string `json:"file_name"`
	Kind         string `json:"kind"`
	SizeBytes    int64  `json:"size_bytes"`
}

type ChatRequestBody struct {
	ConversationID      string                   `json:"conversation_id"`
	ClientRequestID     string                   `json:"client_request_id,omitempty"`
	Message             string                   `json:"message"`
	SelectedModel       *ChatSelectedModelBody   `json:"selected_model,omitempty"`
	RuntimeControls     *ChatRuntimeControlsBody `json:"runtime_controls,omitempty"`
	ExecutionMode       string                   `json:"execution_mode,omitempty"`
	Workdir             string                   `json:"workdir,omitempty"`
	SelectedSystemTools []string                 `json:"selected_system_tools,omitempty"`
	UploadedFiles       []ChatUploadedFileBody   `json:"uploaded_files,omitempty"`
	QueuePolicy         string                   `json:"queue_policy,omitempty"`
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

var validSystemToolIDs = map[string]struct{}{
	"http_get_test": {},
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
	case "codex", "claude_code", "gemini":
		return selectedModel, nil
	case "":
		return nil, fmt.Errorf("selected_model.provider_type is required")
	default:
		return nil, fmt.Errorf(
			"selected_model.provider_type must be codex, claude_code, or gemini",
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

func NormalizeSelectedSystemTools(input []string) []string {
	out := make([]string, 0, len(input))
	seen := make(map[string]struct{}, len(input))

	for _, item := range input {
		value := normalizeTrimmedText(item)
		if value == "" {
			continue
		}
		if _, ok := validSystemToolIDs[value]; !ok {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}

	return out
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
