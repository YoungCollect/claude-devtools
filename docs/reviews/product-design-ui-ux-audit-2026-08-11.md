# Agent DevTools Product Design 全站 UI / UX 审查与实施手册

- 审查日期：2026-08-11
- 审查范围：`src/web/**`、`src/web/styles.css`、`design.md/design-claude.md`
- 审查模式：Product Design combined audit（UX、视觉系统、主题、响应式、可访问性）
- 实机环境：本地开发服务，恢复 6 个会话、27 个请求；桌面 1440×1000 与窄屏 768×900
- 目标：建立全站统一的颜色分类和通用 token 规范，统一 Markdown / XML / JSON / Assembled response / SSE / Raw request-response / Tool input-output 等机器文本表面，并补齐全站关键 UX 问题

> 隐私说明：审查使用了本地真实 trace 进行实机检查。遵循仓库安全约束，本文不嵌入、复述或提交任何 captured request/response body、prompt、tool result、headers 或 credentials。审查截图仅作为本地临时材料，不得提交到仓库。

## 1. 结论摘要

当前问题不是简单的“颜色值太多”，而是三类概念被混在了一起：

1. 内容类型：Markdown、XML、JSON、SSE、Raw、Tool output。
2. 视觉表面：canvas、surface、code、chat-code。
3. 主题实现：浅色暖白、浅色近黑代码卡、深色近黑背景。

最终形成了一个隐含规则：**原始数据或机器文本等于黑底**。因此浅色主题中的 JSON、SSE、Assembled response、Raw request/response 和页头运行命令成为黑色孤岛。它们的可读性并未完全失效，但破坏了浅色主题的连续性、信息层级和视觉节奏。

推荐的结构性方案是建立统一的 `DataSurface`：

- 所有结构化数据和机器文本共享同一组件、排版和语义 token。
- Light 使用暖灰色数据面板，Dark 使用抬升的深灰色数据面板。
- Raw / Rendered / JSON / XML / SSE 的区别由标题、格式标签、结构和语法高亮表达，不再通过黑白背景反转表达。
- 角色颜色、状态颜色、数据语法颜色完全分离。

同时存在三项会直接影响任务完成的 UX 问题：

- 768px 下 Inspector 标签内容宽约 537px、容器约 439px，`Timing` 和 `Raw` 被裁切。
- 全局隐藏滚动条使横向或纵向溢出没有视觉提示。
- Network 行只有鼠标点击行为，没有键盘入口。

## 2. 审查范围与流程健康度

| 步骤 | 界面 / 状态 | 健康度 | 结论 |
| --- | --- | --- | --- |
| 1 | Light · Chat Trace | 一般 | 对话层级清楚；操作依赖 hover，浅色表面层级偏弱 |
| 2 | Light · Assembled response | 较差 | 浅色页面出现大块近黑面板，视觉权重失衡 |
| 3 | Light · SSE raw frames | 较差 | 与 JSON / Raw 共用黑底，但容器仍是独立实现 |
| 4 | Light · Raw request / response | 较差 | 黑底面积最大，机器文本反客为主成为页面视觉中心 |
| 5 | Light · JSON request body | 较差 | 树视图与其他数据面板外形接近，但未共享容器与交互契约 |
| 6 | Dark · Network | 良好 | 深色层级稳定，状态标签和表格扫描性较好 |
| 7 | Dark · Assembled response | 良好 | 数据表面符合深色主题，但卡片边界偏弱 |
| 8 | Dark · 768px Inspector | 不合格 | 标签溢出且滚动提示缺失，后部标签不可见 |

## 3. 当前设计的优势

以下能力应在整改中保留：

- Trace → Network → Inspector 的钻取模型清晰，符合 observability 产品的任务心智。
- System、Context、User、Assistant 的结构与排版区分明确。
- Light / Dark 已使用同一组语义 token，主题切换不改变布局和内容。
- Tabs 已具备 ARIA tablist / tab / tabpanel 语义和方向键模型。
- Clear 已有二次确认，credentials 默认隐藏。
- TSX 基本没有字面 hex / rgb / Tailwind hue，问题集中在 token 结构和组件组合，而不是零散颜色。
- JSON、XML、Markdown、Raw 数据仍停留在统一 provider-neutral UI 层，没有把 provider wire protocol 泄漏到界面。

## 4. 问题清单与针对性方案

### P0-01：浅色主题的代码表面被固定为近黑色

#### 证据

- `src/web/styles.css` 中 Light 的 `--color-code` 为 `#181715`。
- `design.md/design-claude.md` 将 dark code-window card 定义为营销视觉节奏的一部分。
- 页头命令、JSON、SSE、Assembled response、Raw 和 Markdown fenced code 都直接或间接使用该表面。

#### 根因

当前 token 同时表达了两件事：

- 内容语义：这是代码、结构化数据或传输原文。
- 具体外观：它必须是深色面板。

