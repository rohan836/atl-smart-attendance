# VERSIONS — Production baseline

## Production baselines

- **v1.2.0 (Production release):** `bf57545191291869c9ae7acd267f6cf221bd8738` (`bf575451`) — Production release tag `v1.2.0`. Unified Backup Manager UI (`#backupManagerCard`) + Telegram secondary cloud backup (official Telegram Bot API `sendDocument`, protected botToken/chatId) + USB local storage backup (auto-detection, `/media/usb` partition mount, FAT32/VFAT filesystem resilience, verified snapshot copy to `ATL-Attendance-Backups/`) + synchronized multi-destination scheduling (`gdriveSchedule`, `telegramSchedule`, `usbSchedule`) + decoupled isolated staging directories. Verified on physical Raspberry Pi 3 (`lancer@192.168.1.8`). Tests: `116/116` backend API tests + `12/12` Playwright E2E browser tests passing (`128/128` total).
- **v1.1.0:** `da89bdf44df69a4dd41e947f72f8b5fc9a62fce4` (`da89bdf`) — Tag `v1.1.0` (annotated: "Release v1.1.0 - Google Drive cloud backup via Device Flow, automated reconciliation, versatile backup scheduling, and Playwright E2E suite"). Google Drive cloud backup via Device Flow (RFC 8628, `drive.file` scope, resumable chunked upload, GFS retention) + automated daily attendance reconciliation background worker (`_reconcile_daemon`) + versatile Google Drive backup scheduling in Admin Backup UI + Playwright automated browser E2E test suite (`backend/test_ui_e2e.py`). Verified on physical Raspberry Pi 3 (`lancer@192.168.1.8`) + real GT-511C3 hardware + live Google Drive API. Tests: `99/99` backend API tests + `7/7` Playwright E2E browser tests passing (`106/106` total). Historical release tag.
- **v1.0.1:** `32e5ef79b2c13275122dab31652a76605fc481e7` (`32e5ef7`) — Production release tag `v1.0.1`. Pi setup resilience, deployment fail-fast error checking, and verified live hardware scan/duplicate matching. Tests: `79/79` passing.
- **v1.0.0:** `c0fe411fe9fccd82ba4f0a004f64961d4247e054` (`c0fe411`) — Tag `v1.0.0` (annotated: "First verified production release"). Verified on real Raspberry Pi 3 + GT-511C3 UART 9600. Tests: `38/38` passing. Immutable historical release tag.

## Rule — never modify historical tags

Never modify or rewrite a historical production tag. Tags are immutable checkpoints. If a fix or feature is needed, create a new commit on `main` and a new tag — do not force-move `v1.0.0`, `v1.0.1`, `v1.1.0`, or `v1.2.0`.

## Where to start new work

For new work, start from current `main`. Unless a task explicitly requires another historical version, `main` is the baseline.

If an agent needs the historical `v1.0.0` release tag:

```bash
git checkout v1.0.0        # detached HEAD at v1.0.0 release
# or
git checkout -b fix/xyz v1.0.0
```

## main vs commit vs tag

- **main** — movable branch pointer to the latest intended production/committed work. Moves forward with every `git commit` + `push`.
- **commit** — immutable snapshot identified by SHA (`bf575451...`, `da89bdf...`, `32e5ef7...`, `c0fe411...`). Every change creates a new commit.
- **tag** — human name pinned to one commit (`v1.2.0 → bf575451`, `v1.1.0 → da89bdf`, `v1.0.1 → 32e5ef7`, `v1.0.0 → c0fe411`). Annotated tags store author, date, and message and are pushed explicitly (`git push origin v1.2.0`). A tag never moves unless forcibly overwritten — which is forbidden for production tags.

In short: `main` is where you work, `commit` is what you built, `tag` is the released name for a commit you verified.

## Future releases — semantic versioning

Use semantic versioning for future tags:

- `v1.3.0` — new feature, backwards compatible (e.g., new report filter, new Admin field)
- `v1.2.1` — bug or maintenance fix, no new features
- `v2.0.0` — breaking change (e.g., new API contract, new hardware wiring, new DB schema that is not backwards compatible)

Example:

```bash
# after verifying on Pi and tests pass
git tag -a v1.2.1 -m "Maintenance fix description"
git push origin v1.2.1
# update this file to point Current production to v1.2.1
```

Historical tags remain reachable via `git tag --list` and `git show <tag>`.
