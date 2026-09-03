# Glass Confirm + Asset Compression — Build Plan (E:\temp only)

Owner-approved queue tasks 1+2. No deploy.

## Task 1 — glass confirm/alert (replaces 6× confirm, ~45× alert)
- Component in `ui_app.js`: `glassDialog({title,message,okText,cancelText,danger})` → `Promise<boolean>`; wrappers `glassConfirm(msg,opts)`, `glassAlert(msg)`. Frosted overlay (blur, image behind) + glass card, serif title, `pre-line` message via `textContent` (XSS-safe names), Cancel text-button + solid OK (ink; red when danger). Overlay click = no-op (destructive safety). Keys: Enter=OK, Esc=Cancel (capture+stop), Tab trapped, focus in/out restored.
- Rewrites: `if(!confirm)` → `if(!(await glassConfirm(title/okText/danger)))` (all 6 sites already async — verify); `alert(x)` → `await glassAlert(x)` in async flows (esp. before `reload()`), bare call in sync handlers.
- `prompt()` (Admin PIN) stays native — E2E PIN tests untouched.
- E2E: only test_12 disconnect-confirm blocks → click `.gconfirm-ok` instead. Alert-type `once("dialog")` handlers become harmless no-ops (leave them).

## Task 2 — compress background (4.9MB → ~300KB JPG)
- Pillow convert RGB q82 (+downscale 1920w if needed), write `glass-bg.jpg`, delete PNG, update CSS `body::before` URL, screenshot-compare terminal.

## Must not break
IDs/endpoints intact · delete/restore still gated behind explicit confirm · scan/enroll untouched.

## Built 2026-09-03 (verified)
`glassDialog` + `glassConfirm`/`glassAlert` in `ui_app.js`, `.gconfirm` CSS. 6 confirms + 45 alerts converted, zero native left (PIN `prompt` stays). **14/14 E2E + 116/116 unit green.** Screenshots: danger-delete, notice-OK, live delete flow. Overlay click = no-op; Enter/Esc/Tab-trap/focus-restore verified.
