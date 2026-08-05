package gateway

import "embed"

// WebUIAssets contains the retirement notice served by the HTTP server in place
// of the former embedded WebUI. The WebUI source tree was folded into the
// unified frontend (crates/agent-gui); the gateway now only serves a static
// page pointing at the migration guide.
//
//go:embed webui-retired
var WebUIAssets embed.FS
