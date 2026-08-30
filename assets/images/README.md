# Assets / Images

All images live here, separated by purpose — not flat.

```
assets/images/
  admin/     # editable via Code + UI Admin > Images (hero, logo, planet, banners)
  students/  # uploaded student avatars (via Enrollment or Admin upload) — gitignored except .gitkeep
  ui/        # icons, placeholders, fallback avatars
  diagrams/  # wiring, architecture, workflow diagrams
```

**Via UI (live):** Settings → Branding. Upload hits `POST /api/images/upload`; gallery and logo assignments persist in SQLite via `POST /api/settings` / `PATCH /api/students/:id`. Production UI is `ATL-Smart-Attendance-Production.html`.

**Via Code (permanent):** Drop files directly into the subfolders above and reference by path in `DEFAULT_ADMIN_IMAGES` or `state.settings`. Example: `assets/images/admin/planet.png`.

**Pi runtime:** Files are deployed to `/var/lib/atl/images/` via `tools/deploy.ps1` / `tools/deploy.sh` and served statically by backend.