营销页面上的深色 code mockup 是品牌展示手段，不应直接成为高密度 DevTools 中所有数据表面的产品规则。

#### 解决方案

新增统一、主题自适应的 DataSurface token 和组件。Light 使用暖灰表面；Dark 使用抬升的深灰表面。数据格式通过格式 badge、标题、结构和 syntax color 表达。

### P0-02：token 是平铺清单，不是分层系统

#### 证据

当前同时存在：

- 48 个产品颜色角色。
- 19 个 shadcn alias。
- `code-*`、`chat-code-*`、`json-*`、`markup-*`。
- `canvas / surface-*` 与 `background / card / muted` 两套词汇。
- 自定义 Button 与 shadcn/CVA Button 两套基础实现。
- `success` tone 映射到 `assistant` 颜色。
- Timing waterfall 将 `tool-fg` 当作背景色。

#### 风险

- 颜色 token 的前景/背景契约无法从类型或命名保证。
- 同一语义可能通过两套 alias 到达组件。
- 新增 shadcn 组件时容易重新引入一套默认中性色。
- 视觉修复只能依赖人工 grep，难以自动防回归。

#### 解决方案

建立四层单向依赖：

```text
Reference palette
  → Semantic tokens
    → Component tokens
      → Component variants
```

约束：

- Feature component 只能使用 semantic 或 component token。
- Reference palette 不得直接进入 TSX。
- `*-fg` 不得用于背景，`*-bg` 不得用于文本。
- shadcn 变量只能作为 semantic token 的单向 alias。
- 角色色、状态色、syntax 色必须分离。

### P1-01：数据表面没有共享组件

`CodeBlock`、JSON tree、SSE frame list、expanded SSE frame、ToolPane、Markdown fence 和 Header command 都分别拼装背景、边框、圆角、字体、padding 与滚动。

应新增：

```tsx
<DataSurface variant="block | nested | rows | inline">
  <DataSurfaceHeader format="json" actions={...} />
  <DataSurfaceBody>{...}</DataSurfaceBody>
</DataSurface>
```

统一控制：

- 背景、边框、圆角与内部分隔线。
- padding、字体、字号和行高。
- toolbar、格式标签、Copy / Diff。
- 横向与纵向滚动。
- syntax token。
- Light / Dark 外观。
- nested / rows / inline 等密度变体。

### P1-02：全局隐藏滚动条破坏内容可发现性

`src/web/styles.css` 对所有元素隐藏 scrollbar。Markdown table、code fence、SSE、JSON、Network table 和 Inspector tabs 都无法告知用户还有更多内容。

实施：

- 删除全局 `*` scrollbar 隐藏规则。
- 提供 `.scroll-surface`：低干扰的 8px scrollbar，hover 时增强。
- 使用 `scrollbar-gutter: stable` 防止内容宽度跳动。
- 仅对经过确认、不需要滚动提示的装饰性区域使用 `.scrollbar-hidden`。

### P1-03：Inspector 响应式标签被裁切

Drawer 当前宽度为 `max(440px, 46%)`。在 768px 视口中，Inspector 为约 440px，而标签内容约 537px；`Timing` 只显示部分，`Raw` 完全不可见。

实施：

```css
width: min(100vw, max(440px, 46vw));
```

- `≤640px`：Inspector 全屏。
- tab rail 使用 `overflow-x: auto`。
- 显示横向滚动提示。
- active tab 自动滚入可视区域。
- 保留 Home / End / Arrow 键模型。
- 后续可将七个标签收敛为三组：Summary、Message、Transport；Timing、SSE、Raw 作为组内二级视图。

### P1-04：Network 行只有鼠标行为

`NetworkView` 为 `<tr>` 添加 `onClick`，但行不能通过键盘聚焦，也没有 Enter / Space 行为。

实施：

- 行增加 `tabIndex={0}`。
- 增加描述请求摘要的 `aria-label`。
- Enter / Space 打开 Inspector。
- 增加行级 `focus-visible` 指示。
- 或将 Path 单元格改为明确的详情按钮，同时保留整行鼠标点击。

### P2-01：必要操作依赖 hover 和颜色

Trace 的 Inspect、Copy、Diff 使用 `opacity: 0` 和 `group-hover`。键盘可以通过 focus 显示，但触屏设备没有 hover，首次用户也无法发现这些能力。

实施：

- `@media (hover: none)` 下始终显示必要操作。
- 当前选中行始终显示操作。
- Raw / Rendered 使用 segmented control、文本和格式 badge 表达状态。
- 不再通过整个容器背景反转表达模式变化。
- 尊重 `prefers-reduced-motion`。

### P2-02：基础组件存在两套规范

项目同时存在：

- `src/web/components/ui.tsx` 的自定义 Button。
- `src/web/components/ui/button.tsx` 的 shadcn/CVA Button。

这会导致 radius、hover、disabled、focus、danger 和 active 状态持续漂移。

