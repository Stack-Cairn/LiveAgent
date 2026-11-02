package pbws

import (
	"testing"

	"github.com/liveagent/agent-gateway/internal/config"
)

// The desktop passes an image-only K-Brain pair; it must not create the direct
// K-Brain chat relay, which would add a chat target that bypasses the desktop agent.
func TestImageKBrainConfigDoesNotEnableChatRelay(t *testing.T) {
	s := NewServer(&config.Config{Token: "gateway-fixture", KBrainAgentID: "kbrain", ImageKBrainURL: "http://127.0.0.1:1", ImageKBrainToken: "image-fixture"}, nil, nil)
	if s.kbrainRelay != nil || s.kbrainTargetID != "" {
		t.Fatal("image-only K-Brain config enabled the chat relay")
	}
}
