# bridge dispatch — daytime usage-budget rung

**Date:** 2026-09-07
**Status:** Design approved, not implemented
**Issue:** [#254](https://github.com/freaxnx01/bridge/issues/254)

## Problem

The agent-workflow pipeline authenticates with `CLAUDE_CODE_OAUTH_TOKEN`, minted
from the Max subscription. Autonomous pipeline runs and interactive HITL work
(spec writing, `/enrich`, triage) therefore draw on the **same 5-hour rolling
quota**.

Today this is masked by the schedule: `docs/systemd/bridge-dispatch.timer` fires
at 22:00 and hourly until 06:00, so unattended runs happen while nobody is
working. Extending dispatch into the workday — which #254 decided is wanted —
removes that accidental protection. An unattended run could then consume the
window the operator needs to write the next spec.

An API key for CI is explicitly **out of scope**: the metered cost is not
acceptable. The subscription stays the single credential.

The existing caps cannot express this. `global_open_prs` bounds review load,
`per_repo` bounds conflicting PRs, and `max_dispatches_per_night` bounds run
*count* — none of them measures quota consumption, and count is a poor proxy for
it (one large run can outweigh three small ones).

## Solution

Add a **usage-budget rung** to `bridge dispatch`, alongside the existing caps:

- **Night window (18:00–07:00):** rung disabled. Burning the window overnight is
  fine; the existing caps remain the only bound.
- **Day window (07:00–18:00):** dispatch is refused once *combined* trailing-5h
  consumption — interactive sessions **plus** pipeline runs — reaches **80%** of
  the window budget. The last 20% is reserved for the operator. The cap is on
  the total, not on the pipeline's share: if the operator has already burned
  70%, the pipeline gets 10%, not 80%.

Because there is no readable "% of window consumed" anywhere (see *Prior
research*), 80% is a **calibrated proxy**: trailing-5h USD-equivalent summed
against a `window_budget_usd` constant pinned empirically.

## Prior research (already settled on the issue — do not re-derive)

- **There is no `/usage` equivalent for the pipeline.** `/usage` is
  interactive-TUI only; the pipeline runs headless via
  `anthropics/claude-code-base-action`. A run reports its *consumption*
  (`total_cost_usd`, `num_turns`, `usage.*_tokens`) but never its *headroom*.
  The only limit signal today is hitting the wall — `classify-failure.sh`
  regex-matching `rate.?limit|429|quota.?exceed`.
- **Subscription limits are account-scoped**, so a local `/usage` reading
  already includes Action-run consumption. That makes local `/usage` the ground
  truth for calibration.
- **Daytime dispatch is decided and in scope**, with a hard sequencing
  constraint: the guard ships first (or with), the timer last.

## Findings from the codebase

Established while designing; they shape the solution.

- **`Schedule` config is dead code.** `internal/dispatch/types.go:15-18` declares
  `dispatch_at` / `retry_until` and `config.go:17` defaults them, but nothing
  reads either field. The systemd timer is the only real schedule, so the config
  block is a second, *lying* source of truth already in the tree.
- **No `size:*` labels exist** in the repo. The issue's sketch of a projective
  estimate as a "rolling mean by `size:*` label" has no input to key on.
- **Interactive transcripts carry tokens but no cost.** Rows in
  `~/.claude/projects/**/*.jsonl` have `timestamp`, `message.model`, and a full
  `message.usage` breakdown (`input_tokens`, `output_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens`) — no USD field.
  Pricing is therefore bridge's job.
- **Cache terms dominate.** A sampled turn showed 446,362 cache-read against
  13,535 input tokens. A flat per-token rate would be wrong by an order of
  magnitude; the four terms must be priced separately.
- **Scanning is cheap.** 132 transcripts / 79 MB total, but only 9 files / 28 MB
  were modified within a 5h window. An mtime prefilter is sound: a file not
  written in the last 5h cannot contain a row inside the window.
- **Pipeline runs do report real cost under subscription auth.** The run-report
  comment on issue #151 shows `**Cost:** $1.62` with a full token table — so a
  per-run figure of that magnitude is a realistic seed for the calibrated mean.

## Design decisions

Each was chosen against the alternatives listed; the rejected options are
recorded so they are not re-litigated.

### D1 — Pipeline usage: self-accounting with a calibrated per-run cost

**bridge is the only thing that dispatches**, so it already knows which runs
exist and when they started. It records each dispatch in a local ledger and
prices it with a calibrated `mean_run_cost_usd` constant.

*Rejected:* parsing run-report comments (authoritative, but the dispatch tick
fetches issues and PRs, not comments — finding them is a per-issue API fan-out
every tick, and it regexes markdown written for humans); a machine-readable
ledger emitted by agent-workflow (most robust, but needs a cross-repo PR and
still needs a discovery path); Actions API + rolling mean (an API call per repo
per tick and still no real cost).

*Known blind spot:* runs started by hand-labelling `ai-implement`, and pipeline
retries, are not counted. Accepted — the operator doing that is present and
aware.

### D2 — Interactive pricing: built-in rate table, config-overridable

A four-term formula (`input`, `output`, `cache_read`, `cache_write`) with
per-model USD/Mtok rates compiled in as defaults and overridable per model in
`dispatch.json`, so a new model needs no rebuild. An unknown model falls back to
the **most expensive known rate** — conservative, consistent with fail-closed.

*Rejected:* config-only table (a fresh install has no pricing, which under
fail-closed blocks all daytime dispatch until a table is hand-written); a single
blended $/Mtok constant (cannot tell Opus from Haiku, and over-prices cache reads
roughly tenfold — which is most of the volume); weighted token units with no USD
(needs the same weight table and can no longer share units with the pipeline's
dollar-denominated per-run cost).

### D3 — Config owns the schedule; the timer becomes a heartbeat

The `.timer` loses its hour list and becomes a plain hourly `OnCalendar`. bridge
checks the current time against configured windows and exits **before any
network fetch** when outside them. Drift between the timer's hours and the
rung's window becomes structurally impossible, because the hours exist in
exactly one place. This also gives the dead `Schedule` config a real reader
instead of leaving a lying second source of truth.

*Rejected:* mirroring hours in both files (exactly the drift #254 warns about);
generating the timer from config (single source, but adds a codegen path and a
re-run step to forget).

*Cost accepted:* ~13 extra no-op wakeups per day, each exiting immediately with
no API calls.

### D4 — The budget rung is daytime's only new bound

`max_dispatches_per_night` keeps applying to the night window only. Daytime is
bounded by the rung plus the existing `global_open_prs` and `per_repo` caps. The
rung already bounds exactly what daytime dispatch threatens — the 5h window —
and a count cap is a worse proxy for that than dollars.

*Rejected:* per-window `max_dispatches` (tidier now that windows exist in
config, and it would retire the odd noon-pivot in `nightOf()`, but it is a real
refactor of persisted state semantics needing a migration for
`dispatched_tonight`); a parallel `max_dispatches_per_day` (leaves two
near-identical counters and two window-attribution helpers doing one job).

A counter can be added later if the rung alone proves too loose.

### D5 — The projective estimate is the same constant

With no `size:*` labels (see *Findings*), the candidate run's projected cost is
`mean_run_cost_usd` — the same constant D1 uses for the ledger. No second
estimator.

## Architecture

Three units, each independently testable.

### `internal/usage` (new package)

Measurement only; it knows nothing about dispatch.

- `Pricing` — per-model rates, four terms, with `CostOf(model string, t Tokens) float64`.
- `Turn{At time.Time, Model string, Tokens Tokens}` — one priced-able interactive turn.
- `ScanTranscripts(root string, since time.Time) ([]Turn, error)` — the **only**
  I/O in the package. Mtime-prefilters the transcript files, then filters by each
  row's own `timestamp`. Malformed lines are skipped, not fatal: a corrupt line
  in one transcript must not blind the whole rung.
- `Ledger{Runs []Run{At, Repo, Issue, EstUSD}}` with `Load`, `Append`, and
  `SumSince`. Persisted through the existing `store.AtomicWrite`, matching
  `internal/dispatch/state.go`.
- `SumWindow(turns []Turn, p Pricing, from, to time.Time) float64` — pure.

The pure/impure split is deliberate and mirrors the existing package doc on
`internal/dispatch`: the arithmetic is table-testable with no clock and no
filesystem.

### `internal/dispatch` (changed)

- `Schedule` is **replaced**: `dispatch_at` / `retry_until` are removed,
  `Windows []Window{From, To string; BudgetRung bool}` takes their place.
- `InWindow(now time.Time) (Window, bool)` — pure; handles the wrap past
  midnight (`18:00`→`07:00`). `From` inclusive, `To` exclusive.
- `Budget` config: `window_hours`, `window_budget_usd`, `daytime_cap`,
  `mean_run_cost_usd`, `pricing`.
- `BudgetState{Enabled bool; UsedUSD, LimitUSD, PerRunUSD float64; Unknown bool}`
  — the tick's already-measured budget position, passed in rather than measured
  here, so `ApplyCaps` stays a pure function.
- `ApplyCaps` gains the rung as its **first** check, ahead of night, global and
  per-repo: it is the bound that protects the operator rather than the machine.

`ApplyCaps` currently takes five positional parameters; adding `BudgetState`
would make six. The three loose counters are therefore grouped:

```go
type Counts struct {
    OpenPRsByRepo     map[string]int
    GlobalOpen        int
    DispatchedTonight int
}

func ApplyCaps(ordered []Candidate, cfg Config, counts Counts, budget BudgetState) []Decision
```

Within a single tick the projection **accumulates**: each dispatched candidate
adds `PerRunUSD` to the running total, so a tick cannot slip three runs through
on one candidate's headroom.

Skip reasons, surfaced by `--dry-run` and `--json`:

- `budget-exhausted 9.8/9.6 USD`
- `budget-unknown`

### `cmd/bridge/dispatch.go` (wiring)

1. Load config and state.
2. Resolve the current window. **No match → return before `fetchRepoInputs`**, so
   an out-of-window heartbeat costs zero API calls.
3. The window gate applies to `--auto` only. An explicit `dispatch now` is the
   operator asking for it — the same rationale that already exempts `now` from
   the pause flag.
4. If the window has `budget_rung`, measure: `usage.ScanTranscripts` priced by
   the table, plus `Ledger.SumSince`, both over `now - window_hours`. Any error
   sets `Unknown`.
5. `ApplyCaps` with the resulting `BudgetState`.
6. `applyDecisions` appends one ledger entry per dispatched issue, with
   `EstUSD = mean_run_cost_usd`.

**Fail closed.** When the rung is active and usage is unreadable, every candidate
is skipped as `budget-unknown`. The rung exists to protect headroom, so unknown
usage must never mean "go".

`dispatch status` prints trailing-window usage, the limit, and utilization
percent, in both text and `--json`. This is what makes week-one calibration
possible without extra tooling. It stays network-free — both sources are local,
preserving the existing property that `status` does no repo fetch.

## Terminology

Two different things are called a "window"; the spec keeps them distinct.

- **Quota window** — the trailing 5h subscription period being measured.
  Configured as `budget.window_hours`, and always a rolling lookback from *now*.
- **Schedule window** — a configured span of the day (`18:00`–`07:00`) during
  which dispatch ticks act, carrying a `budget_rung` flag.

`daytime_cap` keeps the name used in #254, but its meaning is precisely "the
fraction of the quota-window budget the pipeline may consume **in any schedule
window whose `budget_rung` is true**". It is not keyed on the clock; it is keyed
on the flag. Renaming it is deliberately avoided so the config key matches the
issue that specified it.

## Configuration

```json
{
  "schedule": {
    "windows": [
      {"from": "18:00", "to": "07:00", "budget_rung": false},
      {"from": "07:00", "to": "18:00", "budget_rung": true}
    ]
  },
  "budget": {
    "window_hours": 5,
    "window_budget_usd": 12.0,
    "daytime_cap": 0.80,
    "mean_run_cost_usd": 2.0,
    "pricing": {
      "claude-opus-4-7": {
        "input": 15.0, "output": 75.0,
        "cache_read": 1.5, "cache_write": 18.75
      }
    }
  }
}
```

Rates are USD per million tokens. `pricing` overrides the built-in table per
model; omitted models keep their compiled-in defaults.

**Backwards compatibility.** An existing `dispatch.json` carrying the retired
`dispatch_at` / `retry_until` keys keeps working: `encoding/json` ignores unknown
fields, and `windows` falls back to the defaults above. This is the established
`LoadConfig` behaviour — unmarshalling over an already-populated struct is what
keeps unset keys at their defaults.

## Sequencing constraint

From #254, and binding:

> The schedule extension must ship *with* the budget rung, never ahead of it.

Ordering:

1. `internal/usage` and the `internal/dispatch` rung.
2. Wiring, `status` reporting, and the config defaults.
3. **`docs/systemd/bridge-dispatch.timer` last**, becoming a bare hourly
   `OnCalendar` with an updated `Description=`.

Until the operator reinstalls that timer, the daytime windows never fire, so
there is no interval in which a daytime dispatch runs unguarded — the invariant
holds even if the work is split across PRs.

## Testing

Per the Go stack overlay: table-driven `t.Run` subtests, hand-rolled fakes, no
testify/mockery, isolation via `t.TempDir()`.

**`internal/usage`**

- Pricing math across all four terms; unknown model falls back to the most
  expensive known rate.
- Window filtering: rows before, inside, and after the window.
- Malformed JSONL lines and rows missing a `timestamp` are skipped without
  failing the scan.
- Mtime prefilter: a file older than the window is not opened; a recently
  written file containing only old rows contributes nothing.
- Ledger round-trip and `SumSince` boundary behaviour.

**`internal/dispatch`**

- `InWindow` table: midnight wrap, a daytime instant, and both boundaries
  (`from` inclusive, `to` exclusive).
- Budget rung under-cap, at-cap, and over-cap.
- Rung disabled in the night window regardless of usage.
- `Unknown` blocks every candidate with `budget-unknown`.
- Cumulative within-tick projection: with headroom for one run, the second and
  third candidates are refused.
- Existing `ApplyCaps` tests migrated to the `Counts` struct, with the night /
  global / per-repo behaviour otherwise unchanged.

**`cmd/bridge`**

- Out-of-window `--auto` returns before any fetch; `dispatch now` is not gated.
- `status` renders usage, limit, and utilization in text and `--json`.
- `--json` decision output carries the `budget-exhausted` skip reason.

Gates: `gofmt -l .` empty, `go vet ./...`, `golangci-lint run`,
`go test -race ./...`, `govulncheck ./...`.

## Known approximations

Documented rather than hidden; all three are inherent to a proxy measurement.

- **The rolling 5h window is not aligned to the actual subscription reset.** It
  is a moving proxy for a fixed-boundary quota, so it can be conservative near a
  real reset.
- **A run's cost is booked at dispatch time**, though the run burns quota over
  the following minutes. This errs toward blocking, which is the safe direction.
- **`window_budget_usd` and `mean_run_cost_usd` are empirical constants.** Week
  one is calibration: read `dispatch status` against `/usage` at intervals and
  pin both.

## Out of scope

- An API key for CI (explicitly rejected on cost grounds).
- Counting hand-labelled `ai-implement` runs or pipeline retries (D1's accepted
  blind spot).
- Auto-throttling or queueing of blocked work — the rung blocks and surfaces;
  the operator decides.
- Any WebUI surface for budget state. Related but separate: #179 / #242.
- A daytime dispatch counter (D4 — revisit only if the rung proves too loose).

## Documentation

- `docs/dispatch.md` — the new rung, the config block, the window model, and the
  calibration procedure.
- `docs/systemd/bridge-dispatch.timer` — hourly heartbeat, updated description.
- `CHANGELOG.md` — under `[Unreleased] / Added`.
