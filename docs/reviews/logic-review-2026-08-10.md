# Agent DevTools 逻辑审查

- 审查日期：2026-08-10
- 审查对象：`claude/bluepoint-markdown-read-fnltwu` 分支全量代码（`8125417..aaa95fa`），覆盖 `src/core`、`src/server`、`src/web` 全部逻辑文件
- 标准来源：`AGENTS.md`（架构与安全约束）、`README.md`（行为与安全承诺）、`package.json`、`tsconfig*.json`
- 与前次审查的关系：`docs/reviews/code-review-2026-08-10.md` 列出的 CR-01..06 / ST-01..03 已全部修复并验证，本次不重复；本报告是一次独立的全量逻辑复审

## 结论摘要

代码通过 typecheck、build 和 45 项测试。本次发现 11 个问题，其中 2 个高优先级：

1. **SSE 响应按字节边界解码**，导致任何跨 chunk 边界的多字节字符被破坏。这不只是显示问题——损坏的文本会进入指纹，使下一轮的历史前缀匹配失败，产生重复的 assistant 节点和虚假的「History rewound」横幅。已用脚本复现。
2. **`--no-persist` 模式下 body 永不从内存卸载**，且 `drain()` 从不被调用导致 dirty 集合无限增长。该模式退化回 `README.md` Storage 一节明确说要解决的那个问题。

其余为 1 个中等安全问题（Clear 端点可被 CSRF）、2 个中等正确性/性能问题，以及若干低优先级项。

---

## 正确性与安全

### [高] CR-01 SSE 分块按字节边界解码，破坏多字节字符并污染指纹

- **位置**：`src/server/proxy.ts:107`、`src/core/sse.ts:15`
- **证据**：`SseParser.push()` 接收的是已解码的 `string`，而 proxy 对每个 TCP chunk 单独调用 `chunk.toString('utf8')`。UTF-8 多字节序列被 chunk 边界切开时，两半各自解码成替换字符。实测复现：

  ```
  输入 frame:  data: {"delta":{"text":"你好世界"}}
  在 '你' 的第 1 字节后切分
  解析结果:    "���好世界"
  ```

  对比同文件的请求体和非流式响应体路径（`proxy.ts:123`、`proxy.ts:160`）——那两处先 `Buffer.concat` 再整体 `toString`，是正确的；只有 SSE 路径按 chunk 解码。
- **触发**：任何一个多字节字符（中文、日文、emoji、部分排版符号）恰好落在 TCP chunk 边界上。流式响应的 chunk 边界由网络决定，与内容无关，所以这是概率事件而非特例。中文输出的会话里几乎必然发生。
- **影响**（按严重度递增）：
  1. Chat Trace 里的 assistant 文本出现 `�`。
  2. `Raw` 和 `SSE` 面板展示的所谓「线上原始字节」并不是原始字节。这与工具的核心承诺直接冲突——`ContentViewer` 的注释写着「every rendered view has to be checkable against the bytes that went over the wire」，而此处那个基准本身已被污染。
  3. **最严重**：`trace-builder.ts:458` 用这段损坏文本计算 `fp` 并存入 `state.fps`/`producedFps`。下一轮请求的 history 携带的是**正确**文本，指纹不同 → `commonPrefixLength` 在该处截断 → `attachToConversation` 判定为历史回退，追加「History rewound」节点，并把整段 assistant 输出当作新信息重新 append。结果是重复消息 + 虚假横幅。
- **不受影响的部分**：`proxy.ts:102` 先把原始 `Buffer` 转发给客户端再做解码，所以 agent 侧收到的字节是完好的。这纯粹是抓包侧的污染。
- **建议**：为每个 record 持有一个 `node:string_decoder` 的 `StringDecoder('utf8')`，用 `decoder.write(chunk)` 替换 `chunk.toString('utf8')`，并在 `upstreamRes.on('end')` 里 `decoder.end()` 后再 `parser.end()`。回归测试：构造一个在多字节字符内部切分的两段 chunk，断言解析出的文本与整体解码一致。

