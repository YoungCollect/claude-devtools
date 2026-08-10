# React JSON Viewer 选型评估

日期：2026-08-10

## 结论

建议本项目使用 [`react-json-view-lite`](https://github.com/AnyRoad/react-json-view-lite)，当前版本固定为 `2.5.0`。

它最符合当前需求：只读展示 HTTP JSON body、节点展开/收起、适配现有明暗主题，并继续使用 Inspector 已有的整段 `Copy JSON` 按钮。它是重点候选中唯一以稳定版本明确声明 `react: ^18.0.0 || ^19.0.0` 的包，同时零运行时依赖，npm 包解压体积约 114 KiB。其 README 还明确说明了键盘导航和可覆盖 CSS class，适合作为项目内部 `JsonViewer` 包装组件的底层实现。

不建议为了这次需求自行实现 JSON tree。节点状态、递归渲染、键盘可访问性以及大 body 性能都已有成熟实现；项目只需封装主题、默认展开深度、空值/解析失败降级和外层复制行为。

## 评估口径

- 项目环境：React 19、Vite 6、TypeScript 5.7。
- 数据来源只采用项目自己的 GitHub/README、npm Registry 和 npm Downloads API。
- 下载量为 npm 官方 API 在 `2026-08-03` 至 `2026-08-09` 的快照，会随时间变化。
- “包体积”采用 npm Registry 的 `dist.unpackedSize`，它是发布包解压体积，不等同于 Vite tree-shaking 后的浏览器 bundle 大小。
- React 19 兼容性以发布包 `peerDependencies` 为准；仅写 `>=16` 表示安装范围允许 React 19，但不等于项目明确验证 React 19。

## 重点候选比较

| 包 | 维护与采用度快照 | React 19 | 展开/收起与复制 | 主题/样式 | 体积与依赖 | 许可证 | 判断 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [`react-json-view-lite@2.5.0`](https://www.npmjs.com/package/react-json-view-lite) | 稳定版发布于 2025-09-06；仓库约 245 stars；周下载 1,622,354；默认分支 2026-02 仍有提交 | **明确支持** `^18 || ^19` | 支持按节点展开/收起、默认展开函数、点击展开和键盘导航；**无内置复制** | 内置 light/dark 样式，所有节点角色可用 CSS class 覆盖 | 约 114 KiB；0 runtime deps | MIT | **推荐**。功能边界与只读 HTTP body 最匹配，现有 `Copy JSON` 可补齐整段复制 |
| [`@uiw/react-json-view@2.0.0-alpha.43`](https://www.npmjs.com/package/%40uiw%2Freact-json-view) | 最新版发布于 2026-05-21，但仍是 alpha；仓库约 415 stars；周下载 714,830；同日有发布提交 | peer 为 `react >=18`、`react-dom >=18`，范围包含 19 | 节点展开/收起、按深度折叠、节点复制均内置 | CSS variables、多个内置主题、子组件级自定义，四者中最强 | 约 356 KiB；0 普通 deps，但要求 `@babel/runtime >=7.10` peer | MIT | 功能最完整的备选；当前 alpha API 风险和更大的表面积不适合本次只读需求 |
| [`json-edit-react@1.30.2`](https://www.npmjs.com/package/json-edit-react) | 稳定版发布于 2026-06-24；仓库约 639 stars；周下载 345,674；默认分支 2026-07 有提交 | peer 为 `react >=16`，安装范围包含 19，但未单独声明/承诺 React 19 | 支持折叠深度/过滤器、复制、搜索、编辑、拖放；有 `viewOnly` 模式 | 完整主题替换、细粒度覆盖和自定义节点 | 约 140 KiB；0 runtime deps | MIT | 质量和活跃度较好，但编辑器能力对 Network Inspector 明显过度；仅在后续需要编辑/搜索 JSON 时考虑 |
| [`react-json-view@1.21.3`](https://www.npmjs.com/package/react-json-view) | 最新发布为 2021-03-09；仓库约 3,658 stars；周下载 1,459,144；README 明确标记“不再维护” | **不支持**；peer 只接受 React 15/16/17 | 折叠、复制、编辑功能齐全 | Base16 主题和 inline style | 约 137 KiB；4 runtime deps | MIT | **排除**。历史流行度高，但已弃用且 peer 与 React 19 冲突 |

官方元数据入口：[`react-json-view-lite` Registry](https://registry.npmjs.org/react-json-view-lite/latest)、[`@uiw/react-json-view` Registry](https://registry.npmjs.org/%40uiw%2Freact-json-view/latest)、[`json-edit-react` Registry](https://registry.npmjs.org/json-edit-react/latest)、[`react-json-view` Registry](https://registry.npmjs.org/react-json-view/latest)。下载量来自对应的 [npm Downloads API](https://api.npmjs.org/downloads/point/last-week/react-json-view-lite)。GitHub stars 与最近提交日期是 2026-08-10 的仓库快照。

## 候选详评

### `react-json-view-lite`

项目 README 将定位明确限定为轻量只读 JSON tree，支持嵌套对象展开/收起和 CSS 覆盖，并明确说明没有复制和编辑等重功能。2.x 增加了基于树结构的可访问性、方向键导航和节点展开控制；`shouldExpandNode` 可按层级或内容决定初始状态。[官方 README](https://github.com/AnyRoad/react-json-view-lite#readme) 与 [发布包元数据](https://registry.npmjs.org/react-json-view-lite/latest) 都直接支持本项目的 React 19 + TypeScript 使用方式。

对本项目而言，“无内置复制”反而能避免重复操作入口：Inspector 已经有 `Copy JSON`，viewer 只负责可读结构。建议包装组件默认仅展开根节点或前两层，并通过项目现有 role/color variables 覆盖其样式 class，不直接使用库的颜色决策。

### `@uiw/react-json-view`

v2 提供内置 clipboard、按层级折叠、`shouldExpandNodeInitially`、CSS variables、多套主题以及几乎每个渲染部件的替换能力。[官方 README](https://github.com/uiwjs/react-json-view#readme) 显示展示功能已有测试，但 v2 编辑功能仍在待办列表。发布元数据的最新版仍是 `2.0.0-alpha.43`，因此若现在采用，就需要接受 alpha API 变化并额外满足 `@babel/runtime` peer。

若产品后续明确需要“复制任意子节点”、非 JSON JavaScript 类型展示或高度定制节点，它是优先于手写实现的升级候选。

### `json-edit-react`

该项目维护活跃、零运行时依赖，支持 `viewOnly`、展开/收起、clipboard、搜索、主题替换和自定义节点。[官方 README](https://github.com/CarlosNZ/json-edit-react#readme) 也说明其核心定位是可编辑 JSON/object UI。当前 Network Inspector 只是查看已捕获的敏感请求/响应，不应提供误导性的编辑能力；即使通过 `viewOnly` 关闭编辑，仍会引入大量暂时不用的 API 与 UI 语义。

### `react-json-view`

虽然采用度仍高且功能完整，但[官方 README](https://github.com/mac-s-g/react-json-view#readme) 已明确宣告停止维护，npm peer 也排除 React 18/19。高 stars 和下载量来自长期积累，不能抵消兼容性与维护风险。

## 建议的集成边界

新增项目自己的 `JsonViewer` 组件，由它负责：

1. 接受 `unknown`，仅在值确实是 object/array/primitive JSON 时交给 viewer；原始 body 解析失败时继续展示现有 raw code surface。
2. 默认展开根节点、折叠较深节点，避免大型 HTTP body 首次渲染产生过多 DOM。
3. 将库的 CSS class 映射到 `src/web/styles.css` 中已有的语义颜色变量，React 组件内不写硬编码颜色。
4. 保留现有 `Copy JSON` 作为整个 body 的复制入口；不要同时增加第二套根节点复制按钮。
5. 先只替换 Inspector 中可成功解析为 JSON 的 request/response body；raw request、raw response 和 SSE 保持原样，保证诊断时仍可查看准确 wire content。

## 最终决策

采用 `react-json-view-lite@2.5.0`，通过项目内薄包装统一样式和降级逻辑。只有出现明确的子节点复制或复杂节点定制需求时，再评估迁移到稳定版 `@uiw/react-json-view`；当前不需要手写 JSON tree。
