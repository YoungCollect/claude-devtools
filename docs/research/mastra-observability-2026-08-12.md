# Mastra Observability 对 Claude DevTools 的适配评估

日期：2026-08-12

## 结论

**现在不建议把 Mastra Observability 直接集成进 Claude DevTools。**

它本身是一套成熟的 agent 可观测能力：能自动记录 Mastra agent、workflow、tool 和 model 调用的层级 span，关联日志，从 span 派生耗时、token 与成本指标，并写入本地/自管存储、Mastra Platform 或外部 OpenTelemetry 后端。[Mastra 官方概览](https://mastra.ai/docs/observability/overview)

但它的自动埋点边界是 **Mastra runtime 内部执行**。Claude DevTools 的核心则是一个不要求 Claude Code 配合的 Anthropic Messages HTTP/SSE 代理：它捕获原始 transport，解析 Anthropic wire protocol，再用相邻请求中的历史消息和 `tool_use_id` 重建会话。两者观测的对象、数据模型和接入位置都不同。Mastra 不能替代本项目的 headers/body/SSE 捕获、Anthropic adapter 或跨请求 trace reconstruction；直接引入主要会得到第二套 trace、存储和 UI 生命周期，而不是补上当前缺失的能力。

简要建议：

- 当前版本：**不集成 Mastra packages、Studio 或 Platform exporter**。
- 如果以后要提供标准化外部导出：优先直接为本项目的统一模型设计一个**可选、默认关闭的 OpenTelemetry exporter**，而不是先把数据转换成 Mastra 内部 span。
- 只有产品范围未来明确包含“运行并观测 Mastra agents/workflows”时，才值得把 Mastra Observability 作为独立 integration 接入；仍应保持在 adapter/exporter 边界外，不让 Mastra 类型进入 `src/core/types.ts`。

## Mastra Observability 是什么

Mastra 把 tracing 作为基础信号。配置 `Observability` 后，agent run、workflow execution、tool call 和 model interaction 会产生父子 span；span 可包含 input、output、耗时和 token usage。日志会带当前 trace/span ID，metrics 在 span 结束后自动提取，还可以把 rating、comment、correction 等人工反馈关联到 trace/span。[Observability overview](https://mastra.ai/docs/observability/overview)、[Tracing](https://mastra.ai/docs/observability/tracing/overview)

主要能力包括：

- 层级 tracing：查看 agent 决策路径、model call、tool call、workflow step 与错误。
- 自动 metrics：agent/workflow/tool/model 的 duration，模型 token usage，以及成本估算；指标由结束的 span 派生，不要求额外指标埋点。[Automatic metrics reference](https://mastra.ai/reference/observability/metrics/automatic-metrics)
- 结构化日志：配置 observability 后，Mastra logger 和内部组件的日志会同时发往 observability storage，并自动关联 trace/span。[Logging](https://mastra.ai/docs/observability/logging)
- sampling 与过滤：支持 always、never、ratio、custom sampling，也能按 span type 或自定义 predicate 过滤。
- 自定义：可添加 metadata/tags、child spans、同步 span processor，以及 exporter 专属的同步/异步 formatter。[Tracing](https://mastra.ai/docs/observability/tracing/overview)
- 多目的地导出：可同时保留 Studio 本地数据、发送到 Mastra Platform，或导出到 Datadog、Langfuse、OpenTelemetry 等外部系统。[Integrations overview](https://mastra.ai/docs/observability/integrations/overview)

这些能力很适合回答“某个 Mastra agent 为什么走了这条执行路径、哪个 tool/model 慢、一次运行用了多少 token/成本”。它们不以还原精确 HTTP transport 为目标。

## 接入方式与运行要求

当前 API 要在 `Mastra` 实例上配置 `new Observability({ configs: ... })`，核心包是 `@mastra/observability`，每个 config 指定 service name、exporters、processors、logging 和 sampling 等选项。[Observability overview](https://mastra.ai/docs/observability/overview)

典型路径有三种：

1. `MastraStorageExporter` 把 observability events 写入 Mastra storage，供 Studio 查询；它不要求外部服务。
2. `MastraPlatformExporter` 把数据发送到 Mastra 的托管平台。
3. provider exporter（例如 `@mastra/otel-exporter`）把 Mastra traces/logs 发给外部平台。

OpenTelemetry exporter 按 OTel GenAI semantic conventions 输出，支持 OTLP HTTP/protobuf、gRPC、HTTP/JSON 以及自定义 endpoint；traces 与 logs 分别通过 batch processors 发出。[OpenTelemetry integration](https://mastra.ai/integrations/observability/opentelemetry)

Mastra 另有一个双向 `OtelBridge`，用于让 Mastra span 加入应用现有的 OTel ambient context，并让 Mastra 内部的 OTel-instrumented 操作维持父子关系。但官方将 Bridge 标为 **experimental**，而且仍然要求应用中存在 Mastra operations；它不是把任意第三方 trace model 自动变成 Mastra trace 的通用导入层。[OpenTelemetry integration — Bridge](https://mastra.ai/integrations/observability/opentelemetry#bridge)

部署层面还要考虑：

- exporter 可能批量缓冲数据；serverless runtime 暂停或退出前需要显式 `await mastra.observability.flush()`。[Observability overview](https://mastra.ai/docs/observability/overview#flushing-in-serverless-environments)
- 自定义 async formatter 会加入 span export 路径；官方建议其操作保持在 100ms 内，以免拖慢应用。[Tracing](https://mastra.ai/docs/observability/tracing/overview#async-formatters)
- 旧 `telemetry` OTEL 配置已经 deprecated；新集成不应照旧教程使用它，而应采用 Observability + exporter/bridge。[OTEL Tracing (Deprecated)](https://mastra.ai/docs/observability/otel-tracing)

## 存储、扩缩容与成本含义

`MastraStorageExporter` 支持 realtime、batch-with-updates、insert-only 三种生命周期/写入策略，并根据存储自动选择。官方把 libSQL 定位为开发用途；低量生产可用 PostgreSQL、MSSQL、MongoDB 或 OracleDB，高流量生产推荐 ClickHouse。官方同时提醒，一次 agent interaction 可能产生数百个 span，observability 数据会迅速压垮通用数据库。[Mastra Storage exporter](https://mastra.ai/docs/observability/integrations/exporters/mastra-storage)

metrics 对存储能力还有额外要求：本地开发推荐 DuckDB，高量生产推荐 ClickHouse；`PostgresStoreVNext` 在启用 observability domain 时也支持 metrics。官方建议用 composite storage 将 observability domain 与主业务存储分开扩缩容。[Observability overview — Storage](https://mastra.ai/docs/observability/overview#storage)

使用 Mastra Platform 时，需要 `MASTRA_PLATFORM_ACCESS_TOKEN`、`MASTRA_PROJECT_ID` 和 `MastraPlatformExporter`，数据会发送到 Mastra 托管产品，用于跨 project/deploy 搜索 traces、logs 和 metrics。[Observability on Mastra platform](https://mastra.ai/docs/mastra-platform/observability)

对 Claude DevTools 而言，这意味着直接集成至少会新增：Mastra core/observability 依赖、一套 observability schema/storage、批处理与 flush 生命周期，以及可能的 Studio/server surface。项目已有自己的 SQLite schema、retention、restart restore、Clear 与 in-flight consistency 约束，第二套 persistence 会让一次 Clear 或并发 stream 必须同步清理两套状态，风险高于收益。

## 隐私与敏感数据

这是本项目不应默认接入托管 exporter 的决定性原因。

Mastra span 会记录 input/output，而 Claude DevTools 捕获的数据包含 credentials、prompts、tool results 和 source code。任何 `MastraPlatformExporter` 或外部 OTel/provider exporter 都会让这些数据离开 loopback 本机，直接改变 README 与 `AGENTS.md` 所定义的 local-only 产品合同。因此托管或远端 exporter 不能作为隐式默认值；若未来引入，必须是明确 opt-in，并先设计完整的数据最小化、告知与脱敏策略。

Mastra 提供两个安全控制：

- `tracingOptions.hideInput` / `hideOutput` 在 export 时对整条 trace 的所有子 span 移除 input/output；数据执行期间仍在内部存在。[Tracing — Hiding sensitive input/output](https://mastra.ai/docs/observability/tracing/overview#hiding-sensitive-inputoutput)
- `SensitiveDataFilter` 在 export 前同步扫描 attributes、metadata、input、output 和 error information，递归处理对象/数组，并按敏感字段名替换值。默认词包括 password、token、secret、key、apikey、authorization、jwt、credential、privatekey、ssn 等，也可自定义。[Sensitive data filter](https://mastra.ai/docs/observability/integrations/processors/sensitive-data-filter)

`SensitiveDataFilter` 不是本项目所需的充分保护。官方说明它在归一化后做**精确字段名匹配**，例如 `token` 不匹配 `promptTokens`。由此可合理推断：嵌在自由文本 prompt、source file 或 tool output 里的秘密，不一定有可匹配的字段名，不能假设会被自动发现。对 Claude DevTools 这种刻意保留原始 wire data 的工具，可靠策略应是默认不外发；字段过滤只能作为纵深防御。

## 与当前仓库的架构对比

| 维度 | Claude DevTools 当前设计 | Mastra Observability | 适配结果 |
| --- | --- | --- | --- |
| 观测入口 | loopback HTTP proxy，无需 Claude Code instrumentation | `Mastra` runtime 内的 agent/workflow/tool/model operations | 没有直接自动埋点交集 |
| 协议语义 | Anthropic Messages request/response/SSE，经 adapter 解析 | Mastra internal spans，再由 exporter 转换 | Mastra 不能代替 Anthropic adapter |
| trace 形成 | 跨请求 prefix diff、session/system identity、`tool_use_id` join | runtime 当场建立 parent/child span | 两套 trace identity/lifecycle |
| transport 诊断 | 保留 headers、raw body、每个 SSE frame、TTFB/TTFT | 关注 operation input/output、duration、usage | Mastra 信息粒度不足以替代 Inspector/Network |
| 存储 | owner-only SQLite，支持 body offload、retention、restart、Clear | Mastra storage domain 或托管/第三方 exporter | 引入第二套 schema 与一致性负担 |
| 隐私默认值 | IPv4 loopback、headers 入库前脱敏、local-only | 可本地，也可向 Platform/OTel/provider 外发 | 只有纯本地路径不冲突 |
| UI | 针对 Claude Code 的 Chat Trace + Network + Inspector | Studio/平台的通用 Mastra span、logs、metrics | 功能重叠且 drill-down 目标不同 |

本项目的 `TransportRecord` 与 `TraceNode` 特意是两层模型，并通过 `revealedByRequestId` / `producedByRequestId` 将重建语义连回实际 transport。一个 HTTP request 可以流式产生多个 trace nodes，而 tool result 要到下一次 request 才能观察到。把这些强行压成 Mastra runtime span，要么丢掉 transport 证据链，要么仍需保留现有模型并额外复制一份 span，因此不会简化架构。

## 什么时候值得重新评估

满足以下任一明确需求时，可以做隔离 PoC：

1. **产品开始运行 Mastra agents/workflows。** 此时 Mastra 自动 spans、logs、metrics 和 feedback 对那部分 runtime 有直接价值，但它应作为新的 integration，而非替换 Anthropic proxy path。
2. **用户明确要求导出到现有 observability stack。** 先定义本项目统一模型到 OTel GenAI conventions 的直接映射，做 opt-in exporter；这能避免引入整个 Mastra runtime/storage/UI。Mastra 的 OTel exporter 页面可作为语义与供应商兼容性参考，但不必作为实现依赖。
3. **需要聚合趋势而非单次本地调试。** 当 token/cost/latency 的历史聚合成为已验证产品需求时，再评估本地分析存储或 OTel；不要仅为获得 dashboard 引入与当前 trace model 重叠的平台。

若进行 PoC，验收条件至少应包括：默认无网络外发；不向 core 暴露 Mastra 类型；不延迟客户端 SSE；Clear/retention/restart/abort/concurrent streams 保持单一一致的状态转移；自由文本敏感内容有明确处理；导出失败不能影响 proxy 主路径。

## 最终决策

Mastra Observability 是“构建在 Mastra 上的 AI 应用”的优秀内建可观测层，但不是 Claude DevTools 当前问题的合适底座。当前项目已经拥有更贴合目标的捕获与重建架构，直接集成会增加依赖、存储、隐私和生命周期复杂度，却不能替代最关键的 Anthropic HTTP/SSE 证据链。

因此：**现在不集成；保留为未来 Mastra runtime integration 或可选 OTel 导出需求的参考方案。**
