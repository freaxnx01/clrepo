# AGENT-NOTES.md

Project-specific, agent-facing context for `bridge` that doesn't fit the
regenerated `CLAUDE.md`: operational gotchas, project-specific commands, and
repo-local workflow conventions. Read alongside `CLAUDE.md`.

## Essential commands (bridge-specific)

Use **`just`** as the entry point (run `just --list` to see all recipes). These
override the generic Go commands in `CLAUDE.md`'s stack section:

```bash
# Build + install locally: pulls latest, rebuilds, installs binary + shim,
# prints version. Run this to pick up a merged change in ~/.local/bin/bridge.
just build

# Full Go + shim test pass
just test

# Go tests with per-test streaming output (no shim tests)
just test-verbose

# Fast unit tests only — skips cmd/bridge (execs a built binary per test,
# ~150s) and e2e/. Use during the edit loop; `just test` before pushing.
just test-fast

# Run a single test (raw go; no just recipe for this)
go test ./cmd/bridge -run TestXxx

# Install the Go toolchain pinned in go.mod (into ~/.local/go)
just install-go-toolchain

# Print installed version
bridge --version
```

The `just` recipes wrap the Makefile (`just build` → `make install`,
`just test` → `make all`); invoke `just`, not `make`, directly.

Cross-compile for Windows:

```bash
GOOS=windows GOARCH=amd64 go build ./cmd/bridge
```

## Cross-shell parity (bash + PowerShell) — hard requirement

bridge must work end-to-end under both **bash** (Linux/macOS) and
**PowerShell** (Windows). Treat parity as a hard requirement, not a
nice-to-have.

- Two shims ship side-by-side: `shims/bridge-shim.sh` and
  `shims/bridge-shim.ps1`. Any change to the `__preflight` directive
  protocol must update both — and add a test in `shims/bridge-shim.bats`
  (bash) plus an equivalent for the `.ps1` shim.
- Tab-completion goes through Cobra's `ValidArgsFunction`; one
  registration emits scripts for both shells via `bridge completion bash`
  and `bridge completion powershell`. Don't write shell-specific
  completion logic in the shim.
- Launcher paths differ — tmux on Unix, Windows Terminal (`wt.exe`) on
  Windows — but both go through `internal/launcher` argv construction;
  don't fork that.
- If a feature genuinely can't be parity (e.g. relies on tmux), say so
  explicitly in the PR description and degrade gracefully on the other
  platform rather than crashing.
- There is no Windows CI yet (see README), so the PowerShell path must
  be exercised manually for every change touching the shim, launcher,
  completion, or filesystem semantics. The PR template enforces this.

## Working across sessions

Multiple agent/dev sessions often run against this repo at once. To avoid
divergent state, duplicate work, and lost branches:

- **Orient before starting:** `git fetch --prune`, branch off a fresh
  `main` (`git switch main && git pull`), then check `git branch -a`,
  `gh pr list`, `gh issue list`, and `CHANGELOG.md` so you don't redo work
  another session already shipped.
- **Isolate concurrent work:** one git worktree per session — use
  `bridge -w <name>`, which opens the `<name>` worktree (resolved via
  `git worktree list`, created under `<repo>/.worktrees/<name>` if absent) so
  sessions don't share a working tree. If you can't isolate, serialize:
  commit/stash before another session touches the same files.
- **Push the moment you commit:** `git push -u origin <branch>`. An unpushed
  branch is invisible to other sessions and easily lost.
- **One branch per unit of work**, conventional-commit named (`feat/…`,
  `fix/…`, `docs/…`); small commits keep intent legible across sessions.
- **Leave no residue on merge:** `gh pr merge <n> --squash --delete-branch`,
  then `git pull` in other sessions. Rebase stale branches onto
  `origin/main` before continuing them.
- **Reconcile periodically:** after a release lands, close issues that
  shipped and prune merged branches (`git fetch --prune`,
  `git branch --merged`).

> **Worktree convention — specializes the base rule.** `CLAUDE.md`'s base
> "Git Worktrees" section says to use a *random* `wt/<8-hex>` branch under
> `.worktrees/`. In this repo, prefer `bridge -w <name>`, which creates a
> **named** `worktree-<name>` branch (under `<repo>/.worktrees/<name>` when
> absent). Use the named-worktree convention here rather than the generic
> random-name rule.