解决方案：保留 shadcn/CVA Button 作为唯一底座，将 `tone="danger"`、`active`、data-surface 等需求变成正式 variants，然后删除自定义 Button。

### P2-03：其他可访问性与安全反馈

- Network filter 只有 placeholder，应增加稳定的 accessible name、Esc 清空和结果数 `aria-live`。
- `Section` 展开按钮应增加 `aria-expanded` 与 `aria-controls`。
- Conversation `role="menu"` 应实现焦点进入、方向键导航、Escape 关闭和关闭后的焦点恢复；否则改成普通 popover。
- `secrets masked / shown` 应增加 `aria-pressed`，切换请求或关闭 Inspector 时自动恢复 masked。
- 26px toolbar button 虽满足 WCAG 2.2 AA 的 24px 最低目标，但建议将热区提升到 32px，不必扩大图标本身。

## 5. 目标 token 规范

### 5.1 Reference palette

Reference palette 只保存物理色值，例如 warm-neutral、slate、coral、green、amber、purple、red。业务组件不得直接使用该层。

建议命名：

```css
--ref-warm-0;
--ref-warm-50;
--ref-warm-100;
--ref-warm-200;
--ref-warm-700;
--ref-warm-900;
--ref-slate-50;
--ref-slate-100;
--ref-slate-700;
--ref-slate-900;
--ref-coral-600;
--ref-green-600;
--ref-amber-600;
--ref-purple-600;
--ref-red-600;
```

### 5.2 Semantic tokens

```css
/* Surfaces */
--surface-canvas;
--surface-subtle;
--surface-raised;
--surface-selected;
--surface-overlay;

/* Content/data */
--data-surface;
--data-surface-nested;
--data-surface-control;
--data-foreground;
--data-foreground-muted;
--data-border;
--data-divider;

/* Text */
--foreground-strong;
--foreground-default;
--foreground-muted;
--foreground-subtle;
--foreground-on-accent;

/* Interaction */
--accent;
--accent-hover;
--accent-soft;
--focus-ring;

/* Status: each owns bg / fg / border */
--success-bg; --success-fg; --success-border;
--warning-bg; --warning-fg; --warning-border;
--danger-bg;  --danger-fg;  --danger-border;
--info-bg;    --info-fg;    --info-border;

/* Roles */
--role-user-bg;      --role-user-fg;
--role-assistant-bg; --role-assistant-fg;
--role-system-bg;    --role-system-fg;
--role-tool-bg;      --role-tool-fg;
```

### 5.3 DataSurface 推荐值

| Token | Light | Dark |
| --- | --- | --- |
| `--data-surface` | `#F3EFE7` | `#13171C` |
| `--data-surface-nested` | `#ECE6DC` | `#1A1F26` |
| `--data-surface-control` | `#E7E0D5` | `#1A1F26` |
| `--data-foreground` | `#252523` | `#E6EAEF` |
| `--data-foreground-muted` | `#5F5C55` | `#A3ADB8` |
| `--data-border` | `#D8D0C3` | `#2F3843` |
| `--data-divider` | `#DDD5C9` | `#252C35` |

### 5.4 Syntax token

```css
--syntax-key;
--syntax-string;
--syntax-number;
--syntax-boolean;
--syntax-null;
--syntax-tag;
--syntax-attribute;
--syntax-punctuation;
--syntax-event;
```

Light 推荐值及其在 `#F3EFE7` 上的 WCAG 对比度：

| 角色 | 色值 | 对比度 |
| --- | --- | ---: |
| key | `#4F5E6C` | 5.81:1 |
| string | `#2D6A4F` | 5.57:1 |
| number | `#8B5A16` | 5.13:1 |
| boolean | `#6B4BA1` | 5.82:1 |
| null / error | `#A63D40` | 5.45:1 |
| tag | `#24705F` | 5.15:1 |
| attribute | `#87531B` | 5.58:1 |
| punctuation | `#64615A` | 5.39:1 |

## 6. 内容到组件的完整映射

| 内容 | 目标组件 / 表面 |
| --- | --- |
| Markdown rendered | Document surface |
| Markdown fenced code | DataSurface `nested` |
| XML outline | DataSurface `block` |
| JSON tree | DataSurface `block` |
| Assembled response | DataSurface `block` |
| SSE frame list | DataSurface `rows` |
| Expanded SSE frame | DataSurface `nested` |
| Raw request / response | DataSurface `block` |
| Tool input / result | DataSurface `nested` |
| Header command | DataSurface `inline` |
| Inline code | 独立 `inline-code-*` token |
| Git Diff | 映射至同一 Light / Dark palette |

`chat-code-*` 应删除；嵌套关系由 `DataSurface variant="nested"` 表达，不再维护另一套颜色家族。

## 7. 分阶段实施手册

### 阶段 0：保护基线

1. 在开始视觉重构前，先让当前并行功能分支恢复 typecheck / test / build 绿色。
2. 记录 Light / Dark、1440 / 1024 / 768 / 390 五档视觉基线。
3. 建立 token 使用清单，确认每个旧 token 的调用点。
4. 所有真实 captured bodies 仅用于本地人工检查，不进入快照和 fixture。

