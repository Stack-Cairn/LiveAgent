package wscore

import (
	"sync"
	"time"
)

// DispatchLimiter 限制单连接的在途派发数：读循环 TryAcquire 失败即拒绝该请求
// （绝不阻塞读循环——阻塞会拖死 pong/存活检测），处理 goroutine 结束时 Release。
// 没有它，慢速直通请求（可阻塞至 requestTimeout）会随请求速率无界累积 goroutine。
type DispatchLimiter struct {
	slots chan struct{}
}

func NewDispatchLimiter(limit int) *DispatchLimiter {
	if limit <= 0 {
		limit = 16
	}
	return &DispatchLimiter{slots: make(chan struct{}, limit)}
}

func (l *DispatchLimiter) TryAcquire() bool {
	select {
	case l.slots <- struct{}{}:
		return true
	default:
		return false
	}
}

func (l *DispatchLimiter) Release() {
	select {
	case <-l.slots:
	default:
	}
}

// InboundRateLimiter 是单连接入站帧的令牌桶：快帧（本地应答、解析即弃）不受
// 派发信号量约束，仍可打满 CPU（每帧一次 Unmarshal + 分发），令牌桶补上这一段。
// 连续违规超过阈值判定为失控客户端，调用方应关闭连接。
type InboundRateLimiter struct {
	mu         sync.Mutex
	tokens     float64
	burst      float64
	perSecond  float64
	lastRefill time.Time

	violations    int
	maxViolations int
}

func NewInboundRateLimiter(perSecond, burst float64, maxViolations int) *InboundRateLimiter {
	if perSecond <= 0 {
		perSecond = 100
	}
	if burst <= 0 {
		burst = perSecond * 2
	}
	if maxViolations <= 0 {
		maxViolations = 3
	}
	return &InboundRateLimiter{
		tokens:        burst,
		burst:         burst,
		perSecond:     perSecond,
		lastRefill:    time.Now(),
		maxViolations: maxViolations,
	}
}

// Allow 消费一个令牌。第二返回值为 true 表示连续违规已超阈值，连接应被关闭。
func (l *InboundRateLimiter) Allow() (ok bool, exceeded bool) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	l.tokens += now.Sub(l.lastRefill).Seconds() * l.perSecond
	if l.tokens > l.burst {
		l.tokens = l.burst
	}
	l.lastRefill = now

	if l.tokens >= 1 {
		l.tokens -= 1
		l.violations = 0
		return true, false
	}
	l.violations += 1
	return false, l.violations >= l.maxViolations
}