### [高] CR-02 `--no-persist` 下 body 永不卸载，dirty 集合无限增长

- **位置**：`src/server/runtime.ts:98-120`、`src/core/trace-builder.ts:490`
- **证据**：`persistAndOffload()` 第二行是 `if (!persistence) return;`，而卸载语句（`record.requestBodyRaw = undefined` 等，`runtime.ts:109-114`）、`builder.drain()`（`runtime.ts:103`）和 `persistence.sweep()` 全都在这行之后。`drain()` 在整个代码库中只有这一个调用点（已 grep 确认）。
- **影响**：
  1. 每条请求的 `requestBodyRaw` 与解析后的 `requestBody` 双份常驻内存，唯一上限是 `maxRequests`（默认 5000，`config.ts:56`）。按 README 自己给的 ~233 kB/turn，raw 加解析对象很容易到 GB 级——正是 `README.md` Storage 一节说「a normal working session could exhaust memory」而引入持久化要解决的那个问题。
  2. `dirtyNodeIds` / `dirtyConversationIds` 永不清空，随节点数单调增长。
  3. retention 完全不运行，`README.md:311` 的「Under an active retention cap, resident size plateaus」在该模式下不成立；同段落给出的「+80 MB with `--no-persist`」是 150 请求的测量值，没有反映无上限增长的性质。
- **建议**：把「卸载 body」和「drain 并丢弃」从持久化分支里拆出来，无论 persistence 是否存在都执行；`--no-persist` 的语义应是「不落盘」，不是「不做生命周期管理」。同时修正 README 对该模式内存行为的描述。

### [中] CR-03 `POST /api/clear` 可被任意网页 CSRF

- **位置**：`src/server/api.ts:73-76`
- **证据**：API 无认证、无 CORS 中间件、不校验 `Origin`。`POST` 且不带自定义请求头属于 CORS「simple request」，浏览器不发预检直接送达 `127.0.0.1:4142`。
- **触发**：用户在浏览任意网页时，该页面执行 `fetch('http://127.0.0.1:4142/api/clear', {method:'POST', mode:'no-cors'})`。
- **影响**：静默清空全部 trace（内存 + SQLite）。读取端点不受影响——没有 `Access-Control-Allow-Origin`，跨域页面发得出请求但读不到响应，所以这是破坏性而非泄露性问题。`DELETE /api/conversations/:id` 因方法非 simple 会触发预检，被 CORS 挡住。
- **与规范的关系**：`AGENTS.md` 写的是「Never expose credential reveal or destructive endpoints on an unauthenticated non-loopback listener」。当前监听确实强制 loopback（`config.ts:45`），但 loopback 对本机浏览器是可达的，这条约束的实际保护范围比字面小。
- **建议**：要求一个自定义请求头（如 `x-agent-devtools: 1`）——它会强制预检，而预检因无 CORS 头被拒；或直接校验 `Origin` / `Sec-Fetch-Site: same-origin`。前端 `src/web/api.ts` 相应带上该头。

### [中] CR-04 无工具的一次性对话不会进入 Chat Trace

- **位置**：`src/core/adapters/anthropic.ts:222-227`
- **证据**：`classify()` 在 `toolCount === 0 && messageCount <= 2` 时返回 `utility`，该 kind 不建 conversation、不进 trace（`trace-builder.ts:75-79`）。
- **触发**：不声明 tools 的调用方——`detectAgent()` 明确认得的 `anthropic-sdk` 和 `mastra` 都属于这一类。
- **影响**（准确范围）：
  - **单轮对话完全不出现在 Chat Trace 中**（只在 Network 视图可见）。这是真正的损失。
  - 多轮对话从第 3 条消息起才被识别。此时 `createConversation` + `revealNewHistory` 会把完整 history 一次性补齐，所以**前两轮内容并不丢失，只是延迟出现**。
  - 该启发式的注释只论证了 Claude Code 的场景（标题生成、count_tokens），没有覆盖 `detectAgent` 自己列出的另外两类 agent。