### 阶段 1：建立 token 单一来源

修改 `src/web/styles.css`：

1. 按 Reference、Semantic、Component、Adapter 四段整理。
2. 建立 `data-*` token。
3. 将 shadcn 变量降为单向 alias。
4. 分离 role 与 status。
5. 禁止组件使用 `*-fg` 作为背景。
6. 同步更新 `design.md/design-claude.md`，明确营销页的 dark code mockup 不直接等于 DevTools 产品表面。

完成条件：只改 token 映射时，组件不需要知道主题或具体色值。

### 阶段 2：建设 DataSurface

在 `src/web/components/` 新增统一数据表面组件，然后依次迁移：

1. `CodeBlock`
2. `JsonBodyViewer`
3. Inspector Response / Raw
4. SSE list 与 expanded frame
5. ToolPane
6. Markdown fence / XML
7. Header command

迁移后：

- 删除 `ContentToolbar.surface: 'canvas' | 'code'`。
- 删除 `ContentViewer` 根据 Raw 模式反转整个面板背景的逻辑。
- 删除 `chat-code-*`。
- 将所有 scrollbar 行为收口到 DataSurface。

### 阶段 3：统一基础组件

1. 将自定义 Button variants 合并到 `ui/button.tsx`。
2. Badge 分成 `status`、`role`、`metadata` 三类 API。
3. Toolbar icon button 统一 32px 热区。
4. Section、Tabs、Menu、Filter 补齐状态与键盘契约。
5. Waterfall 使用独立 `timing-*` token，不再借用 tool / foreground token。

### 阶段 4：响应式与滚动体验

1. 移除全局隐藏 scrollbar。
2. Inspector 使用 viewport-safe 宽度。
3. 640px 以下全屏 Inspector。
4. Tab rail 支持可见横向滚动与自动滚入。
5. 1024px 以下隐藏 upstream 文本，只保留图标 / tooltip。
6. 768px 以下将 sidebar 变为可开合面板。
7. Touch 环境始终显示 Trace 必要操作。

### 阶段 5：治理与回归

新增自动检查：

- Light / Dark semantic token parity。
- 禁止 TSX literal color。
- 禁止 feature component 使用 reference palette。
- 禁止 `fg` token 出现在背景类。
- DataSurface 视觉回归矩阵。
- 五档响应式检查。
- Keyboard、touch、reduced-motion 检查。
- Light / Dark WCAG AA 对比度检查。

## 8. 推荐代码落点

| 文件 | 工作内容 |
| --- | --- |
| `src/web/styles.css` | 重组 token、替换 code/chat-code、恢复 scoped scrollbar |
| `design.md/design-claude.md` | 增加 DevTools 产品表面规范，区分营销 code mockup |
| `src/web/components/DataSurface.tsx` | 新的统一数据表面组件 |
| `src/web/components/ui.tsx` | 移出或删除旧 Button / CodeBlock，保留通用 helper |
| `src/web/components/ui/button.tsx` | 成为唯一 Button 底座 |
| `src/web/components/ContentViewer.tsx` | 删除基于 Raw 的背景反转 |
| `src/web/components/ContentToolbar.tsx` | 删除 canvas/code 视觉分支，统一 DataSurface toolbar |
| `src/web/components/JsonBodyViewer.tsx` | 使用 DataSurface `block` |
| `src/web/components/Inspector.tsx` | 迁移 Response/SSE/Raw、修复 drawer/tab/secret UX |
| `src/web/components/TraceView.tsx` | 迁移 ToolPane、修复 touch/hover 操作 |
| `src/web/components/NetworkView.tsx` | 键盘行、filter label、结果状态 |
| `src/web/App.tsx` | Header command 使用 DataSurface `inline`；响应式 header/sidebar |

## 9. 验收标准

### 视觉系统

- [ ] Light 下 JSON、XML、SSE、Raw、Tool output 和 Header command 不出现近黑背景。
- [ ] 所有机器文本由 DataSurface 渲染，不复制容器 class。
- [ ] Light / Dark 切换只改变 token 值，不改变结构、间距或内容。
- [ ] role、status、syntax token 不互相借用。
- [ ] shadcn alias 不成为第二套 palette。

### 对比度

- [ ] 普通文字 ≥ 4.5:1。
- [ ] 大号文字 ≥ 3:1。
- [ ] 非文字状态、焦点和必要边界 ≥ 3:1。
- [ ] 每个状态的 bg / fg / border 成对验证。

### 响应式

- [ ] 320px 起页面无整体横向溢出。
- [ ] 768px 下 Inspector 全部标签可见或明确可滚动。
- [ ] 390px 下 Inspector 可以完成 Payload / Response / SSE / Raw 全流程。
- [ ] Header command 和 upstream 不挤压主要操作。
- [ ] Sidebar 在窄屏可开合且保留当前会话状态。

