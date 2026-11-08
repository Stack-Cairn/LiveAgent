package pbws

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/liveagent/agent-gateway/internal/chatcmd"
	"github.com/liveagent/agent-gateway/internal/handler"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// The project's MCP choice reaches K-brain as mcp_server_ids: inherit sends
// nothing, a custom pick sends its servers, and "none" is an id no server has,
// because K-brain reads an empty list as "use the saved selection".
func TestKBrainRunCarriesProjectMCPServerSelection(t *testing.T) {
	for name, tc := range map[string]struct {
		selection *gatewayv2.ChatMcpServerSelection
		want      []string
	}{
		"inherit": {nil, nil},
		"custom":  {&gatewayv2.ChatMcpServerSelection{ServerIds: []string{"docs", " ", "web"}}, []string{"docs", "web"}},
		"none":    {&gatewayv2.ChatMcpServerSelection{}, []string{kbrainNoMCPServers}},
	} {
		body := chatcmd.RequestBodyFromProto(&gatewayv2.ChatRequest{
			ExecutionMode: "tools",
			McpServers:    tc.selection,
		})
		options := kbrainOptions(body)
		if !reflect.DeepEqual(options.MCPServerIDs, tc.want) {
			t.Fatalf("%s: mcp_server_ids = %#v, want %#v", name, options.MCPServerIDs, tc.want)
		}
		encoded, err := json.Marshal(options)
		if err != nil {
			t.Fatal(err)
		}
		var wire map[string]any
		if err := json.Unmarshal(encoded, &wire); err != nil {
			t.Fatal(err)
		}
		if _, present := wire["mcp_server_ids"]; present != (tc.want != nil) {
			t.Fatalf("%s: mcp_server_ids present = %v in %s", name, present, encoded)
		}
	}

	// Chat mode offers no tools, so it never narrows MCP servers.
	chat := kbrainOptions(handler.ChatRequestBody{
		ExecutionMode: "text",
		MCPServers:    &handler.ChatMCPServerSelectionBody{},
	})
	if chat.MCPServerIDs != nil {
		t.Fatalf("chat run got mcp_server_ids %#v", chat.MCPServerIDs)
	}
}
