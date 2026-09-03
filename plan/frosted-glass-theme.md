# Frosted Glass Background — DONE

Reference: orange 3D shapes on taupe + frosted glass card. Applied across terminal + Admin, layout and logic untouched.

## Built
- `assets/images/ui/glass-bg.jpg` (1920w q82, 61KB — was 4.9MB PNG), `body::before` URL updated. Terminal screenshot identical.
- `.terminal` + all Admin panes transparent so the image shows through everywhere.
- Glass tokens in `:root`: `--glass-bg/.55`, `--glass-bg-strong/.72`, `--glass-line`, `--glass-blur/sm`, `--glass-shadow`. Cards, list, toolbar, tables, modals frost over the image.
- Admin/modal scrim lightened to `0.38` so the backdrop reads like the reference card.
- Identity/unknown result layers transparent + blur (terminal result floats on the image).
- **Bug fixed:** `prefers-reduced-transparency` fallback hid the image (`display:none`) on machines with transparency effects off. Removed — image always shows per owner. Proven via Playwright screenshots, not just code.

## Did not break
No DOM/ID changes · scan/enroll logic untouched · text stays ink-on-cards, white only on image.

## Verify
Fresh-Chromium screenshots (terminal exact image, Admin frosted) · served markers (title, `pane-backup`, spliced JS, no `__SSR_DATA__`) · diff = `ATL-Smart-Attendance-Production.html` only.

## Next
Borderless type (done) → bottom unification (done) → glass dropdowns (done) → photo redesign (done). Open: compress PNG (4.9MB) to JPG — awaiting permission.
