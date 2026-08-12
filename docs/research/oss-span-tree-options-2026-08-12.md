# Open-source span-tree options for Claude DevTools

Date: 2026-08-12

## Conclusion

There are good self-hosted trace viewers, but no mature, stable, supported **drop-in React trace-tree package** that cleanly accepts an in-memory array of custom spans and fits this repository's existing SPA. The mature UIs are application-internal components coupled to their own state, schemas, query APIs, storage, and design systems.

Recommended paths:

1. **Best external proof of concept: Arize Phoenix**, because its trace UI is already shaped around agent/LLM/tool spans and it can run locally as one container with SQLite. Export a derived, redacted copy of reconstructed traces over OTLP; do not replace the proxy's transport capture or SQLite state. Phoenix is now ELv2 rather than a permissive OSS license, so review that constraint before redistribution.
2. **Best product/embedded path: implement a small native React tree/timeline over the existing unified model**, while making its internal span shape OTLP-compatible (`traceId`, `spanId`, `parentSpanId`, timestamps, status, attributes, events). This preserves local-only behavior, transport drill-down, styling, Clear/retention semantics, and avoids a second operational stack.
3. If a permissive license is mandatory for the external PoC, use **Jaeger all-in-one** instead of Phoenix. Its UI is less LLM-specific but the stack and license are straightforward.

## Three layers that should not be confused

