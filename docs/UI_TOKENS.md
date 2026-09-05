# UI Tokens — Canonical Frost Values (single source of truth)

These values are canonized as global CSS variables in `:root`
(`ATL-Smart-Attendance-Production.html`). Use the variables, never literals:

```css
--frost-bg:      rgba(242, 243, 246, 0.08);   /* surface fill */
--frost-blur:    blur(24px) saturate(1.2);    /* frost */
--frost-line:    rgba(242, 243, 246, 0.14);   /* 1px structural border */
--frost-radius:  2px;                         /* 3px allowed for large modals */
--frost-opt-pad: 8px 14px;                    /* option-row rhythm (Y: 8px) */
--frost-opt-min-h: 32px;                      /* option-row minimum height */
```

Reference usage (All Status dropdown): `background: var(--frost-bg);
backdrop-filter: var(--frost-blur); border: 1px solid var(--frost-line);
border-radius: var(--frost-radius); box-shadow: none;`

If the reference changes, update the `:root` variables first —
every wired surface follows automatically.

## Directional fade washes (locked pattern — search, weekly, month tiles)

Shape (all tiles, both poles — silver `242,243,246`, graphite `24,26,32`):

```css
background: linear-gradient(90deg, rgba(POLE, HEAD), rgba(POLE, TAIL) 80%);
```

| Tile | White head | White tail | Dark head | Dark tail |
|---|---|---|---|---|
| Weekly idle | 0.10 | 0 | 0.10 | 0 |
| Weekly hover | 0.12 | 0 | 0.14 | 0.02 |
| Weekly working | 0.12 | 0 | 0.16 | 0.02 |
| Weekly off | 0.06 | 0 | 0.06 | 0.02 |
| Month base | 0.06 | 0 | 0.06 | 0 |
| Month working | 0.10 | 0 | 0.10 | 0 |
| Month off / holiday / vacation | 0.04 | 0.02 | 0.04 | 0.02 |
| Month override | 0.12 | 0.02 | 0.12 | 0.02 |
| Month today | 0.14 | 0.02 (ring untouched) | 0.14 | 0.02 (ring untouched) |

Rules: per-tile (never one wash across a wrapping row); weekly tiles run
blur(12px) like the month tiles (24px smeared ambient color through
the tile and back-filled the dissolved tail); hover flips, never
melts (gradients don't transition — preferred under no-animation).

## Frosted surface (dropdowns, dialogs, enrollment modal card)

```css
background: rgba(242, 243, 246, 0.08);
backdrop-filter: blur(24px) saturate(1.2);
-webkit-backdrop-filter: blur(24px) saturate(1.2);
border: 1px solid rgba(242, 243, 246, 0.14);
border-radius: 2px;            /* small popovers; 3px allowed for large modals */
box-shadow: none;
```

## Veils (behind overlays — keep minimal, never dark-dialog territory)

```css
/* Dialog overlay: transparent color, blur only (reference floats undimmed) */
background: transparent;

/* Enrollment modal veil (needs text contrast over bright spots): */
background: rgba(26, 20, 16, 0.2);

/* Base .modal light veil rgba(252,251,247,0.38): DO NOT reintroduce — milk source */
```

## Primary contained action (one per surface max)

```css
background: rgba(242, 243, 246, 0.12);   /* hover: 0.18 */
border: 1px solid rgba(242, 243, 246, 0.3); /* hover: 0.5 */
border-radius: 3px;
box-shadow: none;
color: #FFFFFF; font-weight: 500;
```

## Text hierarchy (var(--sans) unless noted)

```css
primary:    #F2F3F6;                                   /* titles, values, 500 for important */
secondary:  rgba(242, 243, 246, 0.65–0.75); font-weight: 400;
tertiary:   rgba(242, 243, 246, 0.4–0.6);  font-weight: 400;
mono:       var(--mono) — dates, times, IDs, counts, technical data only.
```

## Hairlines (global line)

```css
--hairline: rgba(242, 243, 246, 0.12);   /* THE global line: 1px structural
                                           separators (toolbars, grids, sections) */
structural: 1px solid var(--hairline);
input underline: 1px solid rgba(242, 243, 246, 0.2);  /* #F2F3F6 on focus */
row separator: 1px solid rgba(242, 243, 246, 0.07–0.08);
```

## Laws

- No 600/700. No text shadows. No opaque white. No colored UI.
- Native `<select>` under custom dropdowns stays `opacity: 0` (invisible truth).
- Centered flex rows + dynamic text = shift bug; use absolute centering / fixed slots.
- Ink toggle (`INK: WHITE ⇄ BLACK` in admin top bar, `atl_ink` persisted):
  `html[data-ink="dark"]` flips text tiers only — primary `#181A20`,
  base `rgba(24,26,32,0.8)`, placeholders `rgba(24,26,32,0.5)`.
  Backgrounds/frost/blur/borders/layout frozen. Native `<option>` popups
  and kiosk layers excluded (keep white-on-dark).
