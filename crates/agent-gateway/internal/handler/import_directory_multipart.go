package handler

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
)

const maxDirectoryFieldBytes int64 = 64 << 10

var errDirectoryUploadTooLarge = errors.New("directory upload exceeds limits")

type directoryUploadFile struct {
	path string
	Size int64
}

func (f directoryUploadFile) Open() (*os.File, error) { return os.Open(f.path) }

type directoryUpload struct {
	name, target, tempDir string
	paths                 []string
	files                 []directoryUploadFile
}

func (u *directoryUpload) cleanup() {
	if u.tempDir != "" {
		_ = os.RemoveAll(u.tempDir)
	}
}

// 每个文件占 files 和 paths 两个 part，标准 ReadForm 的 1000 part 上限
// 容不下协议承诺的 2000 文件。流式解析并暂存文件，分别限制文件、字段和总字节数。
func readDirectoryUpload(r *http.Request) (result *directoryUpload, err error) {
	reader, err := r.MultipartReader()
	if err != nil {
		return nil, err
	}
	upload := &directoryUpload{}
	defer func() {
		if err != nil {
			upload.cleanup()
		}
	}()
	var total int64
	seen := map[string]bool{}
	for parts := 0; ; parts++ {
		part, nextErr := reader.NextPart()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			return nil, nextErr
		}
		if parts >= 2*maxDirectoryUploadFiles+2 {
			_ = part.Close()
			return nil, errDirectoryUploadTooLarge
		}
		name := part.FormName()
		switch name {
		case "files":
			if len(upload.files) >= maxDirectoryUploadFiles {
				_ = part.Close()
				return nil, errDirectoryUploadTooLarge
			}
			if part.FileName() == "" {
				_ = part.Close()
				return nil, errors.New("file name required")
			}
			if upload.tempDir == "" {
				upload.tempDir, err = os.MkdirTemp("", "liveagent-directory-upload-")
				if err != nil {
					_ = part.Close()
					return nil, err
				}
			}
			file, openErr := os.CreateTemp(upload.tempDir, "file-")
			if openErr != nil {
				_ = part.Close()
				return nil, openErr
			}
			size, copyErr := io.Copy(file, io.LimitReader(part, maxDirectoryUploadBytes-total+1))
			closeErr := file.Close()
			if copyErr != nil {
				_ = part.Close()
				return nil, copyErr
			}
			if closeErr != nil {
				_ = part.Close()
				return nil, closeErr
			}
			total += size
			if total > maxDirectoryUploadBytes {
				_ = part.Close()
				return nil, errDirectoryUploadTooLarge
			}
			upload.files = append(upload.files, directoryUploadFile{path: file.Name(), Size: size})
		case "name", "target", "paths":
			if part.FileName() != "" {
				_ = part.Close()
				return nil, errors.New("unexpected file field")
			}
			if name == "paths" && len(upload.paths) >= maxDirectoryUploadFiles {
				_ = part.Close()
				return nil, errDirectoryUploadTooLarge
			}
			if name != "paths" && seen[name] {
				_ = part.Close()
				return nil, fmt.Errorf("duplicate %s", name)
			}
			value, readErr := io.ReadAll(io.LimitReader(part, maxDirectoryFieldBytes+1))
			if readErr != nil {
				_ = part.Close()
				return nil, readErr
			}
			if int64(len(value)) > maxDirectoryFieldBytes {
				_ = part.Close()
				return nil, errDirectoryUploadTooLarge
			}
			seen[name] = true
			switch name {
			case "name":
				upload.name = string(value)
			case "target":
				upload.target = string(value)
			case "paths":
				upload.paths = append(upload.paths, string(value))
			}
		default:
			_ = part.Close()
			return nil, errors.New("unexpected multipart field")
		}
		if closeErr := part.Close(); closeErr != nil {
			return nil, closeErr
		}
	}
	return upload, nil
}
