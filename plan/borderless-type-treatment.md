# Borderless Reference Type — DONE

Reference: white uppercase micro-type, pipe-separated nav, zero boxes except one CTA. Kiosk is offline → Inter only, no webfonts.

## Built
- `:root` tokens: `--on-img`, `-70`, `-60`, `--hair-w` (white hairline).
- Header goes glass-transparent: white serif title, white-60 esc hint, `CLOSE` borderless white; tabs borderless white-70 with `|` pipes, active = full white + 3px underline (replaces black fill).
- Terminal: `PLACE YOUR FINGER` 88% white, `Admin` borderless white-75.
- Buttons tiered: secondary `.btn` (IMPORT/EXPORT/Refresh/Print/Cancel…) → borderless ink text + hover underline, globally incl. modals. `.primary` stays solid black (single CTA), `.danger` stays bordered.
- Glass-card body text untouched (ink). `:focus-visible` outlines: white on image/header, ink on light.

## Did not break
No DOM/ID/class changes (E2E selectors safe) · scan/enroll untouched · contrast: white only on image/frosted-header.

## Verify
Playwright screenshots (terminal + Students) inspected · no page errors · 1-file CSS diff.

## Next
Done. Follow-ups live in `bottom-glass-unification.md` (toolbar/panes) and `toolbar-borderless.md` (fields).
