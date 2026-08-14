# Claude DevTools Header 区域审查

- 审查日期：2026-08-10
- 审查对象：`claude/ui-review-2026-08-10` 分支（`9cbc17d`）的两块 header
  - **页面 header**（`src/web/App.tsx` 的 `Header`，`h-16`）：品牌锁定、连接指示、运行命令块 + Copy、upstream、Clear、Diff、主题切换
  - **Chat Trace header**（`App.tsx:207-224` 的视图栏，`h-12`）：Chat Trace / Network 选项卡、右侧 agent + model
- 标准来源：`AGENTS.md`（UI conventions）、WAI-ARIA Authoring Practices（Tabs pattern）、仓库内既有交互先例
- 方法：Chromium 实测——5 档视口宽度下的布局测量、剪贴板拒绝注入、无障碍属性提取、计数与实际渲染行数比对

## 结论摘要

布局本身是稳的：五档视口（1600 → 768）下 header **没有任何溢出**，运行命令块按设计让出宽度、右侧控件簇保持完整。问题都在**单个元素的行为与语义**上，共 6 项：

一个真实的运行时错误（Copy 按钮在剪贴板被拒时抛未捕获异常），一处因分组改造而失真的计数，一处选项卡无障碍语义用错，以及破坏性最强的操作反而是保护最弱的那一个。

---

## 页面 header

### [高] H-01 运行命令的 Copy 按钮：剪贴板被拒时抛未处理异常，且没有任何反馈

- **位置**：`src/web/App.tsx:301`
- **代码**：`onClick={() => void navigator.clipboard.writeText(command)}`
- **实测**：注入一个 reject 的 `writeText` 后点击，页面抛出 `pageerror: Write permission denied.`；按钮文案点击前后都是 `Copy`，没有任何状态变化。
- **触发**：非安全上下文、剪贴板权限被拒、或浏览器在无用户手势时拒绝写入。
- **影响**：
  1. 未捕获的 Promise rejection 会进到全局错误处理/控制台；
  2. 用户点了以为复制成功，实际什么也没发生——而这是首次使用者唯一需要的那条命令。
- **与仓库内既有做法的冲突**：`ui.tsx` 的 `useCopy` 已经把这件事做对了——它既有 1.2 秒的 `Copied` 反馈，也显式注释了为什么要吞掉 rejection（「A refused clipboard must not surface as an unhandled rejection. The button simply stays unchanged, which is the honest signal: nothing was copied.」）。`CopyButton` 和 `CopyIconButton` 都走这条路径，只有 header 这一个绕过了它。
- **修法**：导出 `useCopy`，header 的按钮改用它，保留自身的 code-card 配色。

### [中] H-04 Clear 没有确认，而破坏性更小的单会话删除有两步保护

- **位置**：`src/web/App.tsx:308`（`<Button onClick={onClear} tone="danger">Clear</Button>`）
- **对比**：单个会话的删除（`ConversationList.tsx:169-207`）需要**两步**——先点 `…` 打开菜单，再点 `Delete`；并且带 `Deleting…` 进行态和 `Retry delete` 失败态。
- **而 Clear** 一次点击就清空**全部**会话 + 全部 trace + 磁盘（`runtime.ts:clear()` 同时重置 builder、store 和 SQLite），不可撤销，按钮就夹在 `Diff` 和主题切换之间。
- **判断**：这不是我的偏好，是仓库自身的先例——保护级别与破坏力**反了**。
- **修法**：就地两步确认（点击后变为 `Confirm clear`，再点执行，数秒后自动复原），与删除的两步节奏一致，比模态轻。同时补进行态与失败态。

### [低] H-05 连接状态变化不会被辅助技术播报

- **位置**：`src/web/App.tsx:284-290`
- **实测**：`live` / `offline` 所在的 `<span>` 没有 `role` 也没有 `aria-live`。
- **影响**：SSE 断开时文案静默从 `live` 变成 `offline`，屏幕阅读器用户不会知道界面已经停止更新。
- **修法**：加 `role="status"`（隐含 `aria-live="polite"`）。

### [低] H-06 截断的运行命令与 upstream 无法通过悬停读全