- **Protocol/data model:** OpenTelemetry defines a trace as spans connected through parent/child relationships; spans carry IDs, timestamps, attributes, events, links, and status. This is a good interchange model, but it does not provide a UI. [OpenTelemetry tracing model](https://opentelemetry.io/docs/specs/otel/overview/)
- **Semantic conventions:** OpenInference adds AI-oriented kinds such as Agent, LLM, Tool, Retriever, and Chain on top of OpenTelemetry and remains usable with any OTLP-compatible collector. It is useful vocabulary, not a required runtime. [OpenInference repository and specification](https://github.com/Arize-ai/openinference), [trace conventions](https://github.com/Arize-ai/openinference/blob/main/spec/traces.md)
- **Observability platforms:** Jaeger, Tempo/Grafana, SigNoz, Phoenix, Langfuse, and OpenLIT provide ingestion, storage, query APIs, and a complete UI. They are not frontend component libraries.

## Platform comparison

| Option | Local/self-host | License | Custom span ingestion | Required backend/storage | React/UI reuse | Fit here |
|---|---|---|---|---|---|---|
| **Jaeger** | Yes; all-in-one exposes UI, collector and in-memory storage locally | Apache-2.0 | OTLP HTTP/gRPC | Jaeger process; in-memory for PoC, configured storage for persistence | Jaeger UI is React, but its package is marked `private`, depends on Redux/router/Ant Design and Jaeger APIs; embedding the full external UI is possible, not a clean component import | Best permissively licensed external viewer and OTLP compatibility test; generic rather than LLM-aware. [Jaeger quick start](https://github.com/jaegertracing/jaeger), [Jaeger UI package](https://github.com/jaegertracing/jaeger-ui/blob/main/packages/jaeger-ui/package.json) |
| **Grafana + Tempo** | Yes | Tempo and most Grafana app code AGPL-3.0; Grafana's internal TraceView component directory has an Apache-2.0 exception | Tempo accepts OTLP, Jaeger and Zipkin | At least Grafana plus Tempo; modern scalable Tempo deployments add several services/storage concerns | TraceView source is internal to Grafana, not published as a standalone supported package; extracting it means owning its Grafana data-frame/UI dependencies | Excellent operations stack, excessive for a local desktop-like devtool. [Tempo architecture](https://grafana.com/docs/tempo/latest/introduction/architecture/), [Grafana trace view](https://grafana.com/docs/grafana/latest/visualizations/explore/trace-integration/), [Grafana licensing map](https://github.com/grafana/grafana/blob/main/LICENSING.md) |
| **SigNoz** | Yes; supported self-host install | MIT outside enterprise directories | OTLP HTTP/gRPC | Heavy local stack: SigNoz, collector, ClickHouse, PostgreSQL and ClickHouse Keeper; docs require at least 4 GB for Docker | UI source is available but is application code, not a reusable trace component package | Strong trace flamegraph/waterfall, but operationally disproportionate. [self-host install](https://signoz.io/docs/install/docker/), [trace details](https://signoz.io/docs/userguide/span-details/), [license](https://github.com/SigNoz/signoz/blob/main/LICENSE) |
| **Arize Phoenix** | Yes; one container or CLI; SQLite is the default single-user store, PostgreSQL optional | ELv2 in the current repository | OTLP HTTP/gRPC; TypeScript OTEL/client packages available | Phoenix server plus SQLite is enough for a PoC | Complete app UI, not a documented embeddable React package | Best external Mastra-like agent trace PoC. Defaults need hardening: `PHOENIX_HOST` defaults to `0.0.0.0` and external UI resources default on; bind/proxy to loopback and set `PHOENIX_ALLOW_EXTERNAL_RESOURCES=false`. [architecture](https://arize.com/docs/phoenix/phoenix-deployment-options), [configuration](https://arize.com/docs/phoenix/self-hosting/configuration), [TypeScript SDK](https://arize.com/docs/phoenix/sdk-api-reference/typescript/overview), [license](https://github.com/Arize-ai/phoenix/blob/main/LICENSE) |
| **Langfuse** | Yes; can run without Internet | Core MIT, `ee` folders separately licensed | OTLP is supported | Current self-host architecture includes ClickHouse, PostgreSQL, Redis/Valkey and S3/blob storage, plus web and worker | Complete Next.js application; no supported standalone trace-tree component | Rich LLM observability, evaluations and prompts, but far beyond this product's need. [repository/license](https://github.com/langfuse/langfuse), [self-host architecture](https://langfuse.com/self-hosting), [OTLP compatibility](https://langfuse.com/docs/compatibility) |
| **OpenLIT** | Yes via Docker | Apache-2.0 | OTLP through its collector; TypeScript SDK exists | OpenTelemetry Collector plus ClickHouse and OpenLIT UI | Complete app, not a reusable UI library | LLM-oriented and permissively licensed, but adds a second database/collector/UI and overlaps much of this product. [OpenLIT repository and architecture](https://github.com/openlit/openlit) |

## Embeddable UI finding

The closest source candidates are Jaeger UI's `TraceTimelineViewer` and Grafana's `TraceView` directory. Neither is a stable component API:

- Jaeger's package is private and its timeline is connected to Jaeger's Redux state and trace types. The application supports an embedded display mode, but that embeds the Jaeger application backed by Jaeger Query; it does not turn the timeline into a dependency receiving arbitrary local data. [Jaeger UI package](https://github.com/jaegertracing/jaeger-ui/blob/main/packages/jaeger-ui/package.json), [timeline source](https://github.com/jaegertracing/jaeger-ui/blob/main/packages/jaeger-ui/src/components/TracePage/TraceTimelineViewer/index.tsx)
- Grafana explicitly grants Apache-2.0 to its internal TraceView component directory, but those files still live inside the Grafana application and are not documented or versioned as an independent package. [Grafana licensing map](https://github.com/grafana/grafana/blob/main/LICENSING.md)

Copying either subsystem would create a long-lived fork with substantial integration and accessibility maintenance. Generic tree/graph widgets can supply primitives, but they do not supply trace semantics, virtualized waterfall layout, critical-path calculations, or span-detail behavior. For this repository, the lower-risk embedded implementation is a native virtualized tree list plus duration bars, built directly against provider-neutral trace nodes.

## Suggested architecture

Keep the existing reconstruction and persistence model authoritative. Add a provider-neutral presentation projection rather than adopting a second runtime:

```text
captured Anthropic HTTP/SSE
        -> existing reconstruction state
        -> unified trace nodes + transport exchange links
        -> span-tree projection for the native React UI
        -> optional, redacted OTLP export (off by default)
                              -> Phoenix / Jaeger / other collector
```

The projection should support multiple roots or synthetic roots because reconstructed and aborted traffic may be incomplete. Keep raw headers, bodies, SSE frames, prompts, and tool results out of OTLP attributes by default. Export must be asynchronous so it cannot delay the client stream, and Clear/retention must remain defined by the product's own logical state transition rather than by an external backend.

## Practical PoC order

1. Define an internal `SpanView` projection without changing `src/core/types.ts` into an OpenTelemetry wire model.
2. Render a native tree-only view first: expand/collapse, parent guides, status, duration, search, and selection that opens the existing transport detail.
3. Add aligned duration bars and virtual scrolling after validating the hierarchy on abort, restart/restore, concurrent conversations, and missing-parent cases.
4. Separately prototype an opt-in OTLP JSON/protobuf exporter to loopback Phoenix. Compare the external view, but do not make Phoenix a product dependency.

