# Toolbar Borderless Fields — DONE

Owner: search + `All Classes/Batches/Active` carried borders while IMPORT/EXPORT were clean text; the open-list blue highlight doesn't match.

## Built
- Toolbar inputs/selects borderless at rest (translucent white bg, transparent underline); ink hairline appears on hover/focus only. Selects get pointer cursor; placeholders ink-70.
- `option` rows themed paper/ink, checked row ink/white (Chrome honors this in the popup).
- **Disclosed limit:** the open-popup hover blue is OS-drawn and unreachable by CSS. Full custom popups came next (`glass-dropdowns.md`).

## Did not break
Native `<select>`s kept (E2E `selectOption` safe at this stage) · no DOM/JS changes · scan/enroll untouched.

## Verify
Close-up screenshots: rest state borderless, focused search shows ink hairline · no page errors · minimal diff.

## Next
Done — superseded for popups by glass dropdowns. Toolbar triggers now rendered by that component.
