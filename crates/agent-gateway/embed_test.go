package gateway

import (
	"io/fs"
	"testing"
)

// The HTTP server panics at construction if the retirement page is missing, so
// keep the embed honest here rather than at startup.
func TestWebUIAssetsContainRetirementPage(t *testing.T) {
	content, err := fs.ReadFile(WebUIAssets, "webui-retired/index.html")
	if err != nil {
		t.Fatalf("read embedded retirement page: %v", err)
	}
	if len(content) == 0 {
		t.Fatal("embedded retirement page is empty")
	}
}
