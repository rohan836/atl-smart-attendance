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

## Class cubes with nested batches (SHIPPED)
- Flat Classes/Batches tables replaced by one frost tile per class
  (name + count + bin + `Schedule →`, batches nested inside) plus
  an `Ungrouped` cube last for zero-student batches. Grouping rule:
  batch B under class C iff ≥1 student has class=C AND batch=B
  (selector's own Students/Batches state); shared batches show
  under both, display only, one flat entry, zero data change.
- One add path: per-cube `+ Add batch` reuses the retired global
  row's POST body verbatim (`submitBatchName`); new names surface
  in Ungrouped until a student carries them into a class. No batch
  bins (rows never had them), no auto-prefix, no `Grade|Batch`
  creation on add. `renderBatches` folded into `renderClasses`;
  del/sched branches lifted verbatim onto `#classCubes`.
- `test_13`: cube flow (seed nesting, orphan via cube add row,
  shared-batch-twice via temp POST student + DELETE cleanup),
  plus absence proofs for every retired ID.

## Master-detail class cubes (SHIPPED, layout only)
- Left `#cubeGrid`: uniform tiles at month-header scale (name +
  count only, head type scale); selected tile wears the month
  active treatment (today outline + wash, both inks). First class
  default-selected; Ungrouped selectable. 1px `var(--hairline)`
  `.cube-wall` between grid and `#classDetail` (auto-flips dark).
- Right pane (`renderCubeDetail`): selection's batches via
  untouched `cubeBatchRow`, verbatim bin + `Schedule →`, verbatim
  per-context add row into untouched `submitBatchName`. Tile
  clicks re-render the pane only (branch inside the existing
  class listener — no new handlers); full renders validate and
  reselect. Grouping, claimed-set, Ungrouped rule untouched.
- `test_13` rescoped: tile click → detail asserts (default
  active, seed nesting, orphan in Ungrouped detail, shared
  batch in both details); grouping asserts preserved.

## Solid schedule editor (SHIPPED, popup removed)
- Left `#cubeGrid` stacks CLASSES tiles over a flat BATCHES stack
  (one `Batches` label between); Ungrouped tile retired — orphans
  surface in the flat list. Right `#classDetail` carries the
  editor solid (same cs* IDs, `csRender`/`onCsDayClick`/
  `onCsSaveTiming` verbatim, Save tail re-renders instead of
  closing). Tile clicks sync selector + month pill (ex-row-jump
  lines) and re-render the pane. Head `Schedule →` retired with
  the popup (bin kept); row `Schedule →` now selects the batch.
  `#classScheduleModal` markup + shell CSS + csClose gone; element
  CSS re-scoped `#classScheduleModal` → `#classDetail .sched-solid`
  (specificity preserved via doubled scope).
- `test_13` rewritten to the solid flow (tile click → editor
  asserts, no modal waits) + modal/csClose absence proofs.

## Text rows (SHIPPED, CSS only)
- Tile boxes retired: left stacks are solid text rows divided by
  1px `var(--hairline)` bars; hover + selected read by
  opposite-pole text alone (admin-nav language, both inks).
  DOM/IDs/logic/tests untouched — same locators still pass.

## Solid schedule, zero response (SHIPPED, CSS only)
- Editor days/time-fields/Save/clock-glyph answer hover with the
  pointer cursor alone: fills, borders, underlines, and all hover/
  focus color flips neutralized to resting values both inks
  (triple-ID pins where the D1 blanket ruled). Typing, picking,
  saving, and segment focus-legibility untouched.

## Separate batches + solid day toggles (SHIPPED)
- Nested batch rows removed from the class pane (head + add row +
  editor only); batches live solely in their left stack. Dead
  `cubeBatchRow` + row sched listener + row CSS deleted; grouping
  rule (`batchesForClass`) kept and asserted via evaluate.
- Day toggles unified: name + status one solid ink both states
  (`#F2F3F6` white, `#181A20` dark) — only the WORKING/OFF word
  swaps. All four hover rules deleted (zero response by absence).

## Student-mirror Setup split (SHIPPED, CSS only)
- Left list fixed to 340/280/360px + 24px gutter, wall, right
  detail 28px gutter — same metrics as `list-pane`/`detail-pane`.
- `.class-cube` copies `.student-row` frost block (56px to match
  month cells, 6px 14px pad, radius 4, 8px gap, 0.06/0.1/0.2, pole-law
  active) with translate + transition stripped (no-animation).
  Text-row rules (hairline bars, text-only selection) deleted.
- Add-class input + Add parked at the LEFT section's top-right:
  title segment sized to the left column so controls hug the
  wall boundary. No JS touched — IDs, handlers, selectors kept,
  `test_13` valid as-is.
- Residual: header-to-column alignment is approximate (±gap);
  flag on screenshot if the Add row drifts off the wall.

## CLASSES|BATCHES view tabs (SHIPPED)
- Left list shows one kind at a time: text tabs CLASSES (left) +
  BATCHES (right) sit in the left section's top row (same
  340/280/360 segment the title used); class tiles untouched.