- **建议**：把 utility 判定收敛到明确信号——`count_tokens` 路径已经足够；标题生成调用可用更具体的组合（已知的小模型 + 极小 `max_tokens` + 单条消息）识别，而不是「消息数少」这个会误伤真实短对话的代理指标。

### [中] CR-05 图片/文档块的 fingerprint 覆盖整个 base64 负载

- **位置**：`src/core/adapters/anthropic.ts:317`
- **证据**：`fingerprint(block.type, block)` 会先 `stableStringify` 整个块（含 `source.data` 的完整 base64），再由 `fingerprint()` 逐字符 `charCodeAt` 遍历（`fingerprint.ts:27`）。
- **触发**：会话中出现图片或文档附件。由于**每轮请求都重发完整 history**，同一张图片在每一轮都会被重新序列化并完整哈希一遍。
- **影响**：一张 5 MB 图片 ≈ 每轮 500 万次字符迭代，外加一次同等长度的字符串拼接。这段代码运行在 `onRequestBody` 的同步栈上，即转发路径内——与 `AGENTS.md`「Do not add bookkeeping that delays the client stream」的意图相悖。多图会话每轮可达数十毫秒至秒级。
- **建议**：只对稳定标识做指纹（`type` + `source.media_type` + `data.length` + 首尾各 64 字符），或对大块做一次性哈希并缓存。指纹只需在同一会话内区分不同块，不需要抗碰撞——`fingerprint.ts:21` 已经这样声明过。

### [低] CR-06 upstream 出错且响应已开始时，错误 JSON 被追加到已发出的流尾部

- **位置**：`src/server/proxy.ts:141-149`
- **证据**：`res.writeHead(502, ...)` 有 `!res.headersSent` 保护，但紧随其后的 `res.end(JSON.stringify({...}))` 无条件写入 body。
- **触发**：响应头已转发、SSE 已开始推送之后，`upstreamReq` 才发生 error（连接被中途重置等）。
- **影响**：agent 在 SSE 流末尾收到一段非 SSE 的 JSON 文本，可能触发客户端解析错误，且错误信息与真实原因无关。
- **建议**：`res.headersSent` 时只 `res.end()`，把错误信息留在 `record.error` 里给 Inspector。

### [低] CR-07 静态文件根目录前缀校验缺少路径分隔符

- **位置**：`src/server/api.ts:203`
- **证据**：`candidate.startsWith(resolve(root))` —— `/x/dist/web` 与 `/x/dist/web-secret` 满足同一前缀。
- **现状**：当前**不可利用**，因为上一行的 `normalize(urlPath)` 已把绝对路径里的 `..` 折叠掉，`resolve` 的结果不会跳出 root。
- **建议**：改为比较 `resolve(root) + sep`，让安全性由这一行自证，而不是依赖上游 `normalize` 的具体行为。属于纵深防御，不是当前漏洞。

### [低] CR-08 三层及以上的子 agent 会话在侧边栏不可见

- **位置**：`src/web/components/ConversationList.tsx:145-172`
- **证据**：只渲染 `roots ∪ orphans` 及其**直接**子级，`childrenOf()` 不递归。
- **触发**：A → B → C 的嵌套。C 的父级 B 存在（所以不算 orphan），但 B 是作为子行渲染的，不会再展开它自己的子级。
- **影响**：C 的数据完整存在于 store 和 DB，但 UI 里没有入口。
- **可达性**：需要子 agent 自身再发起 `Task` 调用，Claude Code 默认不给子 agent 该工具，所以目前是潜在缺陷。
- **建议**：递归渲染并限制缩进深度。

### [低] CR-09 `api.clear()` 不检查响应状态

- **位置**：`src/web/api.ts:49`
- **证据**：`clear: () => fetch('/api/clear', { method: 'POST' })` 直接返回，未检查 `res.ok`；同文件的 `deleteConversation` 做了检查。`App.tsx` 的 `.then(refresh)` 无条件执行。
- **影响**：服务端 clear 失败时 UI 无任何提示，刷新后原样数据回来，看起来像「点了没反应」。
- **建议**：与 `deleteConversation` 保持一致。