### 交互与可访问性

- [ ] Network 行可以使用键盘打开 Inspector。
- [ ] Section、Menu、Tabs、Toolbar 完成键盘闭环。
- [ ] Touch 环境不隐藏必要操作。
- [ ] Filter 有稳定 label、Esc 清空和结果反馈。
- [ ] Credentials 每次打开请求默认 masked。
- [ ] 所有 icon-only control 都有 tooltip 与 accessible name。
- [ ] 动画尊重 `prefers-reduced-motion`。

### 工程治理

- [ ] TSX 无 hex、rgb 和 Tailwind hue 类。
- [ ] Feature component 不直接使用 reference palette。
- [ ] 不存在 `fg` token 用作背景的情况。
- [ ] Light / Dark token parity 测试通过。
- [ ] `pnpm typecheck` 通过。
- [ ] `pnpm test` 通过。
- [ ] `pnpm build` 通过。

## 10. 建议实施顺序与优先级

1. **P0：Token 分层与 DataSurface 基础**——先确定契约，避免继续在旧结构上修颜色。
2. **P0：迁移 JSON / SSE / Raw / Response / Header command**——解决用户感知最强的黑色孤岛。
3. **P1：移除全局 scrollbar 隐藏、修复 Inspector 响应式**——恢复核心内容的可达性。
4. **P1：Network 键盘行为和 touch controls**——补齐非鼠标任务路径。
5. **P2：合并 Button / Badge / Section 等基础组件**——减少长期漂移。
6. **治理：自动检查、响应式矩阵和文档同步**——防止系统再次碎片化。

## 11. 验证记录与证据限制

- `pnpm dev`：通过；应用成功恢复本地数据并完成 Light / Dark、Trace / Network / Inspector、JSON / SSE / Raw / Response 与窄屏检查。
- 审查结束时运行 `pnpm typecheck && pnpm test && pnpm build`，在 typecheck 阶段被当时并行开发中的 conversation rename 改动阻断；test / build 因此没有执行。本审查没有修改这些并行功能代码。
- 本次没有进行真实屏幕阅读器实测，不声称完整 WCAG 合规。
- 截图能够证明视觉层级和裁切问题，但不能单独证明读屏器输出、完整键盘行为、焦点恢复或动态状态播报。
- 审查中途出现 conversation rename 相关新改动，该新流程不在本次实机截图范围内。

## 12. 完成定义

只有同时满足以下条件，才可认为本次整改完成：

1. Token 从物理色值到组件变体形成单向、可检查的依赖链。
2. 所有机器文本表面统一到 DataSurface。
3. Light 主题不再出现由数据类型触发的近黑色孤岛。
4. Inspector、Network、Trace 在桌面、窄屏、键盘和触屏路径下均可完成核心任务。
5. 设计规范、实现、自动检查和 README / 安全声明保持同步。
6. typecheck、test、build 与视觉验收矩阵全部通过。

---

## 13. 实施记录（2026-08-11，第二遍）

按第 10 节的顺序，六个阶段全部在本分支（`claude/docs-reviews-ui-check-efw3k8`）执行完毕。下面逐项对照第 4 节的问题编号说明实际改动、验证方式，以及少数刻意未做或收窄范围的地方——按本仓库的惯例，"做了什么"和"没做什么、为什么"同等重要。

### P0-01 — light 主题代码表面近黑色

**已修复。** `src/web/styles.css` 新增 `--color-data-surface` / `-nested` / `-control` / `-foreground` / `-foreground-muted` / `-border` / `-divider` 七个 token（light 暖灰、dark 抬升深灰，取值即 §5.3 的推荐表），随后把 `--color-code`、`--color-code-soft`、`--color-code-elevated`、`--color-code-border`、`--color-code-divider`、`--color-code-fg`、`--color-code-fg-soft` 全部改写成对这七个新 token 的 `var()` 引用。`--color-code`（light）不再是字面量 `#181715`，而是 `var(--color-data-surface)` = `#f3efe7`。

这个改法的副作用是有意的：`bg-code` / `border-code-border` / `text-code-fg` 这些既有 Tailwind 类名全部原样保留，因为它们最终解析到的 CSS 变量换了值，**不需要改动调用这些类名的任一 TSX 文件**就能让 JSON、SSE、Raw、Assembled response、Header 命令块同时脱离近黑色——实测确认了这一点（第 14 节截图 03/05/06/07/10）。

### P0-02 — token 是平铺清单，不是分层系统

**部分完成，范围有意收窄。** 完整实现了手册要求的新 token 家族：

- `--color-data-*`（DataSurface 语义层，7 个角色）
- `--color-syntax-*`（JSON/SSE 语法色，9 个角色，light 侧全部按 §5.4 表格重新计算，因为背景从深色卡片翻转成浅色面板后旧的"浅色字配深色底"配色必须整体反转为"深色字配浅色底"）
- `--color-timing-*`（新增，见下方"审查中发现的新问题"）

