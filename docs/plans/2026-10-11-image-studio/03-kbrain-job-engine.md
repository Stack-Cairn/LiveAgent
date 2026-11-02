# 03：图像任务调度与恢复实施计划

> 执行者逐任务勾选，优先使用 subagent-driven-development 或 executing-plans；不可用时按本文执行。验收前不提交。

**Goal：**用同一任务引擎执行直接返回和异步任务，覆盖取消、部分成功和结果未知，避免重复收费提交。

**Architecture：**Service管理提交和校验，Scheduler按连接并发租约执行；Adapter处理平台协议；Store持久化决定、状态和事件。异步轮询期间释放网络执行槽但保留平台活跃任务计数，不用每个任务常驻goroutine。

**Tech Stack：**Go context、注入时钟、httptest、02 Store、01 Adapter契约。

**Spec：**[统一规格](design.md)。

## 全局约束

并发与超时依design。未知结果不自动重新生成；不自动换供应商；不得在后台任务中继续使用HTTP请求的r.Context作为生命周期。租约只表示本地执行权，不等于供应商任务状态。

## 文件地图

新增 K-Brain `internal/imaging/service.go`、`scheduler.go`、`state_machine.go`、`recovery.go`、`retry.go`、`service_test.go`、`scheduler_test.go`、`recovery_test.go`、`test_helpers_test.go`。backend新增 `image_jobs.go`、`image_events.go`及测试；修改 `internal/backend/server.go` 启动/关闭image引擎。

## Task 1：接受、去重和批量分解

**Consumes：**ValidateSettings、HashRequest、Store、design CreateJobRequest。

**Produces：**design Service 的 CreateJob/GetJob/ListJobs；`NewService(store,*Registry,Clock) *Service`，Clock契约 `Now() time.Time; After(time.Duration)<-chan time.Time`。

- [ ] 测试非法target、操作不支持、缺输入、目标disabled、count超限、非法参数、跨owner输入，均在调用Adapter前拒绝。
- [ ] 事务内检查幂等键和hash，冻结无秘密targetSnapshot，写job/items及accepted event，commit后返回202；配置变更不改变已有请求参数。
- [ ] 默认将count分成多个单图item；只有证据明确支持原生批量才可合并。原生批量部分输出不声称未产出项可单独核对；重试明确生成新attempt/任务。
- [ ] HTTP同key重放返回200/replayed=true，hash冲突409。取消HTTP请求不取消已durable创建的job。
- [ ] 运行 `go test ./internal/imaging ./internal/backend -run 'ImageJobCreate|Idempotency|Batch' -v`。

## Task 2：执行与退避

**Produces：**`Scheduler.Start(ctx) error`、`Scheduler.Close(ctx) error`；Submit/Poll统一RemoteResult。

- [ ] fake Adapter实现全部4方法，用pending队列、调用计数、注入错误与outputs测试真实执行顺序。

```go
type fakeAdapter struct { submits int; next RemoteResult; submitErr error }
func (f *fakeAdapter) Submit(ctx context.Context, r ExecuteRequest) (RemoteResult,error) {
    f.submits++; return f.next, f.submitErr
}
func (f *fakeAdapter) Poll(context.Context,string) (RemoteResult,error) { return f.next,nil }
func (f *fakeAdapter) Cancel(context.Context,string) error { return nil }
func (f *fakeAdapter) Reconcile(context.Context,string) (RemoteResult,error) { return f.next,nil }
```

测试并发时fake计数需mutex，不把数据竞争当引擎行为。

- [ ] durable写attempt=submitting再调Submit；handle保存与pending事件同事务。RemoteResult completed调用SaveOutput成功后才succeeded。
- [ ] 连接并发与全局并发同时限制，公平round-robin；轮询到期队列按nextPollAt唤醒。平台活跃计数在pending时继续占用连接任务配额，防无限投递。
- [ ] not_sent最多重试2次；rejected立即失败；uncertain进入核对；下载3次；查询连续失败5次后unknown，均受job截止限制。429只有明确未接受的提交才能重试。
- [ ] 记录Usage缺省null。多item合并不能把没有usage当免费；仅相同单位/币种且全部已知才合计。
- [ ] 两输出中一个保存失败，保留成功asset并partial_succeeded；纯文字或空图片结果明确失败，不能succeeded。
- [ ] 运行 `go test ./internal/imaging -run 'Scheduler|Retry|Partial|Usage' -v`。

## Task 3：取消与完成竞态

**Produces：**CancelJob与cancelEffect=upstream_confirmed/local_only/not_submitted字段。

- [ ] queued取消不Submit；执行中请求取消先durable记录cancel_requested，再调用上游Cancel或停止本地处理。
- [ ] 不支持取消返回local_only，说明可能计费；Cancel网络超时不标upstream_confirmed。
- [ ] 存储事务裁决终态：成功已提交后取消保持成功；cancel_requested期间迟到结果已保存则保留资产并明确实际完成；不丢图片、不发生终态倒退。
- [ ] 重复取消返回同状态，取消不能删除可核对句柄或已经保存的结果。
- [ ] 使用barrier协调fake Submit/Cancel测试两种顺序，断言终态、output文件数和上游调用次数。
- [ ] 运行 `go test ./internal/imaging -run 'Cancel|TerminalRace' -count=20`，结果稳定。

## Task 4：重启与未知结果核对

**Produces：**`Recover(ctx) error`、对unknown可显式触发的内部reconcile流程；不新增隐式再生成。

- [ ] 测试6个中断点：accepted后、submitting后、收到handle但未保存、pending已保存、原图落盘未写asset引用、终态事件已commit。
- [ ] pending已保存恢复Poll，原submits计数不增加。submitting缺handle通过SubmissionKey调用Reconcile；不支持则unknown。
- [ ] 续接数据保持后端opaque并durable，不放公开snapshot。连接撤销后恢复给明确认证错误，无秘密字符串。
- [ ] lease owner/expiry随store记录，默认60秒、20秒续租；重启回收本地lease但不重复上游Submit。单进程写锁阻止双engine。
- [ ] 运行 `go test ./internal/imaging -run 'Recover|Unknown|Lease' -v`，断言最终观察量：上游提交次数保持1。

## Task 5：HTTP任务、SSE与模块关闭

- [ ] backend routes按design实现，所有对象读取先scope校验。SSE auth在建连与scope恢复时检查，不带供应商凭据。
- [ ] seq同事务，重连Last-Event-ID只发后续事件；保留范围外409，客户端读snapshot后续接。
- [ ] 活动流15秒发送注释heartbeat；消费慢时停止该订阅并允许续接，不阻塞任务存储。
- [ ] 正常关闭停止新接受，保存活跃状态，取消本地context但不伪称远端取消；下次启动Recover。
- [ ] 运行 `go test ./internal/backend -run 'ImageJob|ImageEvent|ImageShutdown' -v`。

**独立验收：**无真实平台即可展示fake直接生成、异步生成、部分成功、超时unknown、取消和重启。验收观察任务结果、durable事件及fake提交次数，不能只验一个代码分支。完整真实平台验收在04/07。
