# Month Header-Row Template Editor (Phase 1+2)

Status: SHIPPED — old strip removed, headers carry the template.

## Problem
Recurring weekly template lived in its own `#weeklyDaysRow` strip,
duplicating the month grid's weekday axis one section above it. Two
places showed weekdays; only one resolved into the calendar.

## Change
- Phase 1 (`backend/ui_app.js` `renderCalendarMonth`): SUN–SAT headers
  render as `weekly-day-card working|off` from the active context
  template (`getScheduleContext` + `getWorkingDaysForClass/Batch`),
  both inks via existing frost/fade. Clicks route through
  `onDayToggleClick` → single POST `persistCalendar` → re-render.
  One-line legend above the grid states the split.
- Phase 2 (this): deleted `#weeklyDaysRow` + dead `#weeklyTable`
  (HTML), their `renderWeekly` blocks + dead listener (JS), retargeted
  `test_13` to `#calendarGrid .weekly-day-card`. Headers gained
  Enter/Space keydown (they already carried `tabindex/role`).
- Docs: `UI_COMPONENTS.md` §7, `ADMIN.md` Setup line.

## Untouched
Month cells, today ring, context pill, nav, timing, selector,
holiday/override tables, dark pole, all CSS values (dead
`#weeklyDaysRow` selectors pruned, card rules kept).

## Verify
Hard-reload → Setup, both inks: headers-only, no strip. Toggle a
header weekday → its month column re-resolves. `test_13` green.

## Phase 2 — sheet absorbs the tables (SHIPPED)
- Sheet gains `Edit holiday <name>` (same lifted-upfront edit path
  as the table Edit, via `openHolidayEditForm`) and `Remove <name>
  range` (glass confirm + same filter-by-start removal + single POST
  + re-render + sheet refresh), shown only on holiday days.
  Override edit/delete were already live (Mark verbs + Clear).
- Deleted: holiday + override list sections (HTML), their table
  listeners + Add-button wiring (JS — bodies gone, listeners would
  throw on null), all dead table/badge/button CSS selectors both
  inks (values untouched). `renderHolidays/renderOverrides` stay as
  null-guarded early returns.
- `test_15` extended: holiday create-via-sheet → Edit/Remove verbs
  → confirm → template restored. Docs: this note, `ADMIN.md`,
  `UI_COMPONENTS.md` §7.

## Phase 3 — unified day-editor window (SHIPPED, old modals kept)
- `#daySheetModal` card widened to `640px` (frost/radius/veil/inks
  untouched, base scroll rules carry over). Three hairline-split
  sections (`var(--hairline)`, ink-flipping): header (badge +
  source, as-is), Day status (one-click flip + inline note with the
  override trim rule + Details… + conditional Clear), Holiday range
  (1:1 lifted fields + validators, start prefilled, in-place
  refresh; Edit lazy-prefills, Remove confirms).
- Section-3 save upserts by start (filter-then-push, override-save
  precedent) so Edit→Save can't duplicate a range; validator text
  identical. Field language extended to `#daySheetModal` selectors
  only, both inks (labels/inputs/focus/placeholder/gsel/error).
- Caller audit: `openHolidayEditor`/`openOverrideEditor`/
  `openHolidayEditForm` are called ONLY by sheet verbs — nothing
  outside the sheet uses them. Old-modal removal is a later pass.
- `test_15` rewritten for the single window (status+note,
  reload-persist, clear, section-3 create, Edit-prefill,
  confirm-remove).

## Cleanup — single window only (SHIPPED, zero logic changes)
- Deleted: `dsDetails` + `dsHol` opener verbs/handlers (inline note
  + section-3 save already did both jobs), `openHolidayEditor` /
  `openOverrideEditor` / `openHolidayEditForm` (zero outside callers),
  `#holidayModal` + `#overrideModal` blocks, their CSS groups (kept
  daySheet-only incl. the `.gsel > select` opacity pin the screenshot
  caught missing), veil-click + Esc entries.
- Kept bit-identical: flip upsert + note handling, Clear,
  Edit-prefill, Remove-confirm, validator text, single POST,
  resolvers, precedence, all values. Upsert-by-start stays.
- `test_15`: old-window steps rewritten to inline equivalents
  (incl. asserting `#overrideModal` is gone from the DOM).

## Calendar merge REVERTED — tables own editing again (headers keep the template)
- Restored verbatim from `9f19c68`: holiday + override list tables
  markup (Row 3), `#holidayModal` / `#overrideModal` blocks, Add /
  table-Edit / table-Remove handlers, `renderHolidays` /
  `renderOverrides` bodies, Esc entries.
- Removed from the calendar: day-window Day-status flip +
  Holiday-range sections (window is read-only badge + source +
  Close), the range index (`rangesInYear` / `renderRangeIndex` +
  call), all `ds*` editing IDs + pins. Cells are read-only resolved
  display; header template editing untouched.
- `test_15` rewritten to the table flow (add / reload-persist /
  edit-prefill + rename / direct remove for both tables, read-only
  window asserts); other 14 unmodified.