### [低] CR-10 敏感 header 遮蔽是固定名单

- **位置**：`src/core/redact.ts:9-17`
- **证据**：`SENSITIVE_HEADERS` 是一份七项的固定集合。`x-goog-api-key`、`api-key`（Azure OpenAI）、自定义网关 token 等都不在其中。
- **影响**：这些 header 会以明文写入 SQLite（`persistence.ts:160`）并在未 reveal 时明文返回给 UI。与 `AGENTS.md`「Redact sensitive headers before persistence」的意图有缺口。
- **建议**：补充已知名单，并加一条模式兜底（名字含 `key` / `token` / `secret` / `auth` 的 header 一律遮蔽），保留精确名单用于决定遮蔽格式。

### [低] CR-11 流式 assistant 气泡被选为 diff 源后，按钮选中态会掉

- **位置**：`src/web/components/DiffSourceButtons.tsx:35-41`、`src/web/components/TraceView.tsx:236`
- **证据**：`isSelected()` 要求 `selected.text === source.text`。assistant 气泡在流式过程中 `text` 每帧变化，而 `git-diff` 里存的是点击那一刻的快照。
- **影响**：对正在流式输出的消息点 `Diff Left`，下一帧按钮就显示为未选中，尽管 diff 状态里仍持有它。diff 对话框显示的是点击时刻的文本——行为本身合理，只是按钮状态与之不符。
- **来源**：本次变更（`a59b647`）给气泡加上 diff 按钮后才出现；此前只有内容不变的 context/system 块有这些按钮。
- **建议**：`isSelected()` 只比较 `sourceId` + `format`，让 `text` 仅作为快照内容存在。

---

## 规范与可维护性

### [中] ST-01 Claude Code 专有知识留在 provider 中立层

- **位置**：`src/core/trace-builder.ts:199`（硬编码工具名 `'Task'`）、`src/core/trace-builder.ts:650`（硬编码 `<system-reminder>` 标签名）
- **冲突**：`src/core/types.ts:5` 声明「Nothing in here may reference an Anthropic-specific shape」；`AGENTS.md` 要求「Add provider behavior through a `ProviderAdapter`」。`'Task'` 是 Claude Code 的子 agent 工具名，`<system-reminder>` 是 Claude Code 的注入格式——两者都不是协议层事实，而是某个 agent 运行时的约定。
- **对比**：同一份代码在别处守住了这条线——`readSessionId()` 把 `x-claude-code-session-id` 留在 adapter 里，注释明确写「Kept in the adapter, not the builder: the header name is a wire detail」。这两处是同类知识放错了层。
- **建议**：由 adapter 提供子 agent 工具名集合（如 `ParsedRequest.subagentToolNames`），标题清洗规则同样下沉到 adapter。

### [低] ST-02 主题初始化逻辑存在两份

- **位置**：`src/web/theme.ts:7` 的 `resolveInitialTheme()` 与 `src/web/index.html:10-23` 的内联脚本
- **证据**：`resolveInitialTheme` 全仓库无引用（已 grep 确认），内联脚本重复了它的完整逻辑，包括 storage key 字面量 `'agent-devtools:theme'`。
- **影响**：两份必须手工保持同步的逻辑，其中一份是死代码。
- **建议**：删除未使用的导出，并在内联脚本处注明它是首屏主题的唯一来源。

### [低] ST-03 一次 drain 产生数十个独立事务

- **位置**：`src/server/runtime.ts:103-107`
- **证据**：`for (const node of nodes) persistence.saveNode(node)` —— 每次 `saveNode` 是一条独立的 `SELECT` + `INSERT/UPDATE`，各自处于隐式事务中。一次工具密集的 turn 会 drain 出数十个节点。
- **缓解**：`journal_mode = WAL` + `synchronous = NORMAL` 已经显著降低单次成本。
- **建议**：用一个 `BEGIN IMMEDIATE` / `COMMIT` 包住整轮 drain 写入。

