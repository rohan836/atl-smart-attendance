# Enrollment Photo Redesign — DONE

Owner: OS `Choose File` box + blue focus wash clashed with the vibe. Redesign, keep every admin need.

## Built
- Shared `enhancePhotoField()` in `ui_app.js`: photo row → 52px thumb tile (`Photo` → live preview), name/size meta, borderless `CHOOSE` + red `REMOVE`, drag-and-drop supported.
- Same enhancer on enroll (`nsPhoto`) and edit (`edPhoto`); edit `REMOVE` delegates to existing Clear-photo (delete-mark semantics kept); edit row widened full-width.
- Modal inputs/textarea → transparent + bottom hairline (+ink on focus); autofill wash killed; form glass-triggers underlined to match.
- Preserved exactly: all field IDs, required-validation copy, 2MB `Photo max 2MB.` gate, FileReader dataURL flow, 3-lift fingerprint path, edit preview block.

## Did not break
Handlers/logic untouched (additive listeners only) · scan untouched · no new folders.

## Verify
Screenshots: empty / chosen-preview / oversize-error / edit row · `test_05` passes unmodified · keyboard operable · probe student removed from dev DB.

## Next
Done. Nothing pending on this form.