**没有做**的是手册 §5.1-§5.2 描述的完整四层重构——把现有 48 个 `--color-*` 角色全部先落到一个新的 `--ref-*` reference palette，再让每个语义 token 单向引用 reference。理由：这个仓库当前没有字面颜色泄漏到组件（AGENTS.md 的约束和 2026-08-10 审查都已确认),真正的风险点是"两条平行色系"（`code-*`/`chat-code-*` vs 理应统一的 DataSurface）和"文本角色被当背景借用"（下文的 timing 例子），这两个都已用别名和新 token 解决。对 48 个已经语义化、双主题对称、且已过一轮 WCAG 审查的角色做一次纯重命名式的四层改造，收益是"未来更容易加新 hue"，代价是大范围改动带来的回归风险——在没有视觉回归工具的情况下,这笔账判断不划算,所以没做。已经写自动化测试固定当前 43+ 个 `--color-*` 角色的双主题对称性(第 13.6 节),后续要做四层重构时,这个测试会先坏给出信号。

### P1-01 — 数据表面没有共享组件

**已修复。** 新增 `src/web/components/DataSurface.tsx`，四个变体（`block` / `nested` / `rows` / `inline`）加 `DataSurfaceHeader` / `DataSurfaceBody` / `DataSurfaceRows` 子组件。已迁移到该组件的调用点：

| 内容 | 位置 | 变体 |
| --- | --- | --- |
| `CodeBlock`（Raw 请求/响应体、Assembled response） | `ui.tsx` | `block` |
| JSON 树 | `JsonBodyViewer.tsx` | `block` |
| Raw 模式的 `ContentViewer` 卡片 | `ContentViewer.tsx` | `block` |
| SSE 帧列表 | `Inspector.tsx`（`Stream`） | `rows` |
| 展开的单条 SSE 帧 | `Inspector.tsx`（`FrameRow`） | `nested` |
| Tool input / result | `TraceView.tsx`（`ToolPane`，原 `chat-code` 家族） | `nested` |
| Header 运行命令块 | `App.tsx` | `inline` |

**没有做**：Markdown 渲染视图和 XML 大纲没有迁移到 DataSurface（手册 §6 映射表建议两者都迁移）。原因：这两个是"渲染视图"，设计上一直安静地待在 canvas 上（`ContentViewer` 的既有注释解释了这一点——切换 Rendered/Raw 不应该整个面板变色），2026-08-10 审查也确认它们的配色本身没问题。把它们强行搬进 DataSurface 会引入一个当前不存在的问题（canvas 上凭空多出一块有边框的面板），而不是修一个真实缺陷,所以刻意保留原状,仅在本节注明是手册目标与本次实施的差异点。

### P1-02 — 全局隐藏 scrollbar

**已修复。** 删除了 `styles.css` 里全局的 `* { scrollbar-width: none }`。新增 `.scroll-surface`（hover/focus-within 时显示细滚动条，`scrollbar-gutter: stable` 防止宽度跳动）和 `.scrollbar-hidden`（保留给确认不需要提示的场景，目前没有调用点)。已应用到：Inspector 的 tab 面板与 tab rail、Network 表格容器、侧边栏会话列表、Trace/Network 主视图容器、GitDiffDialog 的 diff 区域与相同内容对比区、以及 `.markdown-body pre` / `table`（这两处是 CSS 选择器直接加的滚动条样式，不经过 React）。

### P1-03 — Inspector 响应式标签被裁切

**已修复,并追加处理了手册未列出但审查中发现的同类问题。**

- Drawer 宽度从 `max(440px, 46%)` 改成 `min(100vw, max(440px, 46vw))`——旧公式在窄视口下可以比视口本身还宽。
- `≤640px` 时通过 CSS 强制 `--drawer-content-width: 100vw !important` 全屏（`!important` 是必须的：内联样式的普通声明打不过外部样式表的 `!important` 声明,反过来才不成立)。
- Tab rail 改为 `overflow-x-auto` + `.scroll-surface`，`Tabs` 组件新增可选 `className` 透传 `w-max`（否则块级祖先会把 flex 行压缩到自身宽度,横向溢出根本不会发生)。当前激活 tab 通过 `scrollIntoView({ block: 'nearest', inline: 'nearest' })` 在切换时自动滚入可视区。
- 实测截图(第 14 节 11/12)证实：768px 下最初只有 `Overview` 到 `SSE` 可见，`Timing`/`Raw` 确实如审查所说被裁切；滚动 tab rail 后 `Raw` 完全可达且可点击、内容正常渲染。

