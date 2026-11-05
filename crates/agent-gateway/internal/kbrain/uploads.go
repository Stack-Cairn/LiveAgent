package kbrain

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Files the WebUI attaches in direct mode. The desktop imports attachments into
// its own workspace and the model reads them from disk; a direct K-brain may run
// on another machine, so the Gateway holds the bytes until the message is sent
// and then inlines them as canonical content blocks.
const (
	uploadPathPrefix = "kbrain-upload/"
	// K-brain reads at most 4 MiB of JSON per run request. Base64 grows data by a
	// third, so a message carries at most 2.5 MiB of attachments in all.
	MaxUploadMessageBytes = 5 << 19
	maxUploadStoreBytes   = 64 << 20
	maxUploadFiles        = 64
	uploadTTL             = 2 * time.Hour
)

var errUploadMissing = errors.New("an attachment is no longer available on the Gateway; attach it again")

// UploadStore keeps attachment bytes in memory, bounded in size and age.
type UploadStore struct {
	mu    sync.Mutex
	items map[string]*storedUpload
	order []string
	bytes int64
	now   func() time.Time
}

type storedUpload struct {
	id       string
	fileName string
	mimeType string
	kind     string
	data     []byte
	stored   time.Time
}

// UploadedFile mirrors the WebUI PendingUploadedFile fields.
type UploadedFile struct {
	RelativePath string `json:"relativePath"`
	DedupeKey    string `json:"dedupeKey"`
	FileName     string `json:"fileName"`
	Kind         string `json:"kind"`
	SizeBytes    int64  `json:"sizeBytes"`
}

func NewUploadStore() *UploadStore {
	return &UploadStore{items: map[string]*storedUpload{}, now: time.Now}
}

// Put stores one file. It returns the reason the file was skipped, if it was.
func (s *UploadStore) Put(fileName, declaredMIME string, data []byte) (UploadedFile, string) {
	fileName = path.Base(strings.ReplaceAll(strings.TrimSpace(fileName), "\\", "/"))
	if fileName == "" || fileName == "." || fileName == "/" {
		fileName = "attachment"
	}
	kind, mimeType := classifyUpload(fileName, declaredMIME, data)
	if kind == "" {
		return UploadedFile{}, fileName + ": this file type cannot be sent to K-brain from the Gateway"
	}
	if len(data) == 0 {
		return UploadedFile{}, fileName + ": the file is empty"
	}
	if len(data) > MaxUploadMessageBytes {
		return UploadedFile{}, fmt.Sprintf("%s: larger than %d MiB, the most K-brain accepts in one message", fileName, MaxUploadMessageBytes>>20)
	}
	sum := sha256.Sum256(data)
	var nonce [12]byte
	_, _ = rand.Read(nonce[:])
	id := hex.EncodeToString(nonce[:])
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked()
	for len(s.order) > 0 && (s.bytes+int64(len(data)) > maxUploadStoreBytes || len(s.order) >= maxUploadFiles) {
		s.dropLocked(s.order[0])
	}
	s.items[id] = &storedUpload{id: id, fileName: fileName, mimeType: mimeType, kind: kind, data: data, stored: s.now()}
	s.order = append(s.order, id)
	s.bytes += int64(len(data))
	return UploadedFile{
		RelativePath: uploadPathPrefix + id + "/" + fileName,
		DedupeKey:    "sha256:" + hex.EncodeToString(sum[:]),
		FileName:     fileName,
		Kind:         kind,
		SizeBytes:    int64(len(data)),
	}, ""
}

