package gatewayv2

// ChatIngressV1Capability is the capability identifier for reliable desktop
// chat mirroring into the gateway.
const ChatIngressV1Capability = "CHAT_INGRESS_V1"

// ConversationReferencesV1Capability identifies desktop runtimes that accept
// structured conversation references on ChatRequest.
const ConversationReferencesV1Capability = "CONVERSATION_REFERENCES_V1"

// SttStreamV1Capability identifies the gateway-owned browser STT data plane.
const SttStreamV1Capability = "STT_STREAM_V1"

// ComposerCommandsV1Capability identifies desktop runtimes that handle composer
// slash commands from the WebUI: ChatRequest goal_action/goal_text/prompt_command
// and the slash_command_list, goal_manage and loop_manage agent requests.
const ComposerCommandsV1Capability = "COMPOSER_COMMANDS_V1"

// ProxyDetectV1Capability identifies desktop runtimes that handle the
// proxy_detect agent request (app proxy settings: detect running local proxy
// services and test them).
const ProxyDetectV1Capability = "PROXY_DETECT_V1"

// PermissionRulesV1Capability identifies desktop runtimes that handle the
// permission_rules agent request (Settings → Permissions: list, add and delete
// K-brain's remembered permission rules).
const PermissionRulesV1Capability = "PERMISSION_RULES_V1"
