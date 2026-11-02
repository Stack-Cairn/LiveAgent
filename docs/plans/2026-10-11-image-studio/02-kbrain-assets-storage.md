# 02：K-Brain 持久化与图片资产实施计划

> 执行者逐任务勾选，优先使用 subagent-driven-development 或 executing-plans；不可用时按本文执行。验收前不提交实现。

**Goal：**让项目、图像任务、事件和图片在中断后可靠恢复，并隔离所有权与版本引用。

**Architecture：**单写者追加事务日志 + 周期快照；每个事务写入关联记录和事件，fsync 后生效。图片内容先原子落盘再建立引用；恢复时清理无引用文件，不把文件存在误判成任务成功。

**Tech Stack：**Go、encoding/json、SHA-256、现有 github.com/gofrs/flock、PNG/JPEG/WebP 解码。

**Spec：**[统一规格](design.md)。

## 全局约束

遵守 design 限额、owner、GC 规则。K-Brain 当前无 SQLite 依赖，不更改 Agent session store。磁盘损坏不静默丢任务；目录不能由两个 engine 进程同时写。SSE 大图禁止。

## 文件地图

新增 K-Brain `internal/imaging/store.go`、`store_log.go`、`store_snapshot.go`、`store_test.go`、`assets.go`、`assets_download.go`、`assets_gc.go`、`assets_test.go`、`projects.go`、`projects_test.go`；backend 新增 `image_assets.go`、`image_projects.go` 及同名 `_test.go`。

读取并复用已有模式：`internal/backend/cron_store.go`、`internal/session/`、`internal/datapath/paths.go`。图像独立 data dir 从现有 datapath 获取，不写 cwd 或上传任意路径。

## Task 1：事务日志、快照与恢复

**Produces：**`OpenStore(dir string) (*Store,error)`、`Store.Close() error`、`Store.Update(ctx context.Context, fn func(*Transaction) error) error`。Transaction 的强类型方法：PutProject、PutJob、PutAsset、AppendEvent、PutIdempotency；读方法必须带 Scope。

- [ ] 写测试：一次事务修改 job+event+幂等键；重开后全部可见。fn 返回 error 时全部不生效；fsync 失败不回成功。
- [ ] 事务记录格式：一行 JSON `{txSeq,payload,sha256}`；payload 是版本化强类型 mutations。每次 append 完整记录并 sync 后更新内存索引。恢复仅允许截断末尾不完整行；中部 checksum 失败停止启动并给恢复诊断。
- [ ] 获取 flock 独占写锁，第二个 writer 返回 IMAGE_STORE_LOCKED。进程内 mutex 串行化每个事务及 event seq 分配。
- [ ] 每1000事务或日志64MiB执行快照，持锁写 temp、sync、原子替换。保留 checkpoint txSeq 后再轮换日志，不能先删日志。Windows 原子替换和路径编码加入测试。
- [ ] 用可注入文件操作 fault hook，在 append、sync、snapshot rename 前后模拟中断，不依赖杀真实进程。

```go
func TestStoreRejectsSecondWriter(t *testing.T) {
    dir := t.TempDir()
    first, err := OpenStore(dir); if err != nil { t.Fatal(err) }
    defer first.Close()
    second, err := OpenStore(dir)
    if err == nil { second.Close(); t.Fatal("允许了并发写者") }
}
```

- [ ] 运行 `go test ./internal/imaging -run 'Store|Snapshot|Recovery' -v`，先见失败，再实现并通过；`go test -race ./internal/imaging` 在工具链支持 race 的环境执行，不支持时明确记录。

**验收：**恢复后每个 durable 事件只出现一次，job 与事件 revision 一致；损坏不能当空存储启动。

## Task 2：幂等和事件索引

**Consumes：**01 HashRequest、Scope。

**Produces：**事务中的 `GetIdempotency(scope,key)` 与 `PutIdempotency(scope,key,hash,jobId)`；`ReadEvents` 实现。

- [ ] owner/backend/key 唯一，两个并发相同请求只能创建一个 job；不同 hash 返回409。
- [ ] cursor 用不可伪造/带校验的 owner-scoped 索引位置，按 createdAt+id 稳定分页。校验 limit 1—100；分页过滤权限不可只在第一页执行。
- [ ] 事件为每个 job 递增 seq，job state 与 event 同事务；恢复不重复 accepted。
- [ ] 删除后的幂等 tombstone保留30天；回放范围外返回 IMAGE_EVENT_GAP，客户端可读 snapshot。
- [ ] 运行 `go test ./internal/imaging -run 'Idempotency|Events|Pagination' -v`；测试核对最终 job 数和 accepted 数，而非只看走了去重分支。

## Task 3：资产导入、缩略图与输出下载

**Produces：**design 的 ImportAsset/OpenAsset，以及私有 `SaveOutput(ctx,scope,OutputSource) (ImageAsset,error)`。

- [ ] 测试真 PNG、JPEG、WebP；文件声明png却内容非图、超大小、超像素、截断、空图都拒绝。fixture 用小型合成图片。
- [ ] stream到独立临时文件计算hash，限制bytes并DecodeConfig，再解码确认格式。原图按hash原子落盘，缩略图最长边512；公开资产ID独立于hash。
- [ ] 同内容不同 owner 可内部去重，但必须有独立 owner资产记录，不能让知道hash的人读到图片。
- [ ] 原图落盘后事务保存asset记录和job结果引用，再回成功；事务失败留孤儿文件待GC。恢复缺文件时资产标记不可用，任务不能显示完整成功。
- [ ] 下载先验证HTTPS和域名/IP，阻止localhost、私网、link-local、metadata地址；每次重定向和实际Dial解析都验证，最多3跳。目标配置的可信本地许可为白名单，不能让用户提示词放宽。
- [ ] 上游URL/base64在Adapter解析，非法base64和超限解码拒绝；URL只后端使用。最大输出100MiB/100MP。
- [ ] multipart上传使用MaxBytesReader，限制临时文件总量并清理；图片读接口支持HEAD、Content-Type、Content-Length和私有缓存策略；取消读取不删除资产。
- [ ] 运行 `go test ./internal/imaging ./internal/backend -run 'ImageAsset|Download|SSRF|Thumbnail' -v`。

**验收：**重启后能读原图；资产 ID 无权限返回404；输出下载失败不能标成功；日志无签名URL和base64正文。

## Task 4：项目与版本引用、删除/GC

**Produces：**项目CRUD和parentAssetIds，HTTP路径遵design。

- [ ] 新建项目只生成后端owner，workspaceRef为关联字符串，不授权文件系统访问。PATCH使用expectedRevision。
- [ ] parentAssetId必须是当前owner可访问的输入资产；循环或跨owner关系拒绝。多图任务修改某张图时保留准确父资产。
- [ ] 删除项目前拒绝有执行中任务的删除（409 IMAGE_PROJECT_BUSY），或用户先取消；完成项目删除变tombstone并隐藏历史，不清理被其他项目引用的资产。
- [ ] 引用计数从durable记录重建；GC两阶段标记、24小时后复查再删，避免引用竞态。临时上传7天未引用才候选，用户作品不自动过期。
- [ ] 运行 `go test ./internal/imaging ./internal/backend -run 'ImageProject|ParentAsset|GC' -v`。

**人工验收：**创建项目、上传合成图、读取缩略图与原图；重启后仍存在；另一作用域读相同ID失败；建立分支版本后删除一个项目，不破坏另一项目引用。上述可用测试后端完成，无真实生图调用。