## Schedule editor moves into one popup (Setup display-only)
- New `#classScheduleModal` (cs* IDs): opened by class/batch
  `Schedule →` with that context; weekday toggles lift the retired
  header-toggle branches verbatim (+ popup refresh), timing save
  lifts the bar handler verbatim (validators, 3 branches,
  double-POST, mirror sync; tail closes + refreshes instead).
- Setup surrenders editing: headers/cells/bar display-only
  (bar inputs disabled + picker trigger hidden), Save/Inherit +
  reset-week handlers and buttons deleted with their CSS.
- No second editor: single `persistCalendar` path kept.
- REGRESSION FLAGGED: Inherit-revert dropped (popup is Save +
  Close) — custom timings stand until overwritten.
- `test_13` rewritten to the popup flow; `test_15` unchanged.

## Setup remnants deleted (Setup views, popup edits)
- Deleted: `#calScheduleBanner` + banner renderer, Weekly Template
  title/sub block, full timing bar (inputs, badge, notice),
  `renderScheduleTiming`, reset-week + bar handlers, all their CSS
  both inks. Selector, month, tables, foot notes untouched.
- `test_13` step 5 asserts via reopened popup values + grid
  resolution, plus absence asserts for every deleted ID.
- Shortcut door (no new editor): read-only window gains `Add
  override for this date…` → prefilled `#overrideModal`, verbatim
  save path; `test_15` 9b covers prefill + save + cleanup.

## Edit-ceremony kill + rename fix (SHIPPED, stabilizer held)
- Section 3 auto-prefills at open on holiday days; `dsEditHol`
  deleted. Saves track the prefilled original start and filter it
  alongside the field start — renames move the range, same-start
  saves unchanged, no orphans. Clear-path layout untouched (card
  shrink is correct; no other movement evidenced).
- `test_15`: prefill asserts + rename round-trip (old gone, new
  present, exactly one range via `/api/settings`).

## Timing moves into the window (SHIPPED, then REVERTED — bar is back in Setup)
- Setup timing bar deleted (bar, dual badge, inputs, buttons, all
  their CSS both inks); section retitled Weekly Template. Save +
  revert handlers lifted verbatim (3 branches, double-POST, mirror
  sync, validators, alerts) as per-open-wired window functions
  (dynamic DOM needs it —
  no load-time guard can see the inputs). `renderScheduleTiming`
  repointed at in-window inputs, badge dropped (month pill is the
  only context badge), early-return kept. `renderWeekly` name kept.
- `test_13` steps 2–5 + 7 retargeted (pill + window flow; badge and
  Setup-notice deletions forced the extra locator swaps, asserts
  preserved). Picker risk: custom time-picker rides the same
  MutationObserver path as the proven in-window date fields —
  confirm visually.
- REVERTED: window Timing section, window save/revert functions,
  all window timing IDs + CSS pins removed;
  `#schedTimingCard` block, both handlers, `renderScheduleTiming`
  (dual badge included), and all sched CSS restored verbatim from
  HEAD. Title keeps Template, subtitle regains timing. `test_13`
  steps 4–5 back on the Setup flow (badge/notice locators defined
  in step 4 since steps 2–3 stay pill-based).

## Index + signpost adds (SHIPPED, no rebuild — signpost verb since REMOVED)
- Collapsible read-only range index under the grid (count + jump
  rows for the displayed year, editing stays in the sheet) and a
  legend `Timing…` verb opening today's window scrolled to Timing.
- `test_15`: index count/row-jump + Timing-verb in-view asserts.
- Verb REMOVED with the timing revert (its only target was the
  window section): `#calTimingBtn` button + wiring deleted,
  `test_15` step 10 deleted. Index untouched.
- Index REMOVED with the calendar-merge revert (tables own overview
  again): `rangesInYear` / `renderRangeIndex` + call deleted,
  `test_15` index asserts replaced by table asserts.

## 2026-09-05 — "UI dead" incident + recovery record
- Symptom: clicks, windows, popups, hovers all dead at once;
  dark text wrong after ink switch.
- Diagnosis: full static audit came back CLEAN (one `<script>`
  at body end, all IDs present exactly once, zero duplicate IDs,
  render paths guarded, CSS braces/comments balanced, modal and
  hover rules present, day-window builder intact). No code break.
- Cause: stale browser cache serving an older pass. Fixed by
  hard reload (`Ctrl+Shift+R`) at `http://127.0.0.1:5000/`.
- Rule learned: "everything dead at once" + clean audit means
  cache or missing backend — confirm URL + hard reload + boot
  banner BEFORE any code hunt.
- Diagnostics kept (failure-only, invisible on success):
  `console.error` in 17 attendance-path catches; 3-line boot
  banner (`bootFail` — sync render + async load covered).
- Commit `5a23396` on `feature/ui-glass-redesign`: timing
  revert + range index + boot diagnostics (10 files).
  Left for follow-up commit: `backend/test_app.py`
  (BinHoverTest) + `skills/atl-frosted-ui/`.
