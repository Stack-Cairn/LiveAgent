package handler

import (
	"reflect"
	"testing"
)

func TestNormalizeExecutionMode(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"":          "text",
		" text ":    "text",
		"tools":     "tools",
		"agent-dev": "agent-dev",
		"unknown":   "text",
	}

	for input, want := range cases {
		if got := NormalizeExecutionMode(input); got != want {
			t.Fatalf("NormalizeExecutionMode(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestNormalizeSelectedSystemTools(t *testing.T) {
	t.Parallel()

	got := NormalizeSelectedSystemTools([]string{
		" http_get_test ",
		"http_get_test",
		"",
		"unknown_tool",
	})
	want := []string{"http_get_test"}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("NormalizeSelectedSystemTools() = %#v, want %#v", got, want)
	}
}

func TestNormalizeChatSelectedModelAcceptsGemini(t *testing.T) {
	t.Parallel()

	got, err := NormalizeChatSelectedModel(&ChatSelectedModelBody{
		CustomProviderID: " gemini-provider ",
		Model:            " gemini-3.5-flash ",
		ProviderType:     " gemini ",
	})
	if err != nil {
		t.Fatalf("NormalizeChatSelectedModel() error = %v", err)
	}
	if got.CustomProviderID != "gemini-provider" ||
		got.Model != "gemini-3.5-flash" ||
		got.ProviderType != "gemini" {
		t.Fatalf("NormalizeChatSelectedModel() = %#v", got)
	}
}

func TestNormalizeChatSelectedModelAcceptsXai(t *testing.T) {
	t.Parallel()

	got, err := NormalizeChatSelectedModel(&ChatSelectedModelBody{
		CustomProviderID: " builtin-xai ",
		Model:            " grok-4.5 ",
		ProviderType:     " xai ",
	})
	if err != nil {
		t.Fatalf("NormalizeChatSelectedModel() error = %v", err)
	}
	if got.CustomProviderID != "builtin-xai" ||
		got.Model != "grok-4.5" ||
		got.ProviderType != "xai" {
		t.Fatalf("NormalizeChatSelectedModel() = %#v", got)
	}
}

func TestNormalizeChatSelectedModelRejectsUnknownProviderType(t *testing.T) {
	t.Parallel()

	if _, err := NormalizeChatSelectedModel(&ChatSelectedModelBody{
		CustomProviderID: "provider",
		Model:            "model",
		ProviderType:     "grok",
	}); err == nil {
		t.Fatalf("NormalizeChatSelectedModel() expected error for unknown provider type")
	}
}

func TestNormalizeChatRuntimeControlsDefaultsAndTrims(t *testing.T) {
	t.Parallel()

	got := NormalizeChatRuntimeControls(&ChatRuntimeControlsBody{
		ThinkingEnabled: boolPtr(false),
		Reasoning:       " xhigh ",
	})
	if got == nil {
		t.Fatalf("NormalizeChatRuntimeControls() = nil")
	}
	if *got.ThinkingEnabled != false {
		t.Fatalf("thinking enabled = %v, want false", *got.ThinkingEnabled)
	}
	if *got.NativeWebSearchEnabled != true {
		t.Fatalf("web search enabled = %v, want true default", *got.NativeWebSearchEnabled)
	}
	if got.Reasoning != "xhigh" {
		t.Fatalf("reasoning = %q, want xhigh", got.Reasoning)
	}

	max := NormalizeChatRuntimeControls(&ChatRuntimeControlsBody{
		Reasoning: " max ",
	})
	if max == nil {
		t.Fatalf("NormalizeChatRuntimeControls(max) = nil")
	}
	if max.Reasoning != "max" {
		t.Fatalf("reasoning = %q, want max", max.Reasoning)
	}

	invalid := NormalizeChatRuntimeControls(&ChatRuntimeControlsBody{
		NativeWebSearchEnabled: boolPtr(false),
		Reasoning:              "remote-xhigh",
	})
	if invalid == nil {
		t.Fatalf("NormalizeChatRuntimeControls(invalid) = nil")
	}
	if *invalid.ThinkingEnabled != true {
		t.Fatalf("invalid thinking enabled = %v, want true default", *invalid.ThinkingEnabled)
	}
	if *invalid.NativeWebSearchEnabled != false {
		t.Fatalf("invalid web search enabled = %v, want false", *invalid.NativeWebSearchEnabled)
	}
	if invalid.Reasoning != "high" {
		t.Fatalf("invalid reasoning = %q, want high", invalid.Reasoning)
	}
}

func TestNormalizeChatUploadedFiles(t *testing.T) {
	t.Parallel()

	got := NormalizeChatUploadedFiles([]ChatUploadedFileBody{
		{
			RelativePath: " docs/spec.md ",
			AbsolutePath: " /tmp/docs/spec.md ",
			FileName:     " spec.md ",
			Kind:         "text",
			SizeBytes:    128,
		},
		{
			RelativePath: "docs/spec.md",
			FileName:     "spec.md",
			Kind:         "text",
			SizeBytes:    128,
		},
		{
			RelativePath: "bad.bin",
			FileName:     "bad.bin",
			Kind:         "binary",
			SizeBytes:    64,
		},
		{
			RelativePath: "uploads/report.docx",
			FileName:     "report.docx",
			Kind:         "word",
			SizeBytes:    256,
		},
		{
			RelativePath: "uploads/workbook.xlsx",
			FileName:     "workbook.xlsx",
			Kind:         "spreadsheet",
			SizeBytes:    512,
		},
		{
			RelativePath: "uploads/assets.zip",
			FileName:     "assets.zip",
			Kind:         "archive",
			SizeBytes:    1024,
		},
	})
	want := []ChatUploadedFileBody{
		{
			RelativePath: "docs/spec.md",
			AbsolutePath: "/tmp/docs/spec.md",
			FileName:     "spec.md",
			Kind:         "text",
			SizeBytes:    128,
		},
		{
			RelativePath: "uploads/report.docx",
			FileName:     "report.docx",
			Kind:         "word",
			SizeBytes:    256,
		},
		{
			RelativePath: "uploads/workbook.xlsx",
			FileName:     "workbook.xlsx",
			Kind:         "spreadsheet",
			SizeBytes:    512,
		},
		{
			RelativePath: "uploads/assets.zip",
			FileName:     "assets.zip",
			Kind:         "archive",
			SizeBytes:    1024,
		},
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("NormalizeChatUploadedFiles() = %#v, want %#v", got, want)
	}
}
