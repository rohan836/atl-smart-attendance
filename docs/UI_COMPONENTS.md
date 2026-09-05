# UI Components — Full Inventory (single reference)

Snapshot of the admin + kiosk UI as implemented in
`ATL-Smart-Attendance-Production.html` (markup/CSS/layout) and
`backend/ui_app.js` (behavior). **Read-only reference — no UI changes.**
For the enforceable design contract see `skills/atl-frosted-ui/SKILL.md`;
for canonical frost numbers see `docs/UI_TOKENS.md`.

## 1. Locked visual language (applies to everything below)

- Warm ambient background stays visible through the UI; subtle
  translucent/frosted neutral fills; 1px translucent hairlines for
  structural separation only.
- Monochrome: white / near-black / translucent white. No colored badges,
  chips, shadows, opaque cards, or heavy borders.
- Actions are **text-first, plain text** (no boxes, no underlines —
  explicit user override; the old primary-contained pattern is retired,
  its CSS rules survive only as dead code overridden later).
  Destructive verbs stay monochrome; the verb copy carries the warning.
- Type: `var(--sans)` for interface text, weight **400 normal / 500
  important-active** (never 600/700); `var(--mono)` only for dates,
  times, IDs, counts, technical data; serif only for major titles.
  Primary white → secondary translucent → tertiary softer translucent.
- Theme vars: `bg #FCFBF7 · panel #F2F3F6 · ink #181A20 · ink-2 #6B6B6B ·
  ink-3 #A8A5A0 · line #E9E6E0 · paper #F6F4EF · ok #2F5D34 ·
  danger #8A3A3A`, fonts `Inter / Newsreader / ui-monospace`.
- Frost tokens (verbatim from `docs/UI_TOKENS.md`): fill
  `rgba(255,255,255,0.08)` · blur `blur(24px) saturate(1.2)` · line
  `rgba(255,255,255,0.14)` · radius `2px` (3px large modals) ·
  `--hairline: rgba(255,255,255,0.12)` (the global structural line) ·
  input underline `0.2` white (`#F2F3F6` on focus) · row separators
  `0.07–0.08` white.

## 2. Global primitives

- **Hairlines**: 1px translucent-white structural dividers (toolbar
  bottoms, grid/card section splits, table header lines, row separators).
  Widths/styles never change; only hue remaps in dark mode (D10).
- **Ink toggle** (`Ink: White ⇄ Black`, top bar, persisted `atl_ink`):
  `html[data-ink="dark"]` flips **text tiers only** — primary `#181A20`,
  base `rgba(24,26,32,0.8)`, placeholders `rgba(24,26,32,0.5)`.
  Backgrounds/frost/blur/borders/layout frozen. Native `<option>`
  popups and kiosk layers excluded (stay white-on-dark).
  Sub-layers: D1 base text · D2 titles/values · D7 tab indicator ·
  D8 backup outliers + checkboxes · D9 scrollbars · D10 structural
  hairline hue-flip (triple-ID, beats `:has`-smuggled (2,3,2) rules) ·
  D11 setup/backup field underlines. Flip is **instant**: a 2-frame
  `ink-switching` guard forces `transition:none` while the attribute
  swaps (kills the ~150ms color-fade lag on large DOMs).
- **Scrollbars**: 6 custom total; 2 hidden by design (nav, toolbar,
  day-strip `display:none`). Painted + ink-aware: classes/batches lists
  (`.setup-list-scroll`, thumb `0.2→0.35` dark), audit table/detail,
  dropdown popups. Tracks transparent. Firefox `scrollbar-color` matched.
- **Custom dropdowns** (`gsel` system): native `<select>` is the
  invisible truth (`opacity:0`); visible `.gsel-btn` carries a single
  text chevron; `.gsel-pop` portals to `body`. Ghost-text cause:
  a global `opacity:1` rule re-showing the native select.
- **Text actions**: `10.5px / 500 / 0.04em / uppercase`, transparent,
  no underline, no transition. Hover = color shift only.
- **Refresh**: static `↻` text glyph, `14px`, no animation of any kind
  (no spin, no `Refreshing…` swap); click briefly disables while data
  reloads. Attendance toolbar, `order:99 + margin-left:auto` → docks
  at the bar's right end.
