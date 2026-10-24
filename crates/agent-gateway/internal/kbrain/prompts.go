package kbrain

import (
	"encoding/json"
	"errors"
	"strings"
)

type gatewayProjectPrompt struct {
	Prompt   string `json:"prompt"`
	Strategy string `json:"strategy"`
}

func gatewayProjectPrompts(raw json.RawMessage) (map[string]gatewayProjectPrompt, error) {
	var input map[string]json.RawMessage
	if err := json.Unmarshal(raw, &input); err != nil || input == nil || len(input) > 256 {
		return nil, errors.New("projectPrompts must be an object with at most 256 projects")
	}
	out := map[string]gatewayProjectPrompt{}
	for path, item := range input {
		var fields map[string]json.RawMessage
		if strings.TrimSpace(path) == "" || len(path) > 32768 || json.Unmarshal(item, &fields) != nil || fields == nil {
			return nil, errors.New("invalid project prompt")
		}
		for key := range fields {
			if key != "prompt" && key != "strategy" {
				return nil, errors.New("unsupported project prompt field: " + key)
			}
		}
		var value gatewayProjectPrompt
		if json.Unmarshal(item, &value) != nil || (value.Strategy != "append" && value.Strategy != "replace") || len(value.Prompt) > 1<<20 {
			return nil, errors.New("invalid project prompt strategy or content")
		}
		if _, ok := fields["prompt"]; !ok || string(fields["prompt"]) == "null" {
			return nil, errors.New("project prompt must be a string")
		}
		out[path] = value
	}
	return out, nil
}

// Validate the UI projection before any settings domain is persisted.
func gatewayPromptTemplates(raw json.RawMessage) (json.RawMessage, error) {
	var templates []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &templates); err != nil || templates == nil {
		return nil, errors.New("agents must be an array of prompt templates")
	}
	ids := map[string]bool{}
	for _, template := range templates {
		if template == nil {
			return nil, errors.New("prompt template must be an object")
		}
		for key := range template {
			switch key {
			case "id", "name", "description", "prompt", "enabled":
			default:
				return nil, errors.New("unsupported prompt template field: " + key)
			}
		}
		var id string
		for _, key := range []string{"id", "name", "description", "prompt"} {
			var value string
			if err := json.Unmarshal(template[key], &value); err != nil || string(template[key]) == "null" {
				return nil, errors.New("prompt template " + key + " must be a string")
			}
			if key == "id" {
				id = value
			}
		}
		var enabled bool
		if err := json.Unmarshal(template["enabled"], &enabled); err != nil || string(template["enabled"]) == "null" {
			return nil, errors.New("prompt template enabled must be a boolean")
		}
		if id == "" || ids[id] {
			return nil, errors.New("prompt templates require unique nonempty ids")
		}
		ids[id] = true
	}
	return raw, nil
}