// Content turns the attachments of one message into canonical content blocks.
// relativePaths are the RelativePath values Put returned.
func (s *UploadStore) Content(relativePaths []string) ([]ContentBlock, error) {
	if len(relativePaths) == 0 {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked()
	blocks := make([]ContentBlock, 0, len(relativePaths))
	total := 0
	for _, relativePath := range relativePaths {
		id, _, ok := strings.Cut(strings.TrimPrefix(relativePath, uploadPathPrefix), "/")
		item := s.items[id]
		if !ok || !strings.HasPrefix(relativePath, uploadPathPrefix) || item == nil {
			return nil, errUploadMissing
		}
		total += len(item.data)
		if total > MaxUploadMessageBytes {
			return nil, fmt.Errorf("attachments exceed %d MiB, the most K-brain accepts in one message", MaxUploadMessageBytes>>20)
		}
		switch item.kind {
		case "image":
			blocks = append(blocks, ContentBlock{Type: "image", ImageURL: dataURL(item.mimeType, item.data), MIMEType: item.mimeType})
		case "pdf":
			blocks = append(blocks, ContentBlock{Type: "file", FileURL: dataURL(item.mimeType, item.data), Filename: item.fileName, MIMEType: item.mimeType})
		default:
			fence := "```"
			for strings.Contains(string(item.data), fence) {
				fence += "`"
			}
			blocks = append(blocks, ContentBlock{Type: "text", Text: "\n\nAttached file " + item.fileName + ":\n" + fence + "\n" + strings.TrimRight(string(item.data), "\n") + "\n" + fence})
		}
	}
	return blocks, nil
}

// ImportHandler serves POST /api/files/import for the K-brain target: the same
// multipart form and response the desktop agent answers.
func (s *UploadStore) ImportHandler(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadStoreBytes)
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		status, message := http.StatusBadRequest, "invalid multipart form"
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			status, message = http.StatusRequestEntityTooLarge, "uploaded files are too large"
		}
		writeUploadJSON(w, status, map[string]string{"error": message})
		return
	}
	defer func() { _ = r.MultipartForm.RemoveAll() }()
	headers := r.MultipartForm.File["files"]
	if len(headers) == 0 {
		writeUploadJSON(w, http.StatusBadRequest, map[string]string{"error": "files is required"})
		return
	}
	files := []UploadedFile{}
	skipped := []string{}
	for _, header := range headers {
		if header.Size > MaxUploadMessageBytes {
			skipped = append(skipped, fmt.Sprintf("%s: larger than %d MiB, the most K-brain accepts in one message", path.Base(header.Filename), MaxUploadMessageBytes>>20))
			continue
		}
		file, err := header.Open()
		if err != nil {
			writeUploadJSON(w, http.StatusBadRequest, map[string]string{"error": "failed to read uploaded files"})
			return
		}
		data, readErr := io.ReadAll(io.LimitReader(file, MaxUploadMessageBytes+1))
		_ = file.Close()
		if readErr != nil {
			writeUploadJSON(w, http.StatusBadRequest, map[string]string{"error": "failed to read uploaded files"})
			return
		}
		stored, reason := s.Put(header.Filename, header.Header.Get("Content-Type"), data)
		if reason != "" {
			skipped = append(skipped, reason)
			continue
		}
		files = append(files, stored)
	}
	writeUploadJSON(w, http.StatusOK, map[string]any{"files": files, "skipped": skipped})
}

func (s *UploadStore) expireLocked() {
	cutoff := s.now().Add(-uploadTTL)
	for len(s.order) > 0 {
		item := s.items[s.order[0]]
		if item != nil && item.stored.After(cutoff) {
			return
		}
		s.dropLocked(s.order[0])
	}
}

func (s *UploadStore) dropLocked(id string) {
	if item := s.items[id]; item != nil {
		s.bytes -= int64(len(item.data))
		delete(s.items, id)
	}
	for i, value := range s.order {
		if value == id {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
}

var uploadImageTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

var uploadTextExtensions = map[string]bool{
	".txt": true, ".md": true, ".markdown": true, ".csv": true, ".tsv": true, ".json": true, ".jsonl": true,
	".yaml": true, ".yml": true, ".toml": true, ".xml": true, ".html": true, ".htm": true, ".css": true,
	".log": true, ".ini": true, ".cfg": true, ".conf": true, ".env": true, ".sql": true, ".sh": true,
	".py": true, ".js": true, ".jsx": true, ".ts": true, ".tsx": true, ".go": true, ".rs": true, ".java": true,
	".kt": true, ".swift": true, ".c": true, ".h": true, ".cc": true, ".cpp": true, ".hpp": true, ".cs": true,
	".rb": true, ".php": true, ".lua": true, ".r": true, ".scala": true, ".vue": true, ".svelte": true, ".svg": true,
}

// classifyUpload names the WebUI attachment kind and the MIME type sent to
// K-brain. The content decides, not the browser's declared type: an image must
// sniff as one of the formats every K-brain provider accepts.
func classifyUpload(fileName, declared string, data []byte) (kind, mimeType string) {
	sniffed := http.DetectContentType(data)
	if uploadImageTypes[sniffed] {
		return "image", sniffed
	}
	ext := strings.ToLower(path.Ext(fileName))
	if sniffed == "application/pdf" {
		return "pdf", "application/pdf"
	}
	if !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
		return "", ""
	}
	if ext == ".ipynb" {
		var notebook map[string]any
		if json.Unmarshal(data, &notebook) == nil {
			return "notebook", "application/x-ipynb+json"
		}
		return "", ""
	}
	if uploadTextExtensions[ext] || ext == "" || strings.HasPrefix(declared, "text/") || strings.HasPrefix(sniffed, "text/") {
		if guessed := mime.TypeByExtension(ext); strings.HasPrefix(guessed, "text/") {
			return "text", guessed
		}
		return "text", "text/plain"
	}
	return "", ""
}

func dataURL(mimeType string, data []byte) string {
	return "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(data)
}

func writeUploadJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

// Uploads holds the attachments WebUI imports for this K-brain target.
func (r *Relay) Uploads() *UploadStore { return r.uploads }

func (p PromptRequest) hasInput() bool {
	return strings.TrimSpace(p.Prompt) != "" || len(p.Content) > 0
}
