# Images

```
assets/images/
  admin/     logo.svg, planet.svg
  diagrams/  architecture.svg
  students/  student photos at runtime (gitignored except .gitkeep)
  ui/        reserved
```

On the Pi, student files are stored under `/var/lib/atl/images/` and served by the backend. Deploy copies `assets/` but never student photos from git.
