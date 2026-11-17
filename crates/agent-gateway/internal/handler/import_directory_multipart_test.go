package handler

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func directoryFixture(t *testing.T, count int) *http.Request {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	_ = w.WriteField("name", "project")
	_ = w.WriteField("target", "workspace")
	for i := 0; i < count; i++ {
		name := fmt.Sprintf("folder/file-%d.txt", i)
		_ = w.WriteField("paths", name)
		f, err := w.CreateFormFile("files", name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = f.Write([]byte("x"))
	}
	_ = w.Close()
	r := httptest.NewRequest("POST", "/", &body)
	r.Header.Set("Content-Type", w.FormDataContentType())
	return r
}
func TestDirectoryUploadSupportsDocumentedFileCount(t *testing.T) {
	for _, count := range []int{500, 2000} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			u, err := readDirectoryUpload(directoryFixture(t, count))
			if err != nil {
				t.Fatal(err)
			}
			defer u.cleanup()
			if len(u.files) != count || len(u.paths) != count || u.paths[count-1] != fmt.Sprintf("folder/file-%d.txt", count-1) {
				t.Fatal("files and paths lost alignment")
			}
			f, err := u.files[count-1].Open()
			if err != nil {
				t.Fatal(err)
			}
			content, err := io.ReadAll(f)
			_ = f.Close()
			if err != nil || string(content) != "x" {
				t.Fatalf("bad content %q %v", content, err)
			}
			dir := u.tempDir
			u.cleanup()
			if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("temporary files were not removed")
			}
		})
	}
}
func TestDirectoryUploadRejectsTooManyFilesAndCleansUp(t *testing.T) {
	temp := t.TempDir()
	for _, key := range []string{"TMPDIR", "TMP", "TEMP"} {
		t.Setenv(key, temp)
	}
	_, err := readDirectoryUpload(directoryFixture(t, 2001))
	if !errors.Is(err, errDirectoryUploadTooLarge) {
		t.Fatalf("unexpected error %v", err)
	}
	entries, err := os.ReadDir(temp)
	if err != nil || len(entries) != 0 {
		t.Fatalf("temporary upload leaked: %v %v", entries, err)
	}
}
func TestDirectoryUploadBoundsMetadataAndHTTPBody(t *testing.T) {
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	_ = w.WriteField("name", string(bytes.Repeat([]byte("x"), int(maxDirectoryFieldBytes)+1)))
	_ = w.Close()
	r := httptest.NewRequest("POST", "/", &body)
	r.Header.Set("Content-Type", w.FormDataContentType())
	if _, err := readDirectoryUpload(r); !errors.Is(err, errDirectoryUploadTooLarge) {
		t.Fatalf("metadata error=%v", err)
	}
	r = directoryFixture(t, 2)
	r.Body = http.MaxBytesReader(httptest.NewRecorder(), r.Body, 100)
	var maxErr *http.MaxBytesError
	if _, err := readDirectoryUpload(r); !errors.As(err, &maxErr) {
		t.Fatalf("body error=%v", err)
	}
}