- **位置**：`src/web/App.tsx:298`（`<code className="truncate">`）、`:305`（`max-w-[220px] truncate`）
- **实测**：命令块从视口 **1024px 起开始截断**，768px 时只剩 75px 可见宽度：

  | 视口 | 命令可见宽度 | 是否截断 |
  | --- | --- | --- |
  | 1600 | 354px | 否 |
  | 1280 | 354px | 否 |
  | 1024 | 331px | **是** |
  | 900 | 207px | **是** |
  | 768 | 75px | **是** |

- **影响**：Copy 仍然复制完整命令，所以功能没坏；但截断后没有任何方式读到全文。upstream 带 `max-w-[220px]`，指向任何真实远端主机时都会截断。
- **修法**：两处各加 `title`。

---

## Chat Trace header

### [中] H-03 Chat Trace 的计数与该视图实际渲染的行数不符

- **位置**：`src/web/App.tsx:211`（`count: nodes.length`）
- **实测**：

  | 选项卡 | 徽标数字 | 该视图实际渲染 |
  | --- | --- | --- |
  | Chat Trace | **8** | **5** 行 |
  | Network | 2 | 2 行 |

- **成因**：这是回合分组（`900f9f3`）引入的失真。分组前 8 个节点渲染 8 行，数字是对的；现在助手文本与其工具调用折叠进一个回合块，8 个节点渲染成 5 行。
- **问题不在数字本身，在同一个控件里两个徽标的语义不一致**：Network 的徽标是「这个视图有多少行」，Chat Trace 的徽标是「底层有多少节点」。并排放在一起时，读者只会用同一种方式理解它们。
- **补充**：节点数并没有因此丢失——侧栏的会话卡片已经显示 `2 req · 8 nodes`。
- **修法**：让 Chat Trace 的徽标数它实际渲染的条目数。

### [中] H-02 选项卡用的是导航语义，不是选项卡语义

- **位置**：`src/web/components/ui.tsx:61-93`（`Tabs`，同时驱动视图栏与 Inspector 的 7 个选项卡）
- **实测**：

  ```
  tablist role : null
  Chat Trace   : role=null  aria-selected=null  aria-current="page"
  Network      : role=null  aria-selected=null  aria-current=null
  ```

- **问题**：`aria-current="page"` 表达的是「一组页面链接中的当前页」，用在视图切换器上语义不对。没有 `role="tablist"` / `role="tab"` / `aria-selected`，屏幕阅读器只会读到两个普通按钮，其中一个被标成「当前页面」，完全传达不出「这是一组互斥视图，切换会更换下方内容」。方向键也不工作。
- **影响范围**：同一组件还驱动 Inspector 的 Overview / Headers / Payload / Response / SSE / Timing / Raw——那里有 7 个选项卡，问题被放大。
- **修法**：`role="tablist"` + `role="tab"` + `aria-selected` + `aria-controls`，配 roving tabindex 与方向键/Home/End，两处面板加 `role="tabpanel"`。**必须一起做**——只加 role 而不实现键盘模型，反而会向辅助技术宣称一个并不存在的交互契约。

---

## 检查过且判定良好的部分

- **布局在五档视口下不溢出**：1600 / 1280 / 1024 / 900 / 768 全部 `overflow=0`。品牌锁定与右侧控件簇是 `shrink-0`，命令块 `min-w-0 truncate` 主动让出宽度——正是 `App.tsx:274` 注释描述的行为。
- **两条 header 的下边框对齐**：`h-16` 与 `h-12` 各自固定，PR #1 修复后一直成立。
- **品牌锁定**：`SpikeMark` 带 `aria-hidden`，文字部分本身可读，无需额外标注。
- **主题切换**：有 `aria-label` 且随目标主题变化（`Switch to dark theme` / `Switch to light theme`）。
- **右侧控件簇的颜色角色**：`Clear` 用 `tone="danger"`，hover 才转为 error 前景色——符合「accent 稀缺」的既定约束，没有滥用强调色。
- **Chat Trace header 的 agent / model 只在 trace 视图显示**：考虑过让它在 Network 视图也显示，但会话身份在侧栏选中态里已经可见，这里留空不构成信息缺失，属设计取舍而非缺陷，**不改**。

