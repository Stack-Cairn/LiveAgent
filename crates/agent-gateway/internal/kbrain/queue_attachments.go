package kbrain

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Queued messages may outlive the upload cache (including a gateway restart).
// An editor reference names a block of this exact queued item, never a file on disk.
func queuedAttachment(itemID string, index int, block ContentBlock) UploadedFile {
	file := UploadedFile{RelativePath: fmt.Sprintf("queued-content/%s/%d", itemID, index), FileName: block.Filename}
	data := block.FileURL
	switch block.Type {
	case "image":
		file.Kind = "image"
		data = block.ImageURL
		if file.FileName == "" {
			file.FileName = fmt.Sprintf("image-%d", index+1)
		}
	case "file":
		file.Kind = "pdf"
		if file.FileName == "" {
			file.FileName = fmt.Sprintf("attachment-%d.pdf", index+1)
		}
	default:
		file.Kind, file.FileName = "text", fmt.Sprintf("attachment-%d.txt", index+1)
		file.SizeBytes = int64(len(block.Text))
		if name, rest, ok := strings.Cut(strings.TrimPrefix(block.Text, "\n\nAttached file "), ":\n"); ok && strings.HasPrefix(block.Text, "\n\nAttached file ") {
			file.FileName = name
			if fence, body, ok := strings.Cut(rest, "\n"); ok {
				file.SizeBytes = int64(len(strings.TrimSuffix(body, "\n"+fence)))
			}
		}
		return file
	}
	if _, encoded, ok := strings.Cut(data, ","); ok {
		file.SizeBytes = int64(base64.RawStdEncoding.DecodedLen(len(strings.TrimRight(encoded, "="))))
	}
	return file
}

func queuedAttachmentsJSON(itemID string, blocks []ContentBlock) string {
	files := make([]UploadedFile, 0, len(blocks))
	for i, block := range blocks {
		files = append(files, queuedAttachment(itemID, i, block))
	}
	data, _ := json.Marshal(files)
	return string(data)
}

func (r *Relay) editedQueueRequest(itemID string, current PromptRequest, draft, uploads string) (PromptRequest, error) {
	prompt, err := getDraftText(draft)
	if err != nil {
		return current, fmt.Errorf("invalid draft_json: %w", err)
	}
	if uploads != "" {
		var files []UploadedFile
		if err := json.Unmarshal([]byte(uploads), &files); err != nil || files == nil {
			return current, errors.New("uploaded_files_json must be an array of attachments")
		}
		retained := make(map[string]ContentBlock, len(current.Content))
		for i, b := range current.Content {
			retained[queuedAttachment(itemID, i, b).RelativePath] = b
		}
		content := make([]ContentBlock, 0, len(files))
		var totalBytes int64
		for _, file := range files {
			b, ok := retained[file.RelativePath]
			if !ok {
				blocks, err := r.uploads.Content([]string{file.RelativePath})
				if err != nil {
					return current, err
				}
				b = blocks[0]
			}
			totalBytes += queuedAttachment(itemID, len(content), b).SizeBytes
			if totalBytes > MaxUploadMessageBytes {
				return current, errors.New("queued attachments exceed the message size limit")
			}
			content = append(content, b)
		}
		current.Content = content
	}
	current.Prompt = prompt
	if !current.hasInput() {
		return current, errors.New("queued prompt or attachment is required")
	}
	if !strings.HasPrefix(strings.TrimSpace(prompt), "/") {
		current.PromptCommand = false
	}
	return current, nil
}
