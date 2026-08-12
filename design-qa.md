# Chat Trace `py-4` spacing baseline — design QA

## Comparison target

- Source visual context: `/var/folders/qy/p9tt105n2_n434kqnqbr85p00000gn/T/orca-paste-1786539294524-89326dcf-4436-4ef6-bc33-7e31bb67ab9c.png`
- Authoritative target: the user's follow-up instruction to restore Context and Message outer rows to `py-4` without changing message-bubble `px-4 py-3`.
- Browser-rendered implementation: `.scratch/trace-spacing-py4-baseline.png`
- Combined comparison evidence: `.scratch/trace-spacing-py4-comparison.png`
- Viewport: 2048 × 1139 CSS px, desktop, light theme; implementation screenshot is 2048 × 1139 pixels at effective device scale 1.
- Source attachment: 3432 × 1900 pixels, previously normalized to 2048 × 1139. The captured conversation changed before final verification, so content and scroll state differ; exact visual comparison is limited to component structure and computed spacing.

## Full-view comparison evidence

The combined artifact confirms that Context and Message remain in the same session/exchange structure, while Background Activity and exchange-card spacing are untouched. Because the local trace content changed, browser-computed padding is the authoritative evidence for this baseline reset.

## Focused-region evidence

Computed `padding-top` and `padding-bottom` are both 16 px (`py-4`) for sampled `system prompt`, `system-reminder`, `system`, user-message, and assistant-message rows. The message bubble still uses its existing `px-4 py-3`; no ContentViewer sizing classes changed. Message actions transition from opacity 0 to 1 on hover.

## Required fidelity surfaces

- Fonts and typography: unchanged.
- Spacing and layout rhythm: Context and Message outer rows are uniformly `py-4`; Background Activity and session/exchange containers are unchanged.
- Colors and visual tokens: unchanged.
- Image quality and asset fidelity: no assets were changed.
- Copy and content: unchanged by the implementation; local captured content changed independently during verification.

## Findings

No actionable P0, P1, or P2 differences remain for the requested baseline reset.

## Comparison history

- Initial P2: Message rows were using the temporary `py-[3px]` experiment while Context rows remained `py-4`.
- Fix: restored both standalone Message rows and grouped Assistant turns to `py-4`; simplified the shared TraceRow wrapper back to `px-4 py-4`.
- Post-fix evidence: `.scratch/trace-spacing-py4-baseline.png`; sampled Context and Message computed padding is 16 px on both edges; hover opacity reached 1; browser console warnings/errors: 0.

## Implementation checklist

- [x] Context outer rows use `py-4`.
- [x] User and assistant outer rows use `py-4`.
- [x] Message-bubble `px-4 py-3` remains unchanged.
- [x] Background Activity and session/exchange spacing remain unchanged.
- [x] Tests, typecheck, build, hover controls, and browser console verified.

## Follow-up polish

Sibling-component spacing remains a separate design decision for the next pass.

final result: passed