- **Search magnifier**: static `⌕` at `18px` (= 11.5px field text ×
  ~1.5 optical ratio for thin glyphs), tertiary-white (dark `0.6`),
  non-interactive; lives in a full-width `.search-wrap` so icon +
  field share one line and the 2-row toolbar rhythm is unchanged.
  Search underline: idle `0.2→0.35` dark, focus `#FFF→#0A0A0A`,
  placeholder `0.4→0.5` dark.

## 3. Kiosk (idle) surface

- Idle prompt `PLACE YOUR FINGER`, `11px / 0.22em` spacing; `Admin`
  entry bottom-middle. Excluded from ink mode (dark-on-dark already).
- Scan loop `POST /api/scan {waitSec:2}` runs on kiosk and behind Admin
  (identity popup suppressed); pauses during enrollment/modals and
  sensor maintenance; `GET /api/scan/last` bridge every 2s; both feed
  `window.handleRealScan`. `NO_FINGER/SENSOR_BUSY/UART` create no event.

## 4. Admin shell

- **Top bar** (`64px`, `0 24px` padding): left title, **header-integrated
  nav** (Students · Attendance · Setup · Backup), right group
  `INK | ESC TO CLOSE | CLOSE`. Nav is shift-proofed (absolute center,
  uniform weights — no 400↔500 width jumps). Active tab = underline
  indicator (white; near-black in dark mode, D7).
- **Body/panes**: flex column panes; one visible tab at a time.
- **Toolbars**: hairline bottom border, `10px 16px` padding,
  `min-height 48px`, centered wrapping flex, `gap 10px 18px`.
  Table headers are **static text** (no sticky bar) except class/batch,
  which use a separate outside `.setup-thead-bar` grid row
  (`46% 18% 36%`, `9.5px/500/0.06em/uppercase`, `0.15` underline).

## 5. Students pane

- Toolbar row 1: search (full-width wrap, `11.5px`, max `560px`) with
  `⌕`; row 2: class/batch/status filters + New Enrollment / Import /
  Export (all text actions).
- Split view: list pane + detail pane; list rows editorial
  (photo + fields, frameless); PK placeholder de-carded; empty states
  plain text. Filters underline `0.22`, focus `#FFF` (dark-flipped).

## 6. Attendance pane

- Toolbar: date/status filters + PRINT + EXPORT CSV grouped left/center;
  static `↻` docked right end.
- Stats row, attendance table (static thead), duplicate/late/not-
  scheduled/absent states per attendance law (`PRESENT ≤08:00`, else
  `LATE`; same-day re-scan `DUPLICATE`; `NOT_SCHEDULED` muted;
  `ABSENT` only after `lateCutoff` via daemon/manual reconcile).
- Unknown-scan strip + timing notice; `LIVE TODAY` badge.

## 7. Setup pane (audited: 27 lines — 17 structural via D10, 7 field underlines via D11, 3 N/A)

- **Grid**: 2-col editorial (`1fr 1.5fr`), sections split by `0.12`
  hairlines only; cards are transparent flow (no boxes).
- **School + rules**: merged 2-col; timing inputs mono, `0.22`
  underlines (dark-flipped, D11); rule blocks separated by `0.12`
  top hairlines.
- **Classes / batches**: density-matched rows; headers as outside
  `.setup-thead-bar`; row lines `0.07`; add-buttons are text.
- **Weekly template (month header row)**: the SUN–SAT headers are 7
  `weekly-day-card` frost blocks (`working`/`off` per active context
  template) — click or Enter/Space toggles the weekday through the
  single-POST persist path, then headers + month cells re-render.
  Zero borders; same fade/blur tokens as the tiles below.
- **Month view**: grid chrome dissolved; header cards edit the
  recurring template while every date tile shows the resolved day
  (`0.04–0.14` by state, `12px` blur for Pi perf, `8px` gaps, `4px`
  radius). Today keeps its ring marker. Legend + prev/next/today are
  text actions.
- **Holidays / overrides**: no list tables — every month day cell
  opens a unified day editor (`640px` frost card, three hairline-split
  sections): (1) resolved badge + global-vs-template source line;
  (2) Day status — one-click working/non-working flip (existing note
  kept, else empty per the optional-note rule), inline note field,
  Clear override on override days;
  (3) Holiday range — name/start/end/type fields with the holiday
  validators; filled form means edit mode, empty means create mode
  (start prefilled with the clicked date); saves upsert by start so
  renames can't orphan ranges; Remove on holiday days. Per-context
  Present/Late timing lives in the Setup timing bar (inputs prefilled
  from the active context with the inherit notice, `Save` +
  `Inherit` revert, three-branch save with validators and
  confirmations). A collapsible read-only range index under the grid
  counts the displayed year's holiday ranges and jumps to their
  sheets. Single-POST persist throughout. Validated `YYYY-MM-DD[..YYYY-MM-DD]:type:name`
  (`holiday|vacation|exam`, exam = working). Precedence:
  override → holiday/vacation/exam → weekly; weekly per-student
  Grade|Batch → batch → class → global; default Sun off, Mon–Sat on.

