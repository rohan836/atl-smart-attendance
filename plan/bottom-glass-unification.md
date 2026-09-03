# Bottom-Half Glass Unification — DONE

Owner: header good, body not — white toolbar stripe, two-tone panes, wash-out, faint active tab, weak helper copy.

## Built
1. Toolbar → transparent + white hairline; fields underline-style (these got fully borderless later — see `toolbar-borderless.md`).
2. List pane → transparent frost + hairline divider; rows hairline; hover white wash; active row = glass-white + ink text + 3px ink accent bar (black slab gone).
3. Active tab underline 2px → 3px; ghost box removed.
4. Empty-state text → ink-70 + soft white glow over blobs.

## Did not break
No DOM/ID changes · 30px targets kept · scan/enroll untouched · ink-on-glass contrast kept.

## Verify
Screenshots of Students, Attendance, Setup, Backup inspected, no page errors. Setup cards + Backup manager float unified; primaries (`SAVE/ADD/BACK UP NOW/PAIR`) stay solid black.

## Next
Done. Open polish: Setup static inputs still boxed (candidate task in `next-tasks.md`).
