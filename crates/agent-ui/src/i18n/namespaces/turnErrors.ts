// Failed, interrupted and retrying turns: the typed error row under a failed
// reply, the marker of a reply a backend restart cut off, and the live
// "retrying" status of a turn whose model request is being retried.
// The modules that render these messages import this file, which registers
// both locales before they render.
import { registerTranslations } from "../hostTranslations";

registerTranslations({
  "zh-CN": {
    "chat.turnError.auth.title": "API 密钥无效",
    "chat.turnError.auth.body": "供应商拒绝了当前的 API 密钥。请在供应商设置中检查密钥后重试。",
    "chat.turnError.rateLimit.title": "请求过于频繁",
    "chat.turnError.rateLimit.body": "供应商暂时限制了请求频率，自动重试后仍未成功。请稍后重试。",
    "chat.turnError.server.title": "供应商服务出错",
    "chat.turnError.server.body": "供应商服务暂时无法处理这次请求。请稍后重试。",
    "chat.turnError.connection.title": "连接已中断",
    "chat.turnError.connection.body": "回复在完成前中断了，已收到的内容保留在上方。",
    "chat.turnError.timeout.title": "请求超时",
    "chat.turnError.timeout.body": "供应商没有及时响应，这一轮已中止。请稍后重试。",
    "chat.turnError.contextLimit.title": "超出上下文长度",
    "chat.turnError.contextLimit.body":
      "这次请求超出了模型的上下文窗口。请压缩对话、开启新对话或缩短输入后重试。",
    "chat.turnError.badRequest.title": "请求被拒绝",
    "chat.turnError.badRequest.body":
      "供应商拒绝了这次请求。请检查模型和供应商设置，或展开详情查看原因。",
    "chat.turnStopped.shutdown": "已中断（后端已重启）",
    "chat.turnError.unknown.title": "请求失败",
    "chat.turnError.unknown.body": "这一轮没有完成。可以重试，或展开详情查看原始错误。",
    "chat.turnError.status": "HTTP {status}",
    "chat.turnError.details": "错误详情",
    "chat.turnError.retry": "重试",
    "chat.turnError.openProviderSettings": "打开供应商设置",
    "chat.runPhase.retrying": "{seconds} 秒后重试（{attempt}/{max}）",
    "chat.runPhase.retryingNow": "正在重试（{attempt}/{max}）",
  },
  "en-US": {
    "chat.turnError.auth.title": "Invalid API key",
    "chat.turnError.auth.body":
      "The provider rejected the API key. Check the key in provider settings, then retry.",
    "chat.turnError.rateLimit.title": "Rate limited",
    "chat.turnError.rateLimit.body":
      "The provider is limiting requests and the automatic retries did not get through. Retry in a moment.",
    "chat.turnError.server.title": "Provider server error",
    "chat.turnError.server.body":
      "The provider could not process this request right now. Retry in a moment.",
    "chat.turnError.connection.title": "Connection lost",
    "chat.turnError.connection.body":
      "The reply was interrupted before it finished. Anything that already arrived is kept above.",
    "chat.turnError.timeout.title": "Request timed out",
    "chat.turnError.timeout.body":
      "The provider did not respond in time, so this turn was stopped. Retry in a moment.",
    "chat.turnError.contextLimit.title": "Context length exceeded",
    "chat.turnError.contextLimit.body":
      "This request is larger than the model's context window. Compact the conversation, start a new one, or shorten the input, then retry.",
    "chat.turnError.badRequest.title": "Request rejected",
    "chat.turnError.badRequest.body":
      "The provider rejected this request. Check the model and provider settings, or open the details for the reason.",
    "chat.turnStopped.shutdown": "Interrupted (the backend restarted)",
    "chat.turnError.unknown.title": "Request failed",
    "chat.turnError.unknown.body":
      "This turn did not finish. Retry, or open the details for the original error.",
    "chat.turnError.status": "HTTP {status}",
    "chat.turnError.details": "Error details",
    "chat.turnError.retry": "Retry",
    "chat.turnError.openProviderSettings": "Open provider settings",
    "chat.runPhase.retrying": "Retrying ({attempt}/{max}) in {seconds}s",
    "chat.runPhase.retryingNow": "Retrying ({attempt}/{max})",
  },
});