## 8. Backup pane

- **Action column law**: statuses sit right (`READY`, `NOT CONNECTED`,
  `ON`); action rows (Telegram pair, USB trio, schedule pair) are one
  left-aligned system — `10.5/500/0.04em`, `16px` gaps.
- **File row**: `Last backup: Never` left; `RESTORE DB | DOWNLOAD DB`
  right as baseline-locked text (`inline-flex`, `line-height:1`,
  shared padding/type, `16px` gap, no boxes/bars).
- Checkboxes custom-drawn (`14px`, hairline box + check; dark-flipped
  D8). Schedule time/freq/interval: dark text (D8), idle underlines
  dark `0.35`, focus near-black.
- **Audit history**: editorial table, header `9.5px/500/uppercase`
  (`0.8` dark), rows `0.07`; Export/Clear are text actions; scrollbars
  ink-aware (D9).

## 9. Custom frost date/time picker (replaces native popups)

- Native clock/calendar popups are browser chrome and can never wear the
  theme — so date/time fields (`YYYY-MM-DD` / `HH:MM` 24h) get their own
  trigger + portalled `.dt-pop` (same architecture as gsel dropdowns).
- Trigger: text glyph (`▦` date / `◷` time, `13px`, tertiary → dark
  `0.6`), absolute-right inside a `.dt-wrap`; native indicator hidden.
- Popup: frost tokens, `12px` padding, `z 120`; date = weekday row +
  tile grid (`6px` gaps, `4px` tiles, selected deeper, today ring,
  outside-month dim) + Month/Prev/Next + Clear/Today text actions;
  time = hour (1–12) / minute (5-min steps, keeps typed odd minutes) /
  AM-PM scroll columns, live-apply + Done/Clear.
- Typing stays native; picker writes well-formed values only and fires
  `input` + `change` so existing save flows work. Esc / outside /
  scroll / resize closes. Ink-aware like `.gsel-pop`.

## 10. Overlays
- **Enrollment modal**: frosted card, editorial type, transparent veil
  (milky-modal cause = veil+blur stack, never chase fill to 0); CLASS
  ghost fixed; 1 Start + 3 captures w/ lifts, progress via
  `/api/sensor/progress`.
- **Holiday / override / correction modals**: frosted, same system.
- **Confirm dialogs** (`.gconfirm`): text verbs, monochrome danger.
- **Dropdown popups**: frost surface per tokens (`8px 14px` rows,
  `32px` min-height), portalled, ink-aware thumbs.

## 11. Known residuals (not bugs — serve/staleness or by-design)

- Screenshots can trail fixes by a turn: hard-reload (`Ctrl+Shift+R`)
  + Flask restart before judging; Pi needs `tools/deploy.ps1`.
- Interactive control borders outside setup/backup flip per-case on
  request (pattern established: idle dark `0.35`, focus `#0A0A0A`).
- D10 flattens structural alphas to one dark `0.14` (1px-negligible).
- Calendar tiles use `12px` (not 24px) blur deliberately for Pi perf.

## 12. Standing rule + sibling-audit log (user-ordered)

- **Sibling rule**: fixing one instance obliges auditing every sibling
  (all panes, all modals, both ink modes) in the same turn.
- Log:
  1. Segment blue survived in holiday/override date fields — scope was
     `#adminLayer` only; extended to all three modals, both poles.
  2. Same turn: modal text/date/select/textarea underlines had zero
     dark coverage (setup D11 pattern) — flipped idle `0.35` + focus
     premium charcoal for holiday/override/correction.
  3. Override/holiday dropdown (gsel-btn) underline likewise unflipped —
     fixed idle + hover/open poles.
  4. Opposite-pole hover law: white hover `#0A0A0A`, dark hover
     `#FFFFFF` (D4b), all 14+ dialog verbs + pane saves + picker.
