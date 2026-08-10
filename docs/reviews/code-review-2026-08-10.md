# Agent DevTools 代码审查

- 审查日期：2026-08-10
- 审查对象：当前工作区快照（`main` 之后的 `feat-ui` 分支内容，加上已暂存和未暂存改动）
- 对比提交：`76aed80..1337213`
- 标准来源：`README.md`、`package.json`、`tsconfig*.json`、`vite.config.ts`
- 规格来源：未找到原始 issue/spec；因此不对“是否完整实现原始需求”作结论

## 结论摘要

当前代码可通过 TypeScript 检查和生产构建，但持久化和缓存清理路径存在 3 个高优先级问题：Clear 没有清理 TraceBuilder，retention 会误删另一个在途会话，以及可通过配置将未认证的敏感 API 暴露到非 loopback 网络。项目当前没有自动化测试脚本，这些跨重启、并发和清理场景缺少回归保护。

## 正确性与安全

### [高] CR-01 Clear 只清存储，没有清理重建器状态

- 位置：`src/server/api.ts:55-58`、`src/core/store.ts:134-139`、`src/core/trace-builder.ts:43-51,484-527`
- 证据：`POST /api/clear` 只调用 `store.clear()` 和 `persistence.clear()`；`TraceBuilder` 仍保留 conversations、streams、pending tool calls 和 dirty sets。
- 触发：清空后，原 agent 继续发送带旧 transcript 的请求，或 Clear 时恰有响应正在流式输出。
- 影响：请求仍会匹配已从 Store/DB 删除的 conversation id；节点在 UI 中不可见，DB 可产生孤儿记录，在途数据还可被重新写回。
- 建议：为 `TraceBuilder` 实现原子 `reset()`，与 Store/DB 一起清理；明确 Clear 时在途请求的取消或世代隔离策略。

### [高] CR-02 retention 只保护刚完成的会话，可误删其他在途会话

- 位置：`src/server/index.ts:57-76`、`src/server/persistence.ts:245-263`
- 证据：`sweep()` 只接收一个 `activeConversationId`，即当前刚完成的 record，并不知道其他正在流式输出的 conversation。
- 触发：会话 A 完成并使容量超限，同时较旧的会话 B 仍在流式输出。
- 影响：B 可被从 DB、Store 和 Builder 中删除；后续 frame 丢失，完成时又可写入不可达的 transport。
- 建议：跟踪所有在途 conversation id，sweep 时全部排除；增加双会话交错流式响应的小容量回归测试。

### [高] CR-03 可将未认证的敏感 API 暴露到非 loopback 网络

- 位置：`src/server/config.ts:31-42`、`src/server/index.ts:79-99,125-136`、`src/server/api.ts:38-58`
- 证据：`AGENT_DEVTOOLS_HOST=0.0.0.0` 会让代理和 API 对外监听；API 无认证，`GET /api/transport/:id?reveal=1` 可返回进程内真实凭据，`POST /api/clear` 可删除数据。
- 影响：同网段访问者可读取源码/请求和 API key，或删除 trace。这也与 `README.md:206-216` 的安全保证冲突。
- 建议：默认并强制只允许 loopback；若确需远程访问，则强制随机 bearer token，禁用远程 reveal，并加 Origin/CSRF 防护。

### [中] CR-04 重启后可复用节点排序号，导致 trace 恢复顺序不确定

- 位置：`src/server/persistence.ts:126-132,218-223`
- 证据：节点更新也会执行 `nodeSeq++`，但 upsert 冲突分支不更新 `seq`；重启时又用 `nodes.length` 恢复计数，而非 `MAX(seq) + 1`。
- 复现：保留 `seq=1,2` 的两个节点、删除早期节点并重启后，新节点被写为 `seq=2`，SQLite 中出现重复序号。
- 影响：`ORDER BY seq` 对同序号节点没有稳定顺序，再次恢复可打乱会话 trace。
- 建议：仅 INSERT 时分配 `seq`；启动时从 `COALESCE(MAX(seq), -1) + 1` 恢复，并为排序建立明确唯一性保证。

