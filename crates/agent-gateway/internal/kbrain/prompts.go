package kbrain

import (
	"encoding/json"
	"errors"
)

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
