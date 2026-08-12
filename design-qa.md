# Chat Trace message footer spacing — design QA

## Comparison target

- Source visual truth: `/var/folders/qy/p9tt105n2_n434kqnqbr85p00000gn/T/orca-paste-1786539294524-89326dcf-4436-4ef6-bc33-89ba-e8f8116e0edd.png`
- Authoritative refinement: ordinary Message rows use `pt-4 pb-0`; their ContentViewer controls receive `py-2`. Context rows retain `py-4` and their existing control spacing.
- Browser-rendered implementation: `.scratch/trace-message-footer-spacing.png`
- Combined comparison evidence: `.scratch/trace-message-footer-comparison.png`
- Browser viewport: 1728 × 906 CSS px, desktop, light theme, reported device scale 2. The implementation capture is 1728 × 906 pixels; the normalized source is 2048 × 1139 pixels.
- State: focused four-pair fixture rendered with the current production-build CSS. The live captured trace was empty during verification, so exact geometry is verified independently of captured content.

## Full-view comparison evidence

The comparison shows the oversized Message footer region in the source and the redistributed footer rhythm in the implementation fixture. Background Activity, session/exchange cards, message-bubble padding, typography, and color decisions are outside this scoped change and remain unchanged.

## Focused-region evidence

Browser-computed geometry:

- Ordinary Message outer row: `padding-top: 16px`, `padding-bottom: 0px`.
- Message controls wrapper: `padding-top: 8px`, `padding-bottom: 8px`.
- ContentToolbar control height: 28px.
- Context → Context and Context → Message: following sibling `margin-top: -16px`.
- Message → Context and Message → Message: following sibling `margin-top: -8px`.
- All four boundaries: 16px spacing plus the existing 1px divider, measured content-to-content as 17px.

## Required fidelity surfaces

- Fonts and typography: unchanged.
- Spacing and layout rhythm: ordinary Message bottom padding is transferred to its controls; all four Context/Message boundaries retain the same 16px spacing rhythm. Tool-ending and control-less Message states retain an explicit 8px fallback footer.
- Colors and visual tokens: unchanged; the CSS uses existing spacing and role tokens.
- Image quality and asset fidelity: no assets were changed.
- Copy and content: unchanged.

## Findings

No actionable P0, P1, or P2 differences remain for the requested footer-spacing refinement.

## Comparison history

- Initial P2: Message outer `pb-4` sat below an already 28px-tall ContentToolbar, making the footer visually heavier than Context boundaries.
- First sibling fix: all classified rows shared a uniform 16px negative offset, which assumed both row types retained full `py-4`.
- Final fix: Message rows now use `pb-0`, TurnControls owns `py-2`, and the sibling correction keys off the preceding row type: 16px for Context and 8px for Message.
- Post-fix evidence: `.scratch/trace-message-footer-spacing.png` and the computed measurements above.

## Implementation checklist

- [x] Context rows remain `py-4`.
- [x] Ordinary Message rows use `pt-4 pb-0`; tool-ending and control-less Message states use the 8px fallback footer.
- [x] Message ContentViewer controls use `py-2` around the existing 28px control height.
- [x] Context control spacing remains unchanged.
- [x] All four sibling combinations retain one 16px spacing inset.
- [x] Message-bubble `px-4 py-3` remains unchanged.
- [x] Background Activity, session/exchange cards, and ContentViewer body sizing remain unchanged.
- [x] `pnpm test`, `pnpm typecheck`, and `pnpm build` pass.

## Follow-up polish

No remaining P3 spacing recommendation for this scoped change.

final result: passed
