# Chat Trace surface annotation — design QA

## Comparison target

- Source visual truth: `/var/folders/qy/p9tt105n2_n434kqnqbr85p00000gn/T/orca-paste-1786442364176-a3ec06a7-c016-4438-8348-738b8afcf412.png`
- Implementation screenshot: `.scratch/product-design-audit/chat-inspector-palette-2026-08-11/06-chat-hover-single-surface-after.png`
- Viewport: 2048 × 767 CSS px, desktop, light theme, assistant code-only Markdown row hovered.
- Pixel dimensions: source 2048 × 767; implementation 2048 × 767. Both were compared at 1:1 size with no density normalization.
- Data: local synthetic Anthropic-shaped traffic only; no captured credentials, prompts, source code, or user trace bodies were used.

## Full-view comparison evidence

The annotated source and browser-rendered implementation were opened together in one comparison view. The two annotated defects are resolved in the implementation:

1. The hovered assistant turn no longer paints a full-row surface. Its computed row background remains transparent while Inspect and message actions are revealed.
2. A fenced Markdown reply now renders inside the message's single canvas surface. The code `pre` is transparent, has no border, and contains no nested DataSurface; the owning message surface is `rgb(250, 249, 245)` with one 1 px hairline border.

The source contains different historical trace content and an annotation strip, so unrelated row count and copy were not treated as fidelity targets.

## Focused-region evidence

A separate crop was unnecessary because both source annotations and the corresponding assistant row are legible at the matched 2048 × 767 full-view size. DOM-computed evidence was used for the near-identical warm backgrounds that are difficult to distinguish reliably by eye:

- hovered row background: transparent
- chat code background: transparent
- message background: `rgb(250, 249, 245)`
- message border: 1 px
- nested DataSurface count inside message: 0

## Required fidelity surfaces

- Fonts and typography: unchanged; message and code typography preserve the existing display/mono roles, sizes, line heights, and wrapping.
- Spacing and layout rhythm: unchanged except removal of the redundant inner code padding/container; content now aligns to the message container's single 16 px horizontal and 12 px vertical inset.
- Colors and visual tokens: message continues to use the canonical canvas role; hover adds no surface; standalone/Inspector renderers retain the data-surface role.
- Image quality and asset fidelity: not applicable; this screen contains no product imagery and no assets were introduced or replaced.
- Copy and content: unchanged by the implementation; synthetic copy was used only for local verification.

## Findings

No actionable P0, P1, or P2 differences remain for the two annotated targets.

## Comparison history

- Initial P1: entire Chat Trace row gained a warm hover fill. Fix: removed the row-level hover background utilities from grouped assistant turns and standalone trace rows.
- Initial P1: chat fenced Markdown created a nested data card inside the message card. Fix: bare/chat Markdown now renders `pre` directly and inherits the message surface; standalone Markdown still uses DataSurface.
- Post-fix evidence: `.scratch/product-design-audit/chat-inspector-palette-2026-08-11/06-chat-hover-single-surface-after.png`; browser console errors 0; error overlay absent.

## Implementation checklist

- [x] Remove unselected row hover fill.
- [x] Preserve selected-row feedback.
- [x] Remove nested DataSurface from chat fenced Markdown.
- [x] Preserve standalone/Inspector DataSurface behavior.
- [x] Verify hover, computed backgrounds, border count, console, tests, typecheck, and production build.

## Follow-up polish

No P3 follow-up is required for this annotation pass.

final result: passed
