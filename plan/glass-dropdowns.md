# Glass Dropdowns — DONE

Owner: all native select popups (OS blue) must match the vibe + be translucent. Only fix: custom JS popups.

## Built
- `__glassSelectInit` in `backend/ui_app.js`: wraps each `<select>` (native kept live, opacity-0, as truth), borderless trigger + chevron, fixed glass popup (white `.78` + `blur(18px)` + hairline + shadow), 36px rows, hover wash, selected ink/white, optgroup headers.
- Two-way sync: pick → native value + `change` (zero app-logic change); native `change` + option-mutations re-sync label. Rows built lazily on open (dynamic filters safe).
- Keyboard (arrows/Enter/Esc), outside-click close, flip-up positioning, `listbox` roles, auto-enhance via MutationObserver (modal-injected selects included). 12 static + 8 modal selects covered.
- Excluded: date/time pickers (custom calendar too big) and `confirm()/alert()` boxes (proposed follow-up).

## Did not break
App logic zero-change · scan/enroll untouched · no new folders.

## Verify
Open-popup screenshots (Students, Attendance, Setup optgroups, enroll modal) · **14/14 E2E pass unmodified** (native bridge held) · no page errors.

## Next
Done. Follow-up candidate: custom glass confirm (`next-tasks.md`).