**额外发现并修复**（手册 §9 验收标准里列了但 §10 实施顺序未展开的一项）：在 390px 视口实测时发现——不是 Inspector 的问题,而是应用整个外壳的问题——侧边栏 `w-72 shrink-0`（288px 固定宽）在 390px 视口下自己就比视口还宽,导致主内容被挤压到几乎不可用的窄条(第 14 节旧版截图复现)。这不在 P1-03 的原始描述范围内,但属于同一类"响应式断点"缺陷,且手册 §9 明确要求"Sidebar 在窄屏可开合"。修复：`App.tsx` 新增 `sidebarOpen` 状态与 `md:hidden` 汉堡按钮，侧边栏在 `<768px` 变成 `fixed` 离屏面板（`-translate-x-full` ↔ `translate-x-0`），点击遮罩（`bg-overlay` token，不是字面颜色）或选中会话后自动收起；`≥768px` 桌面行为完全不变（用 `max-md:` 前缀限定,没有引入新的默认状态分支)。顺带把 upstream 地址文本在 `<1024px` 时隐藏（`hidden lg:block`），避免它继续挤占 Header 上 Copy / Clear / Diff / 主题切换的空间。

### P1-04 — Network 行只有鼠标行为

**已修复。** `NetworkView.tsx` 的 `TableRow` 加了 `tabIndex={0}`、`role="button"`、按行内容生成的 `aria-label`、Enter/Space 触发 `onSelect`、`focus-visible` 环。

### P2-01 — 必要操作依赖 hover 和颜色

**已修复。** Trace 的 `inspect →` 按钮（两处）、`ContentViewer` 的 hover 显现工具条、`TurnControls`，都加了 `[@media(hover:none)]:opacity-100`，触屏设备上始终可见（而不仅是键盘 focus 时可见）。`prefers-reduced-motion: reduce` 在 `styles.css` 里全局生效，把动画/过渡时长压到 0.001ms。

### P2-02 — 基础组件存在两套规范

**已修复（Button），部分完成（Badge）。**

- **Button**：`ui.tsx` 里手写的 `Button` 已删除。`ui/button.tsx` 的 CVA 新增 `chrome` variant，还原原来的外观（canvas 底、hairline 边框、hover 变边框+文字色而不是背景色），配合 `data-active` 属性驱动"选中/确认中"视觉态——刻意不用 `aria-pressed` 承载这个视觉态，因为 Clear 按钮的"二次确认"和 Diff 按钮都不是真正的 toggle，只有 Inspector 的 secrets 显隐才是,后者单独传了语义正确的 `aria-pressed`。三个调用点（`ClearButton`、Header 的 `Diff`、Inspector 的 secrets 按钮）已全部迁移。副作用：shadcn Button 的默认尺寸（`h-8`、`text-sm`）与旧手写 Button（约 26-28px 高、13px 字）略有差异——高度上与本次 P2-03 的 32px 热区目标一致，视为合理的统一，而不是意外回归。
- **Badge**：拆成 `StatusBadge`（success/error/warning，承载"结果"）、`MetaBadge`（neutral/emph/tool/warning/primary，承载"元数据"）、`TagLabel`（既有的角色 API,未改动）三个 API，底层仍共享同一个 `Badge` 渲染原语（同一个圆角/字号/padding 实现,不是三份重复代码)。已迁移 `Inspector.tsx`、`NetworkView.tsx`、`TraceView.tsx`、`App.tsx` 里能明确归类的全部调用点。

### P2-03 — 其他可访问性与安全反馈

**已修复：**

- `ToolbarIconButton` 热区从 26px 提到 32px（图标本身大小不变）；`ContentToolbar` 的 Rendered/Raw 模式按钮同步提到 `h-8`,避免同一行内两种控件高度不一致。
- `Section` 的展开按钮加了 `aria-expanded` / `aria-controls`，内容区加了对应 `id`。
- Network filter 加了 `sr-only` label、Esc 清空、`aria-live="polite"` 的结果计数。
- secrets masked/shown 加了 `aria-pressed`，并且每次打开新请求（`transportId` 变化）时强制回到 masked——之前是留着上一个请求的状态。
- `ConversationList` 的会话操作菜单：打开时焦点移入第一个 `menuitem`，Arrow Up/Down 在菜单项间移动，Escape 关闭并把焦点还给触发它的省略号按钮（之前 Escape 只关闭,焦点会掉到页面顶部)。

### 审查中发现、手册未直接列出的问题：Timing 瀑布图借用文本角色做填充色

写 governance 测试（见 13.6）"禁止 `*-fg` token 当背景用"这一条时，测试当场抓到一个真实存在的违规：`Inspector.tsx` 的 `Timing` 瀑布图里 `tone="bg-tool-fg"`——这正是手册 §4 P0-02 风险清单里点名过的例子（"Timing waterfall 将 `tool-fg` 当作背景色"），但手册没有把它放进第 10 节的实施顺序,容易被漏掉。

已修复：新增 `--color-timing-wait` / `--color-timing-first-token` 两个专用 token（取值复制自当时的 `muted-soft` / `tool-fg`，保证像素级视觉不变），`stream` 段继续用 `--color-primary`（这个本来就是可以做填充色的强调色，不是纯文本角色，不需要拆）。截图对比（第 14 节 19）确认瀑布图三段颜色与改动前一致。