### [中] CR-05 单个活跃会话可无限超过持久化容量上限

- 位置：`src/server/persistence.ts:245-284`
- 证据：唯一剩余的 conversation 是 active 时，sweep 不删它；若又无 orphan，循环直接 break。
- 影响：长会话的 DB 可持续增长，与 `README.md:197-204` 所表达的字节上限不一致。
- 建议：定义超大活跃会话的硬上限策略，例如按最旧请求裁剪 bodies，同时保留元数据；文档中说明精确语义。

### [中] CR-06 Node 运行时要求没有声明

- 位置：`src/server/persistence.ts:3`、`package.json:1-41`、`README.md:19-25`
- 证据：默认启动路径直接导入 `node:sqlite`，但 `package.json` 没有 `engines.node`，README 也没有 Node 版本前置条件。
- 影响：使用不包含 `node:sqlite` 的 Node 版本时，安装/构建可能看似正常，但服务启动失败。
- 建议：在 `package.json` 声明并在 README 写明受支持的 Node 主版本，CI 使用同一范围。

## 规范与可维护性

### [高] ST-01 Provider 协议解析泄漏到 UI

- 位置：`src/web/components/Inspector.tsx:510-548`、`src/core/adapters/anthropic.ts:40-114`
- 类型：硬性架构冲突；判断性 Duplicated Code / Repeated Switches。
- 证据：Inspector 再次解释 Anthropic 的 `content_block_start`、`content_block_delta` 和 `message_delta`，而同样的协议分支已在 adapter 中。这与 `README.md:103-126` 声明的“UI provider-agnostic、新 provider 只需 adapter”冲突。
- 建议：由 adapter 产出统一的 assembled response/展示块，UI 只渲染统一模型。

### [高] ST-02 安全文档与可配置监听行为冲突

- 位置：`README.md:206-216`、`src/server/config.ts:31-42`
- 类型：硬性文档冲突。
- 证据：README 保证两个服务只绑定 `127.0.0.1`，但 `AGENT_DEVTOOLS_HOST` 允许改变监听地址，且没有相应的认证边界。
- 建议：代码强制 loopback，或将非 loopback 模式设计为明确的受保护功能并修正文档。

### [低] ST-03 主题说明过度绝对

- 位置：`README.md:140-145`、`src/web/App.tsx:35,100-104,173-184`
- 类型：硬性文档冲突。
- 证据：README 称“没有组件知道当前主题”，但 App 将 `theme` 显式传给 Header/ThemeToggle。实现仍遵守了颜色 token 边界，问题主要在文档表述。
- 建议：将文档收窄为“业务组件不作颜色决策”，或让 ThemeToggle 自行消费 theme context。

## 规格符合性

无可用原始 issue/spec，本轴跳过。`README.md` 只用作当前行为与架构承诺的标准来源，不替代产品需求。

## 验证结果

- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- 持久化排序针对性复现：成功产生两条 `seq=2` 记录，确认 CR-04。
- 自动化测试：`package.json:10-16` 无 test 脚本，仓库中未找到测试套件。

## 工作区交付风险

审查期间工作区发生了并发改动：`.scratch/*` 一度呈现“暂存新增、工作树删除”，随后该状态被外部更新；同时新增了 `src/server/quiet-sqlite-warning.ts`。本次审查没有改动这些用户内容，并在最终状态上重新执行了 typecheck/build。由于暂存区与工作树仍可不同，提交前应再次人工检查 `git status --short`、`git diff`和 `git diff --cached`。

## 数量摘要

- 正确性/安全：6 项（3 高、3 中）；最严重的是 Clear 状态分裂、并发 retention 误删和敏感 API 非 loopback 暴露。
- 规范/可维护性：3 项（2 高、1 低）；最严重的是 provider 协议解析泄漏到 UI 以及安全文档与实际配置冲突。
- 规格：0 项（无可用 spec）。