### [低] ST-04 `dropConversation` 是 O(n²)

- **位置**：`src/core/store.ts:125-131`
- **证据**：在遍历 `transport` 的循环内部对 `transportOrder` 调用 `indexOf` + `splice`。
- **影响**：`maxRequests` 默认 5000，退化情形约 2500 万次比较。retention 每次驱逐都会走这里。
- **建议**：先收集待删 id 到 Set，再对 `transportOrder` 做一次 `filter`。

---

## 检查过但认为无需改动的部分

记录这些是为了让后续审查知道哪些路径已经看过：

- **`CaptureRuntime` 的世代隔离**（`runtime.ts:130-135`）：`isCurrent()` 同时检查 generation 和已删除会话，`onComplete` 有 `completedRequests` WeakSet 去重，`deactivate` 与 `sweep` 的先后顺序保证刚完成的会话在本轮仍受保护。前次审查 CR-01/CR-02 的修复是完整的。
- **`Store.evictIfNeeded`**（`store.ts:67-72`）：先 push 再驱逐再 set，顺序正确；驱逐 transport 后节点上的 `producedByRequestId` 变悬空，UI 有对应的空态文案。
- **`SseParser.findSeparator`**（`sse.ts:42-48`）：CRLF/LF 混合的优先级判断正确，已用 `"a\n\nb\r\n\r\nc"` 这类输入推演过。
- **`Persistence.repairNodeSequences`**（`persistence.ts:354-395`）：先整体偏移再重排，在唯一索引已存在的情况下也安全。
- **`stableStringify`**（`fingerprint.ts:6-14`）：键排序 + 丢弃 `undefined`，保证流式重组的 tool input 与 history 里的对象哈希一致。
- **本次变更（第 4-11 项）的新代码**：`focusBodyField` 的 kind 映射、`Section` 受控模式、`JsonBodyViewer` 的 `fieldKey` 记忆化（按内容而非数组身份，避免流式重渲染踩掉手动展开）、`useFollowNewest` 的 sticky 判定——除 CR-11 外未发现问题。

---

## 验证结果

在本报告对应的代码状态（`aaa95fa`）上执行：

- `pnpm typecheck`：通过
- `pnpm test`：45/45 通过
- `pnpm build`：通过
- **CR-01 定向复现**：脚本构造一个在 `你` 字第 1 字节后切分的 SSE chunk 对，解析结果为 `"���好世界"`，确认字符损坏
- **CR-02 定向核实**：grep 确认 `builder.drain()` 全仓库仅 `runtime.ts:103` 一处调用，位于 `if (!persistence) return` 之后

**未验证的部分**：本次审查在无真实 agent 流量的环境下进行，CR-01 的下游影响（重复 assistant 节点、虚假 History rewound 横幅）是依据 `trace-builder.ts` 的指纹匹配逻辑推导的，未做端到端复现。CR-03 的 CSRF 未实际构造攻击页面验证，结论基于「无 CORS 中间件 + POST 属 simple request」的代码事实。

## 数量摘要

| 轴 | 数量 | 最严重项 |
| --- | --- | --- |
| 正确性与安全 | 11（2 高、3 中、6 低） | CR-01 SSE 多字节解码破坏指纹 |
| 规范与可维护性 | 4（1 中、3 低） | ST-01 Claude Code 专有知识留在 core |
| 规格符合性 | 0（无原始 spec；`docs/bluepoint.md` 的记录项已全部实现并逐项提交） |

## 建议的处理顺序

1. **CR-01** —— 唯一一个会污染数据正确性、且在中文会话里几乎必然触发的问题，修复面很小（换成 `StringDecoder`）。
2. **CR-02** —— 一行位置调整，消除 `--no-persist` 的无界内存增长。
3. **CR-03** —— 一个 header 校验，消除本机浏览器可达的破坏性端点。
4. **CR-05 / ST-01** —— 分别影响转发路径耗时与架构边界，改动范围中等。
5. 其余低优先级项可并入日常清理。