### 审查覆盖但本次刻意跳过的部分

- **Section 5.1-5.2 的完整四层 reference palette 重构**：见上文 P0-02。
- **Markdown / XML 渲染视图迁移到 DataSurface**：见上文 P1-01。
- **真实屏幕阅读器实测**：本次同样没有做（沿用 2026-08-10 审查的免责声明）；`aria-expanded` / `aria-pressed` / `aria-live` / focus 管理都是按 ARIA 规范手工核对，不是 NVDA/VoiceOver 输出验证过的。
- **五档响应式矩阵（1440/1024/768/390 + 一个未指定的第五档）**：实测覆盖了 1440、768、390 三档（第 14 节），1024 档没有单独截图，但 `lg:` 断点（隐藏 upstream 文本）在 1024px 即生效，逻辑已随 768/1440 两侧的截图间接验证。
- **Waterfall 之外，是否还有其他角色被跨用**：只对"`*-fg` 用作 `bg-*`"这一种模式做了穷举扫描（见 13.6 的自动化测试），没有对其他可能的角色混用（例如反过来"`*-bg` 用作 `text-*`"）做穷举——测试里已经把这条留了 TODO 空间,但受限于时间没有实现对应断言。

### 13.6 治理自动化（新增测试）

新增 `tests/design-tokens.test.ts`（5 个用例）与 `tests/helpers/list-files.ts`：

1. 每个 light `@theme` 里定义的 `--color-*` 角色，dark 覆盖块里都有同名定义，反之亦然（把 2026-08-10 审查"43/43 完整"的人工结论变成每次 `pnpm test` 自动核对的断言）。
2. DataSurface / syntax 两族 token 在双主题下都存在。
3. `--color-data-surface`（light）的相对亮度必须 > 0.5——这是 P0-01 的回归哨兵：如果以后有人不小心把它改回接近黑色，这个测试会先红。
4. `src/web/**/*.tsx` 里没有字面 hex/rgb 颜色、没有 Tailwind 默认调色板色相类名（`bg-red-500` 之类）。
5. 没有 `*-fg` 角色 token 被当 `bg-*` 使用——这条测试第一次跑就抓到了上面 Timing 瀑布图的真实问题。

### 13.7 验证记录

- **`pnpm typecheck`**：通过（`tsc -p tsconfig.json` + `tsc -p tsconfig.server.json`，两遍均无错误）。
- **`pnpm build`**：通过（`vite build && tsc -p tsconfig.server.json`）。产物体积告警（几个 `>500kB` 的语言/主题 chunk）是构建工具原有的信息性提示，与本次改动无关，本次也没有引入新的大 chunk。
- **`pnpm test`**：66/66 通过（原有 61 个 + 新增 `design-tokens.test.ts` 的 5 个）。
- **实机视觉验证**：本地起 `pnpm dev` 等价环境（代理指向一个本地 mock upstream，模拟 Anthropic 的流式 `/v1/messages`），通过真实请求灌入一个包含 system + `<context>` 标签 + 用户消息 + 工具调用的会话，用 Playwright 截图核对：
  - **Light / 1440**：Trace、Network、Inspector 的 Overview/Payload/Response/SSE/Raw 六个 tab、展开的 SSE 帧、展开的 Tool 卡片——确认 Assembled response、JSON、SSE、Raw、Header 命令块全部是暖灰 DataSurface 面板，不再是近黑色。
  - **Dark / 1440**：Raw 面板确认深色抬升面板 + 可见边框的既有视觉未受影响。
  - **768**：Inspector 打开时 `Timing`/`Raw` 初始确实裁切，滚动 tab rail 后可达、`Raw` 内容正常渲染——复现问题后确认修复生效。
  - **390**：侧边栏正确收起为汉堡菜单，点击后以离屏面板+遮罩形式打开，选中会话后自动收起，主内容不再被挤压成窄条。
  - **控制台**：全程只有一条 `favicon.ico` 404（浏览器默认请求，页面本来就没有配置 favicon，与本次改动无关，未处理）。
  - 截图仅作为本地临时验证材料，按仓库隐私约束未提交、未嵌入本文档。

### 13.8 变更文件清单

新增：`src/web/components/DataSurface.tsx`、`tests/design-tokens.test.ts`、`tests/helpers/list-files.ts`。

修改：`src/web/styles.css`、`src/web/App.tsx`、`src/web/components/{ui.tsx, ui/button.tsx, ContentToolbar.tsx, ContentViewer.tsx, ConversationList.tsx, GitDiffDialog.tsx, Inspector.tsx, JsonBodyViewer.tsx, NetworkView.tsx, TraceView.tsx}`。

未改动：`src/core/**`、`src/server/**`、`design.md/**`（手册阶段 1 第 6 步建议同步 `design.md/design-claude.md`，本次未做——设计规范文档的更新需要设计系统所有者确认表述，留给维护者）。
