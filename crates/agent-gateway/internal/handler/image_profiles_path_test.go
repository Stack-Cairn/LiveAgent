package handler

import "testing"

// Image services are a read-only list derived from chat providers; the gateway
// forwards only that route.
func TestValidImagePathAdmitsProfileList(t *testing.T) {
	for _, path := range []string{"platforms", "profiles"} {
		if !validImagePath(path) {
			t.Errorf("%s rejected", path)
		}
	}
	for _, path := range []string{
		"platforms/x",
		"profiles/ip_0123456789abcdef",
		"profiles/ip_x/models",
		"profiles/custom-providers",
		"profiles/../settings",
	} {
		if validImagePath(path) {
			t.Errorf("%s admitted", path)
		}
	}
}
