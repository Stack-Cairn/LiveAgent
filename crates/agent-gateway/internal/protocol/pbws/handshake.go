package pbws

import (
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"github.com/liveagent/agent-gateway/internal/auth"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// helloVerdict 是握手校验结果；ok=false 时 message 面向客户端。
type helloVerdict struct {
	ok      bool
	message string
}

// vetHello 校验 ClientHello 的协议版本、角色与浏览器凭证。
// 角色-凭证绑定：浏览器角色只接受网关 token；Agent 角色必须声明 agent_id。
// Agent 凭证由 authenticateAgentHello 在存储锁内只校验一次，主链路与终端
// 数据链路复用该入口。凭证失败统一报 "unauthorized"，防止枚举 Agent ID。
func (s *Server) vetHello(hello *gatewayv2.ClientHello, wantRole gatewayv2.ClientRole) helloVerdict {
	if hello == nil {
		return helloVerdict{message: "hello frame is required"}
	}
	if hello.GetProtocolVersion() != ProtocolVersion {
		return helloVerdict{message: "unsupported protocol version"}
	}
	role := hello.GetRole()
	// hello 缺省角色按端点预期补齐（路径已可区分）；显式错误角色拒绝，防止 agent 帧被当浏览器帧处理。
	if role != gatewayv2.ClientRole_CLIENT_ROLE_UNSPECIFIED && role != wantRole {
		return helloVerdict{message: "unexpected client role"}
	}
	switch wantRole {
	case gatewayv2.ClientRole_CLIENT_ROLE_AGENT:
		if strings.TrimSpace(hello.GetAgentId()) == "" {
			return helloVerdict{message: "agent_id is required"}
		}
	default:
		if !auth.ValidateToken(hello.GetToken(), s.cfg.Token) {
			return helloVerdict{message: "unauthorized"}
		}
	}
	return helloVerdict{ok: true}
}

// authenticateAgentHello 在 Store 内完成唯一一次独立 Token 查询、共享 Token 判定、
// 自动登记及按 Agent 凭证纪元快照。调用方必须在注册传输时校验返回纪元。
func (s *Server) authenticateAgentHello(hello *gatewayv2.ClientHello) (uint64, error) {
	return s.tokens.AuthenticateAndRegister(
		hello.GetAgentId(),
		hello.GetToken(),
		auth.ValidateToken(hello.GetToken(), s.cfg.Token),
	)
}

// serverHello 构造握手应答；sessionID 仅 agent 角色使用，maxMessageBytes 按链路
// 报告实际读限额（各链路收紧后不再统一）。
func (s *Server) serverHello(ok bool, message string, sessionID string, maxMessageBytes int64) *gatewayv2.ServerHello {
	return &gatewayv2.ServerHello{
		Ok:                     ok,
		Message:                strings.TrimSpace(message),
		SessionId:              strings.TrimSpace(sessionID),
		ServerTime:             time.Now().Unix(),
		HeartbeatPeriodSeconds: uint32(s.heartbeatPeriod() / time.Second),
		MaxMessageBytes:        uint64(maxMessageBytes),
	}
}

// closeUnauthorized 以鉴权失败码关闭连接（调用方已写出失败 hello）。
func closeUnauthorized(conn *websocket.Conn, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	_ = conn.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(closeCodeUnauthorized, "unauthorized"),
		deadline,
	)
	_ = conn.Close()
}