---

## 数量摘要

| 区域 | 数量 | 最严重项 |
| --- | --- | --- |
| 页面 header | 4 项（1 高、1 中、2 低） | H-01 Copy 按钮抛未处理异常且无反馈 |
| Chat Trace header | 2 项（2 中） | H-03 计数与渲染行数不符 |
| 布局 / 响应式 | 0 项 | — |

---

## 修复记录（2026-08-10）

全部 6 项已在 `claude/header-review-2026-08-10` 分支处理。

| 编号 | 状态 | 修复摘要 |
| --- | --- | --- |
| H-01 | 已修复 | `useCopy` 从 `ui.tsx` 导出，header 的按钮改走这条共享路径，保留自身 code-card 配色。既拿到 `Copied` 反馈，也不再在剪贴板被拒时抛未处理异常。 |
| H-02 | 已修复 | `Tabs` 换成真正的选项卡：`role="tablist"` + `aria-label`、每项 `role="tab"` / `aria-selected` / `aria-controls`、roving tabindex（仅激活项在 tab 序列中），配 ←/→（环绕）与 Home/End；两处面板加 `role="tabpanel"` + `aria-labelledby`。视图栏与 Inspector 的 7 个选项卡同时受益。 |
| H-03 | 已修复 | Chat Trace 徽标改数 `groupTrace(nodes).length`，与 Network 的「行数」语义对齐。顺带把「空文本 assistant 块不渲染」的过滤从 `TraceView` 移进 `groupTrace`，让「trace 显示什么」只有一个定义——徽标数的正是它的结果。 |
| H-04 | 已修复 | Clear 改为就地两步：`Clear` → `Confirm clear` → 执行，4 秒未确认自动复原，并带 `Clearing…` 与 `Retry clear` 状态。`onClear` 相应改为在失败时 reject，由按钮呈现，而不是静默把连接指示打成 offline。 |
| H-05 | 已修复 | 连接指示加 `role="status"`。 |
| H-06 | 已修复 | 运行命令与 upstream 各加 `title`。 |

### 验证

浏览器实测（真实流量驱动）：

- **H-03**：徽标 `Chat Trace 6`，面板实际渲染 **6** 行——一致。
- **H-02**：`tablist` 标注为 `Views`；两项 `aria-selected` 互斥、`tabIndex` 0/-1、`aria-controls` 指向存在的面板；面板 `id=view-panel-trace` / `aria-labelledby=view-tab-trace`。键盘：→ 切到 Network，再 → 环绕回 Chat Trace。
- **H-01**：注入 reject 的 `writeText` 后点击，**未处理异常 0 个**（修复前为 `pageerror: Write permission denied.`）；注入 resolve 的 `writeText` 后，用 MutationObserver 观察到标签转换 `Copy → Copied → Copy`，且交给剪贴板的文本为完整命令。
  - 记一笔取样陷阱：点击后固定 250ms 读 `textContent()` 一度读到旧值 `Copy`，据此差点误判功能没生效；以 MutationObserver 观察全部转换才是可靠做法。
- **H-04**：首次点击后标签变为 `Confirm clear`，此时 trace 仍渲染 6 行——**没有任何东西被清除**。
- **H-05 / H-06**：`role="status"` 命中 `live`；`title` 分别为完整命令与完整 upstream。

其他：`pnpm typecheck` / `pnpm build` 通过；`pnpm test` **58/58**。

新增测试 1 项：空文本 assistant 块不成行，但同一响应的工具调用仍然开出它的回合（即「直接调工具、不说话」的 agent 不会消失）。既有的「节点边界闭合回合」用例同步补上文本——该用例原本依赖过滤发生在视图层，这次契约迁移被它挡下了。

### 未处理

- Chat Trace header 右侧的 agent / model 仍只在 trace 视图显示。会话身份在侧栏选中态已经可见，判定为设计取舍而非缺陷。
- 视口 768px 时运行命令只剩约 75px 可见。加了 `title` 之后可读，但窄视口下 header 的信息密度本身还有优化空间，未在本次范围内处理。
