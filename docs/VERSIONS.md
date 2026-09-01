# VERSIONS — Production baseline

## Production baselines

- **Current main:** `7a5d73b` — Automated daily attendance reconciliation background worker (`_reconcile_daemon`) in `app.py`. Verified on physical Raspberry Pi 3 (`lancer@192.168.1.8`) + real GT-511C3 hardware. Tests: `85/85` passing (`python -m unittest backend.test_app -v`). (Note: Task 8 is on `main` and not yet tagged as a separate release).
- **v1.0.1:** `32e5ef79b2c13275122dab31652a76605fc481e7` (`32e5ef7`) — Production release tag `v1.0.1`. Pi setup resilience, deployment fail-fast error checking, and verified live hardware scan/duplicate matching. Tests: `79/79` passing.
- **v1.0.0:** `c0fe411fe9fccd82ba4f0a004f64961d4247e054` (`c0fe411`) — Tag `v1.0.0` (annotated: "First verified production release"). Verified on real Raspberry Pi 3 + GT-511C3 UART 9600. Tests: `38/38` passing. Immutable historical release tag.

## Rule — never modify historical tags

Never modify or rewrite a historical production tag. Tags are immutable checkpoints. If a fix or feature is needed, create a new commit on `main` and a new tag — do not force-move `v1.0.0` or `v1.0.1`.

## Where to start new work

For new work, start from current `main` (`7a5d73b`). Unless a task explicitly requires another historical version, `main` is the baseline.

If an agent needs the historical `v1.0.0` release tag:

```bash
git checkout v1.0.0        # detached HEAD at v1.0.0 release
# or
git checkout -b fix/xyz v1.0.0
```

## main vs commit vs tag

- **main** — movable branch pointer to the latest intended production/committed work (`7a5d73b`). Moves forward with every `git commit` + `push`.
- **commit** — immutable snapshot identified by SHA (`7a5d73b...`, `32e5ef7...`, `c0fe411...`). Every change creates a new commit.
- **tag** — human name pinned to one commit (`v1.0.1 → 32e5ef7`, `v1.0.0 → c0fe411`). Annotated tags store author, date, and message and are pushed explicitly (`git push origin v1.0.1`). A tag never moves unless forcibly overwritten — which is forbidden for production tags.

In short: `main` is where you work, `commit` is what you built, `tag` is the released name for a commit you verified.

## Future releases — semantic versioning

Use semantic versioning for future tags:

- `v1.1.0` — new feature, backwards compatible (e.g., new report filter, new Admin field)
- `v1.0.2` — bug or maintenance fix, no new features
- `v2.0.0` — breaking change (e.g., new API contract, new hardware wiring, new DB schema that is not backwards compatible)

Example:

```bash
# after verifying on Pi and 85+ tests pass
git tag -a v1.1.0 -m "Add batch import + calendar export"
git push origin v1.1.0
# update this file to point Current production to v1.1.0
```

Historical tags remain reachable via `git tag --list` and `git show <tag>`.