- `cubeView` module state (default class) + `setCubeView`:
  selection follows into the shown kind (first item), selector +
  month + detail re-sync — right card never disagrees. Static
  tab/add nodes wired once; `renderClasses` toggles tab active
  + add-row visibility each render.
- Batch input + Add takes the top-right spot in BATCHES view,
  same `submitBatchName` persist path as the detail add row.
- `test_13` reworked for tabs (tab clicks around batch asserts,
  `newBatchName`/`addBatchBtn` now assert present, count `>=2`
  in batch view, classes tab re-selected before class steps).
- Batch creation now lives only in the left bar; `test_13` adds
  Robotics-A through `#newBatchName`/`#addBatchBtn`.

## Context selector on the month bar (SHIPPED)
- `#calClassSelect` moved from the retired weekly header into the
  month legend (middle, right of OVERRIDE); empty header deleted.
  JS untouched (ID-based); the two scoped gsel rules retargeted
  to `.setup-monthview-legend`; dead header/actions CSS removed.

## Four-tile cap + inner scroll (SHIPPED, CSS only)
- Pill retired: the selector IS the readout — `#calMonthContextLabel`
  node, its CSS entries, and the `renderCalendarMonth` pill block
  deleted; `test_13` asserts the selector value + pill absence.
- `#cubeGrid` capped at 248px (4×56 tiles + 3×8 gaps) with
  barless `overflow-y:auto` (`scrollbar-width:none` + hidden
  webkit bar) — wheel / touch / trackpad scroll inside the left
  bar, no visible scrollbar, page never stretches.

## Toolbar geometry lock (SHIPPED, CSS + 2 empty nodes)
- All four panes share one bar zone: 52px single row, same pads /
  gaps / bottom bar / 20px gap below. Overflow scrolls barlessly
  instead of wrapping — switching sections can't move bars or
  content. Students search basis 100%→420px to ride the row.
- Empty `.tab-toolbar` spacers (aria-hidden) top Setup + Backup.
- Tradeoffs: toolbar content left-aligned (was centered on
  Students); narrow screens scroll bars horizontally.

## Attendance bar cleanup (SHIPPED — old-UI single row)
- Honest provenance: the underlines + inline date boxes predate
  this session (committed in `7527289`); they surfaced only in
  Custom states while the old screenshot shows Today. Fixed anyway.
- Filters text-only: select/gsel-btn/date-field underlines →
  transparent (rest/hover/focus/dark), matching the preset pills.
- Inline reveal retired: range/academic from/to + Apply stay
  hidden (frost popup commits values); Custom Date keeps its one
  inline field (no popup exists for it). Bar holds 52px in every
  preset state; seg strip pinned nowrap.
- `test_14` steps 4–5 rewritten (hidden asserts, machinery via
  evaluate, 52px bar-height assert).
- `test_14` harness fix: preset changes drive seg-pill clicks
  (`select_option` can't target the hidden native select); plus
  `.dt-trig:visible` counts per preset (1 in custom_day, 0 in
  custom_range) guarding the orphan-glyph fix.

## Shared-datum geometry lock (REVERTED with the swap below)
- Kept: helper legend line below the grid; 56px cubes + 248px cap;
  locked 28px editor head. Reverted: header-row hairline,
  bottom-pinning, month-head-as-right-cell, 280 compression.

## Month/editor swap (REVERTED per user order)
- Month is back full-width in its section (legend + selector + nav
  + grid, no pill); solid editor is back in the right pane
  (`renderCubeDetail` → `#classDetail`, innerHTML rebuild,
  `onCubesClick` on the split root only, left bar back to
  340/280/360). `#scheduleEditor` fully removed (HTML/CSS/JS).
- `test_13` repointed back: `detail` = `#classDetail`.
- Verified live: editor-in-`#classDetail`, month-in-section,
  `test_13` + `test_14` green locally.
- Pre-existing failures (proven on stashed committed tree, not
  this session): `test_15` override→grid refresh, `test_09`
  USB text casing, `BinHoverTest` (`classBody` parked).

## Geometry lock (SHIPPED — fixes tab-switch stretch + right mess)
- Cause 1: header add row flowed past the title segment into the
  detail side. Fix: tabs + add stacked in `.cube-left-head`,
  same 340/280/360 + 24px box as `#cubeGrid` — controls end at
  the wall; right side is display + edit only.
- Cause 2: `#addBatchBtn`/`#newBatchName` missed every treatment
  their class twins had (boxed ADD = taller header = stretch).
  Fix: sibling-audit mirror into all six selector groups.
- Cause 3: class detail carried an extra batch add row, so class
  and batch cards had different skeletons. Fix: row deleted
  (creation lives only in the left bar via `submitBatchName`);
  dead listener + CSS + `.cube-add-btn` group entries removed.
  Both details now share one skeleton: locked 28px head +
  hairline + solid editor — schedule never shifts between views.

## Add-class top-right (SHIPPED, move only)
- Same input + button nodes moved into the Classes header row
  (title left, controls right, capped 300px); IDs, handler, and
  styles untouched.

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
