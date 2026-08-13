# Bug:带全量历史的副调用会被重建成一条重复会话

- 报告日期:2026-08-13
- 涉及代码:`src/core/adapters/anthropic.ts`(`classify`、`systemFp`)、`src/core/trace-builder.ts`(`attachToConversation`、`sameSession`)
- 发现方式:在 Claude Code 中执行 `/goal`、`/loop` 后,会话列表出现重复条目;根因通过查询真实抓包库(`~/.claude-devtools/traces.db`)的会话与请求元数据定位
- 状态:**未修复**,本报告用于评审修法。建议的改动只有一行,但涉及 trace 重建语义,按 `AGENTS.md` 需配回归测试
- 标准来源:`AGENTS.md`(架构约束)、`README.md`(重建行为承诺)

## 症状

在 Claude Code 里执行 `/goal`、`/loop` 这类 slash command 后,devtools 的会话列表里出现**两条内容几乎相同的会话**:同一个 sessionId、同样的工具调用序列。其中一条是完整对话,另一条是它的镜像。

## 证据(来自真实抓包库)

同一 session `c870b55b`,被拆成两条会话:

| | conv_38 | conv_57 |
| --- | --- | --- |
| 请求数 | 6 | 1 |
| tool_call 序列 | Bash, Edit, Bash, Bash | Bash, Edit, Bash, Bash(相同) |
| parentConversationId | 无 | 无 |

逐请求看请求形状:

```
── conv_38
   13:19:13  kind=conversation tools=172  msgs=1   sysLen=29951
   13:19:26  kind=conversation tools=172  msgs=4   sysLen=29951
   13:19:30  kind=conversation tools=172  msgs=6   sysLen=29951
   13:19:37  kind=conversation tools=172  msgs=8   sysLen=29951
   13:19:48  kind=conversation tools=172  msgs=10  sysLen=29951
   13:19:51  kind=conversation tools=172  msgs=12  sysLen=29951
── conv_57
   13:19:51  kind=conversation tools=0    msgs=12  sysLen=1781    ← 问题请求
```

conv_57 只有一个请求,和 conv_38 最后一个请求**同一秒**发出,特征是:

- `tools = 0`(没有声明任何工具)
- `msgs = 12`(带了全量历史)
- `system` 长度 1781,而主会话是 29951;两者共同前缀只有 80 字符(5%),不是包含关系

即:这是一次**副调用**(摘要 / 标题生成之类),它把整段 transcript 重发了一遍,但用的是一个短的、不同的 system prompt。

## 根因链

三步导致重复:

**第 1 步 — 分类判错。** `src/core/adapters/anthropic.ts:244`

```js
function classify(path, toolCount, messageCount, sessionId) {
  if (path.includes('count_tokens')) return 'utility';
  if (toolCount > 0) return 'conversation';
  if (sessionId !== undefined && messageCount <= 1) return 'utility';  // msgs=12,不命中
  return 'conversation';                                                // ← 落到这里
}
```

启发式假设"副调用一定很短"(`messageCount <= 1`)。这个副调用带了 12 条历史,于是被判成 `conversation`。

**第 2 步 — 会话匹配失败。** `src/core/trace-builder.ts:820`

```js
function sameSession(state, provider, sessionId, systemFp) {
  if (state.provider && state.provider !== provider) return false;
  if (state.sessionId && sessionId && state.sessionId !== sessionId) return false;
  return state.systemFp === systemFp;   // ← 严格相等
}
```

`systemFp = fingerprint('system', system)`(`anthropic.ts:43`),是整个 system prompt 的指纹。29951 字符 vs 1781 字符 → 指纹不同 → `sameSession` 返回 false。

**第 3 步 — 新建会话。** `trace-builder.ts` 的 `attachToConversation` 遍历所有会话找 `sameSession` 且有公共前缀的候选,一个都没匹配上,于是 `createConversation()`。因为这个请求带着全量历史,`revealNewHistory` 把 12 条消息全部重建了一遍——所以新会话是主会话的完整镜像。

## 建议的修法

改分类,而不是改识别规则。`anthropic.ts:244`:

```diff
- if (sessionId !== undefined && messageCount <= 1) return 'utility';
+ if (sessionId !== undefined && toolCount === 0) return 'utility';
```

依据:Claude Code 的主对话循环**每个请求都会带上完整工具表**(本例 172 个)。`tools = 0` 说明它不是对话轮次,与它带了多少历史无关。这比"消息条数少"可靠得多。

改完之后,该请求走 `attachSideCall()`(`trace-builder.ts:106` 的 `parsed.kind !== 'conversation'` 分支),会作为 Background activity 挂在同一 session 的 trace 上,且**不进入 `state.fps`**——这点很关键,因为 fps 是后续请求做 prefix-diff 的基准,把一条没有任何轮次会重复的消息折进去会在历史头部留下永久幻影。

## 请不要用"去掉 systemFp"这个修法

看上去只按 sessionId 归类就能解决,但会引入更严重的问题:**Task 子代理复用父会话的 sessionId**(`anthropic.ts:204`,`isSubagentTool` 即 `toolName === 'Task'`),只靠 sessionId 的话:

```
主会话  sessionId=abc  system=<29KB 完整提示词>
子代理  sessionId=abc  system=<子代理专属的小提示词>   ← 会被并进主会话
```

子代理整条 trace 会混进父对话,穿插在父的消息之间,工具调用归属也会错乱。systemFp 正是为切开这一刀而存在的。

## 想请你评估的点

1. **`tools === 0` 这个判据是否足够稳。** 有没有哪种 Claude Code 的**正常对话轮次**会不带工具表?(比如全局禁用工具、某些 output style、`--no-tools` 之类的场景)如果存在,这个修法会把真实轮次误判成副调用而从 trace 里隐藏——比现在的重复更糟。
2. 是否应该保留 `messageCount <= 1` 那一条作为兜底(两条 OR),还是直接替换。
3. 有没有比"看 tools 数量"更本质的判据。理论上更可靠的是看**响应**是否进入了主 transcript,但 `classify()` 在请求阶段就要出结果,拿不到响应。
4. `sameSession` 用整个 system prompt 的严格相等是否过紧。目前的设计是"同 session + 不同 system prompt = 不同 agent",分类修好之后这个前提是否还有别的漏网场景。

## 相关代码位置

| 文件:行 | 作用 |
| --- | --- |
| `src/core/adapters/anthropic.ts:244` | `classify()` — 问题所在 |
| `src/core/adapters/anthropic.ts:43` | `systemFp` 的计算 |
| `src/core/adapters/anthropic.ts:204` | `isSubagentTool()` → `'Task'` |
| `src/core/trace-builder.ts:106` | `onRequestBody()` — conversation / 副调用分流 |
| `src/core/trace-builder.ts:156` | `attachSideCall()` — 副调用挂载(修复后该请求走这里) |
| `src/core/trace-builder.ts:224` | `attachToConversation()` — 候选匹配与 prefix-diff |
| `src/core/trace-builder.ts:820` | `sameSession()` — 身份判定 |
| `src/core/trace-builder.ts:272` | `createConversation()` — 新建会话 |

## 约束

`AGENTS.md` 要求:改动 trace 重建行为必须配回归测试。本例的回归用例应为——**一个 tools=0、带全量历史、system prompt 与主会话不同的请求,不得新建会话**,同时保证子代理(Task,同 sessionId 不同 system prompt)仍然被正确切分为独立会话。
