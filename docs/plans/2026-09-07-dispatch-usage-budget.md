# Dispatch Usage-Budget Rung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refuse daytime `bridge dispatch` runs once combined interactive + pipeline consumption reaches 80% of the trailing 5h subscription window, so unattended agent work cannot eat the operator's quota.

**Architecture:** A new pure-function `internal/usage` package measures consumption from two local sources — Claude Code transcripts (priced by a per-model rate table) and a self-accounted ledger of runs bridge dispatched. `internal/dispatch` gains a `Schedule.Windows` model that replaces its dead `dispatch_at`/`retry_until` fields, plus a budget rung that runs ahead of the night/global/per-repo caps in `ApplyCaps`. The systemd timer becomes a dumb hourly heartbeat so the configured windows are the only schedule truth.

**Tech Stack:** Go (stdlib only — `encoding/json`, `bufio`, `io/fs`, `time`), Cobra for the CLI layer, stdlib `testing` with table-driven subtests and hand-rolled fakes.

**Spec:** [`docs/specs/2026-09-07-dispatch-usage-budget-design.md`](../specs/2026-09-07-dispatch-usage-budget-design.md)

## Global Constraints

- **No new Go modules.** Everything here is stdlib plus existing internal packages. Do not add a dependency.
- **No testify / mockery / gomock.** Table-driven `t.Run` subtests with hand-rolled fakes only.
- **Isolation:** `t.TempDir()` and `t.Setenv()`; never touch the real `~/.claude` or `~/.cache/bridge` in a test.
- **No package-level mutable global state**, no dependency-wiring `init()`.
- **`context.Context` is the first parameter** of any function that does I/O.
- **Errors wrap with `%w`**, lower-case message, no trailing punctuation. Never `_ =` an error away.
- **No `os.Exit` or stderr printing below the `main`/command layer** — return errors.
- **Fail closed:** whenever the rung is active and usage cannot be measured, dispatch is refused. Unknown usage must never be treated as "zero used".
- **Gates after every task:** `gofmt -l .` (empty), `go vet ./...`, `golangci-lint run`, `go test -race ./...`.
- **Conventional Commits** for every commit.
- **Sequencing (binding, from #254):** the timer file is the **last** thing changed — Task 8. No task before it may extend the systemd schedule into the workday.

---

### Task 1: Token pricing table

**Files:**
- Create: `internal/usage/pricing.go`
- Test: `internal/usage/pricing_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `usage.Tokens{Input, Output, CacheRead, CacheWrite int}`; `usage.Rate{Input, Output, CacheRead, CacheWrite float64}` (USD per million tokens, JSON tags `input`/`output`/`cache_read`/`cache_write`); `usage.Pricing map[string]Rate`; `usage.DefaultPricing() Pricing`; `(Pricing).Merge(override map[string]Rate) Pricing`; `(Pricing).RateFor(model string) Rate`; `(Pricing).CostOf(model string, t Tokens) float64`.

- [ ] **Step 1: Write the failing test**

Create `internal/usage/pricing_test.go`:

```go
package usage

import "testing"

func TestCostOfPricesAllFourTerms(t *testing.T) {
	p := Pricing{"opus": {Input: 15, Output: 75, CacheRead: 1.5, CacheWrite: 18.75}}
	// 1M of each term: 15 + 75 + 1.5 + 18.75
	got := p.CostOf("opus", Tokens{Input: 1e6, Output: 1e6, CacheRead: 1e6, CacheWrite: 1e6})
	if diff := got - 110.25; diff > 0.0001 || diff < -0.0001 {
		t.Errorf("want 110.25, got %v", got)
	}
}

func TestRateForMatchesExactThenFamily(t *testing.T) {
	p := DefaultPricing()
	p["claude-opus-4-7"] = Rate{Input: 99}

	if got := p.RateFor("claude-opus-4-7").Input; got != 99 {
		t.Errorf("exact match must win, got %v", got)
	}
	// No exact entry: the family substring decides.
	if got := p.RateFor("claude-sonnet-5").Input; got != DefaultPricing()["sonnet"].Input {
		t.Errorf("family match: %v", got)
	}
}

func TestRateForUnknownModelFallsBackToMostExpensive(t *testing.T) {
	p := DefaultPricing()
	want := p["opus"]
	if got := p.RateFor("some-future-model"); got != want {
		t.Errorf("unknown model must price at the most expensive known rate, got %+v", got)
	}
}

func TestMergeOverridesOnlyNamedModels(t *testing.T) {
	p := DefaultPricing().Merge(map[string]Rate{"opus": {Input: 1, Output: 2, CacheRead: 3, CacheWrite: 4}})

	if p["opus"].Input != 1 {
		t.Errorf("override not applied: %+v", p["opus"])
	}
	if p["haiku"] != DefaultPricing()["haiku"] {
		t.Errorf("unnamed model must keep its default: %+v", p["haiku"])
	}
}

func TestMergeDoesNotMutateReceiver(t *testing.T) {
	base := DefaultPricing()
	base.Merge(map[string]Rate{"opus": {Input: 1}})
	if base["opus"].Input == 1 {
		t.Error("Merge must not mutate the receiver")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/usage/ -run TestCostOf -v`
Expected: FAIL — the package does not exist yet (`no Go files in .../internal/usage`).

- [ ] **Step 3: Write minimal implementation**

Create `internal/usage/pricing.go`:

```go
// Package usage measures Claude subscription consumption over a trailing
// window. It has two sources: Claude Code's local transcripts (interactive
// work) and a ledger of pipeline runs bridge dispatched itself.
//
// Everything here except ScanTranscripts, LoadLedger and WriteLedger is a pure
// function over plain structs — no network, no clock, no filesystem — which is
// what makes the arithmetic table-testable.
package usage

import (
	"sort"
	"strings"
)

// Tokens is one turn's token breakdown, mirroring the shape Claude Code writes
// into message.usage.
type Tokens struct {
	Input      int
	Output     int
	CacheRead  int
	CacheWrite int
}

// Rate is a model's price in USD per million tokens, one term per token class.
// Cache reads and cache writes are priced separately on purpose: a typical turn
// reads far more cached tokens than fresh input, so folding them into a single
// per-token rate is wrong by an order of magnitude.
type Rate struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cache_read"`
	CacheWrite float64 `json:"cache_write"`
}

// Pricing maps a model key to its Rate. A key is either a full model id
// ("claude-opus-4-7") or a family name ("opus") matched as a substring, so a
// newly released dated model id prices correctly without a config edit.
type Pricing map[string]Rate

// DefaultPricing is the compiled-in table. Families only: exact model ids are
// left to config overrides, so this table does not go stale on every release.
func DefaultPricing() Pricing {
	return Pricing{
		"opus":   {Input: 15, Output: 75, CacheRead: 1.5, CacheWrite: 18.75},
		"sonnet": {Input: 3, Output: 15, CacheRead: 0.3, CacheWrite: 3.75},
		"haiku":  {Input: 1, Output: 5, CacheRead: 0.1, CacheWrite: 1.25},
	}
}

// Merge returns a copy of p with override's entries applied. The receiver is
// left untouched so a caller can keep the defaults around.
func (p Pricing) Merge(override map[string]Rate) Pricing {
	out := make(Pricing, len(p)+len(override))
	for k, v := range p {
		out[k] = v
	}
	for k, v := range override {
		out[k] = v
	}
	return out
}

// RateFor resolves a model id to a rate: exact key, then family substring, then
// the most expensive known rate. The last step is deliberate — an unrecognised
// model must over-estimate rather than under-estimate, so it tightens the
// budget rung instead of quietly opening it.
func (p Pricing) RateFor(model string) Rate {
	if r, ok := p[model]; ok {
		return r
	}
	for _, k := range sortedKeys(p) {
		if k != "" && strings.Contains(model, k) {
			return p[k]
		}
	}
	return mostExpensive(p)
}

// CostOf prices one turn in USD. Rates are per million tokens.
func (p Pricing) CostOf(model string, t Tokens) float64 {
	r := p.RateFor(model)
	return (float64(t.Input)*r.Input +
		float64(t.Output)*r.Output +
		float64(t.CacheRead)*r.CacheRead +
		float64(t.CacheWrite)*r.CacheWrite) / 1e6
}

// sortedKeys keeps family matching and the most-expensive fallback
// deterministic: Go map iteration order is randomised.
func sortedKeys(p Pricing) []string {
	ks := make([]string, 0, len(p))
	for k := range p {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

func mostExpensive(p Pricing) Rate {
	var best Rate
	for _, k := range sortedKeys(p) {
		r := p[k]
		if r.Output > best.Output {
			best = r
		}
	}
	return best
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/usage/ -v`
Expected: PASS — all five tests.

- [ ] **Step 5: Commit**

```bash
git add internal/usage/pricing.go internal/usage/pricing_test.go
git commit -m "feat(usage): price token usage with a per-model rate table"
```

---

### Task 2: Transcript scanning

**Files:**
- Create: `internal/usage/transcript.go`
- Test: `internal/usage/transcript_test.go`

**Interfaces:**
- Consumes: `usage.Tokens`, `usage.Pricing` (Task 1).
- Produces: `usage.Turn{At time.Time, Model string, Tokens Tokens}`; `usage.ScanTranscripts(ctx context.Context, root string, since time.Time) ([]Turn, error)`; `usage.SumWindow(turns []Turn, p Pricing, from, to time.Time) float64`.

- [ ] **Step 1: Write the failing test**

Create `internal/usage/transcript_test.go`:

```go
package usage

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// writeTranscript creates a .jsonl fixture and back-dates its mtime, so the
// mtime prefilter can be exercised without sleeping.
func writeTranscript(t *testing.T, dir, name, body string, mtime time.Time) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatal(err)
	}
	return path
}

func row(ts, model string, in, out, cr, cw int) string {
	return `{"type":"assistant","timestamp":"` + ts + `","message":{"model":"` + model +
		`","usage":{"input_tokens":` + strconv.Itoa(in) + `,"output_tokens":` + strconv.Itoa(out) +
		`,"cache_read_input_tokens":` + strconv.Itoa(cr) +
		`,"cache_creation_input_tokens":` + strconv.Itoa(cw) + `}}}`
}

func TestScanTranscriptsReadsPricedTurns(t *testing.T) {
	root := t.TempDir()
	now := time.Now().UTC()
	writeTranscript(t, filepath.Join(root, "proj"), "a.jsonl",
		row(now.Add(-time.Hour).Format(time.RFC3339), "claude-opus-4-7", 10, 20, 30, 40)+"\n",
		now)

	turns, err := ScanTranscripts(context.Background(), root, now.Add(-5*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(turns) != 1 {
		t.Fatalf("want 1 turn, got %d", len(turns))
	}
	if turns[0].Model != "claude-opus-4-7" || turns[0].Tokens.CacheRead != 30 {
		t.Errorf("bad turn: %+v", turns[0])
	}
}

func TestScanTranscriptsSkipsFilesOlderThanTheWindow(t *testing.T) {
	root := t.TempDir()
	now := time.Now().UTC()
	// A file last written 10h ago cannot hold a row inside a 5h window.
	writeTranscript(t, filepath.Join(root, "proj"), "old.jsonl",
		row(now.Format(time.RFC3339), "claude-opus-4-7", 1, 1, 1, 1)+"\n",
		now.Add(-10*time.Hour))

	turns, err := ScanTranscripts(context.Background(), root, now.Add(-5*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(turns) != 0 {
		t.Errorf("mtime prefilter must skip the file, got %d turns", len(turns))
	}
}

func TestScanTranscriptsFiltersRowsAndToleratesGarbage(t *testing.T) {
	root := t.TempDir()
	now := time.Now().UTC()
	body := "not json at all\n" +
		`{"type":"user","timestamp":"` + now.Format(time.RFC3339) + `"}` + "\n" + // no usage
		`{"type":"assistant","message":{"model":"x","usage":{"input_tokens":5}}}` + "\n" + // no timestamp
		row(now.Add(-9*time.Hour).Format(time.RFC3339), "claude-opus-4-7", 7, 7, 7, 7) + "\n" + // too old
		row(now.Add(-time.Minute).Format(time.RFC3339), "claude-opus-4-7", 1, 2, 3, 4) + "\n"
	writeTranscript(t, filepath.Join(root, "proj"), "mixed.jsonl", body, now)

	turns, err := ScanTranscripts(context.Background(), root, now.Add(-5*time.Hour))
	if err != nil {
		t.Fatalf("a corrupt line must not fail the scan: %v", err)
	}
	if len(turns) != 1 {
		t.Fatalf("want only the in-window priced row, got %d: %+v", len(turns), turns)
	}
	if turns[0].Tokens.Output != 2 {
		t.Errorf("wrong row survived: %+v", turns[0])
	}
}

func TestScanTranscriptsMissingRootIsNotAnError(t *testing.T) {
	turns, err := ScanTranscripts(context.Background(), filepath.Join(t.TempDir(), "nope"), time.Now())
	if err != nil {
		t.Fatalf("a missing transcript root is the fresh-install case: %v", err)
	}
	if len(turns) != 0 {
		t.Errorf("got %d turns", len(turns))
	}
}

func TestSumWindowIsHalfOpen(t *testing.T) {
	p := Pricing{"opus": {Output: 1e6}} // 1 USD per output token
	from := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)
	to := from.Add(time.Hour)
	turns := []Turn{
		{At: from.Add(-time.Second), Model: "opus", Tokens: Tokens{Output: 1}}, // before
		{At: from, Model: "opus", Tokens: Tokens{Output: 1}},                   // inclusive
		{At: to.Add(-time.Second), Model: "opus", Tokens: Tokens{Output: 1}},   // inside
		{At: to, Model: "opus", Tokens: Tokens{Output: 1}},                     // exclusive
	}
	if got := SumWindow(turns, p, from, to); got != 2 {
		t.Errorf("want 2.0 (from inclusive, to exclusive), got %v", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/usage/ -run TestScanTranscripts -v`
Expected: FAIL — `undefined: ScanTranscripts`.

- [ ] **Step 3: Write minimal implementation**

Create `internal/usage/transcript.go`:

```go
package usage

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Turn is one priced-able assistant turn read from a transcript.
type Turn struct {
	At     time.Time
	Model  string
	Tokens Tokens
}

// transcriptRow is the minimal shape we need out of a transcript line. Claude
// Code writes many row types; only assistant rows carry message.usage.
type transcriptRow struct {
	Timestamp time.Time `json:"timestamp"`
	Message   struct {
		Model string `json:"model"`
		Usage *struct {
			InputTokens              int `json:"input_tokens"`
			OutputTokens             int `json:"output_tokens"`
			CacheReadInputTokens     int `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
}

// maxLineBytes bounds one transcript line. Lines routinely exceed bufio's 64 KB
// default because a turn embeds tool results, and a too-small buffer would fail
// the scan on exactly the busiest sessions.
const maxLineBytes = 16 << 20

// ScanTranscripts reads every turn at or after since from the Claude Code
// transcripts under root.
//
// Two filters, both required: files whose mtime predates since are never
// opened (a file not written inside the window cannot hold a row inside it),
// and every surviving row is still checked against its own timestamp.
//
// Malformed lines are skipped rather than fatal — one corrupt line must not
// blind the whole budget rung. A missing root is the fresh-install case and
// returns no turns and no error.
func ScanTranscripts(ctx context.Context, root string, since time.Time) ([]Turn, error) {
	var out []Turn
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if d.IsDir() || !strings.HasSuffix(path, ".jsonl") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil // raced with a delete; nothing to read
		}
		if info.ModTime().Before(since) {
			return nil
		}
		turns, err := scanFile(path, since)
		if err != nil {
			return fmt.Errorf("scan transcript %s: %w", path, err)
		}
		out = append(out, turns...)
		return nil
	})
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return out, nil
}

func scanFile(path string, since time.Time) ([]Turn, error) {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()

	var out []Turn
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), maxLineBytes)
	for sc.Scan() {
		var r transcriptRow
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			continue // a corrupt line is skipped, never fatal
		}
		if r.Message.Usage == nil || r.Timestamp.IsZero() || r.Timestamp.Before(since) {
			continue
		}
		out = append(out, Turn{
			At:    r.Timestamp,
			Model: r.Message.Model,
			Tokens: Tokens{
				Input:      r.Message.Usage.InputTokens,
				Output:     r.Message.Usage.OutputTokens,
				CacheRead:  r.Message.Usage.CacheReadInputTokens,
				CacheWrite: r.Message.Usage.CacheCreationInputTokens,
			},
		})
	}
	if err := sc.Err(); err != nil {
		return out, err
	}
	return out, nil
}

// SumWindow prices every turn in [from, to) — from inclusive, to exclusive.
func SumWindow(turns []Turn, p Pricing, from, to time.Time) float64 {
	total := 0.0
	for _, t := range turns {
		if t.At.Before(from) || !t.At.Before(to) {
			continue
		}
		total += p.CostOf(t.Model, t.Tokens)
	}
	return total
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -race ./internal/usage/ -v`
Expected: PASS — all Task 1 and Task 2 tests.

- [ ] **Step 5: Commit**

```bash
git add internal/usage/transcript.go internal/usage/transcript_test.go
git commit -m "feat(usage): read priced turns from Claude Code transcripts"
```

---

### Task 3: Pipeline run ledger

**Files:**
- Create: `internal/usage/ledger.go`
- Test: `internal/usage/ledger_test.go`

**Interfaces:**
- Consumes: `internal/store.AtomicWrite` (existing, `internal/store/files.go:11`).
- Produces: `usage.Run{At time.Time, Repo string, Issue int, EstUSD float64}`; `usage.Ledger{Runs []Run}`; `usage.LoadLedger(path string) (Ledger, error)`; `usage.WriteLedger(path string, l Ledger) error`; `(*Ledger).Append(r Run)`; `(Ledger).SumSince(t time.Time) float64`; `(*Ledger).Prune(before time.Time)`.

- [ ] **Step 1: Write the failing test**

Create `internal/usage/ledger_test.go`:

```go
package usage

import (
	"path/filepath"
	"testing"
	"time"
)

func TestLoadLedgerMissingFileIsEmpty(t *testing.T) {
	l, err := LoadLedger(filepath.Join(t.TempDir(), "nope.json"))
	if err != nil {
		t.Fatalf("first run must not error: %v", err)
	}
	if len(l.Runs) != 0 {
		t.Errorf("got %d runs", len(l.Runs))
	}
}

func TestLedgerRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.json")
	now := time.Now().UTC().Truncate(time.Second)

	var l Ledger
	l.Append(Run{At: now, Repo: "bridge", Issue: 254, EstUSD: 2})
	if err := WriteLedger(path, l); err != nil {
		t.Fatal(err)
	}

	got, err := LoadLedger(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Runs) != 1 || got.Runs[0].Issue != 254 || got.Runs[0].EstUSD != 2 {
		t.Errorf("round trip: %+v", got.Runs)
	}
	if !got.Runs[0].At.Equal(now) {
		t.Errorf("timestamp: %v != %v", got.Runs[0].At, now)
	}
}

func TestSumSinceIgnoresRunsOutsideTheWindow(t *testing.T) {
	now := time.Now().UTC()
	l := Ledger{Runs: []Run{
		{At: now.Add(-9 * time.Hour), EstUSD: 100},
		{At: now.Add(-2 * time.Hour), EstUSD: 2},
		{At: now.Add(-time.Minute), EstUSD: 3},
	}}
	if got := l.SumSince(now.Add(-5 * time.Hour)); got != 5 {
		t.Errorf("want 5, got %v", got)
	}
}

func TestPruneDropsOldRuns(t *testing.T) {
	now := time.Now().UTC()
	l := Ledger{Runs: []Run{
		{At: now.Add(-200 * time.Hour), EstUSD: 1},
		{At: now.Add(-time.Hour), EstUSD: 2},
	}}
	l.Prune(now.Add(-24 * time.Hour))
	if len(l.Runs) != 1 || l.Runs[0].EstUSD != 2 {
		t.Errorf("prune: %+v", l.Runs)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/usage/ -run TestLedger -v`
Expected: FAIL — `undefined: LoadLedger`.

- [ ] **Step 3: Write minimal implementation**

Create `internal/usage/ledger.go`:

```go
package usage

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"time"

	"github.com/freaxnx01/bridge/internal/store"
)

// Run is one pipeline run bridge dispatched, priced at dispatch time with the
// calibrated mean. bridge is the only thing that applies the ai-implement
// label on a timer, so its own record of what it dispatched is the run
// population — no forge round-trip is needed to enumerate them.
type Run struct {
	At     time.Time `json:"at"`
	Repo   string    `json:"repo"`
	Issue  int       `json:"issue"`
	EstUSD float64   `json:"est_usd"`
}

// Ledger is the append-only local record of dispatched runs.
type Ledger struct {
	Runs []Run `json:"runs"`
}

// LoadLedger reads the ledger. A missing file is the first-run case, not an
// error — the same contract as dispatch.ReadState.
func LoadLedger(path string) (Ledger, error) {
	var l Ledger
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Ledger{}, nil
	}
	if err != nil {
		return Ledger{}, err
	}
	if err := json.Unmarshal(b, &l); err != nil {
		return Ledger{}, err
	}
	return l, nil
}

// WriteLedger persists the ledger atomically.
func WriteLedger(path string, l Ledger) error {
	b, err := json.MarshalIndent(l, "", "  ")
	if err != nil {
		return err
	}
	return store.AtomicWrite(path, b)
}

// Append records one dispatched run.
func (l *Ledger) Append(r Run) { l.Runs = append(l.Runs, r) }

// SumSince totals the estimated cost of runs dispatched at or after t.
func (l Ledger) SumSince(t time.Time) float64 {
	total := 0.0
	for _, r := range l.Runs {
		if r.At.Before(t) {
			continue
		}
		total += r.EstUSD
	}
	return total
}

// Prune drops runs older than before, keeping the file bounded. Only the
// trailing quota window is ever summed, so older entries have no readers.
func (l *Ledger) Prune(before time.Time) {
	kept := l.Runs[:0]
	for _, r := range l.Runs {
		if r.At.Before(before) {
			continue
		}
		kept = append(kept, r)
	}
	l.Runs = kept
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -race ./internal/usage/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/usage/ledger.go internal/usage/ledger_test.go
git commit -m "feat(usage): add the dispatched-run cost ledger"
```

---

### Task 4: Schedule windows replace the dead schedule config

**Files:**
- Modify: `internal/dispatch/types.go:15-18` (replace the `Schedule` struct)
- Modify: `internal/dispatch/config.go:17` (default windows)
- Create: `internal/dispatch/window.go`
- Test: `internal/dispatch/window_test.go`
- Modify: `internal/dispatch/config_test.go:18-20` (the assertion on `DispatchAt`/`RetryUntil` must go — those fields no longer exist)

**Interfaces:**
- Consumes: nothing.
- Produces: `dispatch.Window{From, To string, BudgetRung bool}` (JSON `from`/`to`/`budget_rung`); `dispatch.Schedule{Windows []Window}` (JSON `windows`); `(Schedule).InWindow(now time.Time) (Window, bool)`.

**Context for the implementer:** `dispatch_at`/`retry_until` are declared and defaulted today but **read by nothing** — the systemd timer is the real schedule. This task deletes them and gives the config a real reader, so the hours live in exactly one place.

- [ ] **Step 1: Write the failing test**

Create `internal/dispatch/window_test.go`:

```go
package dispatch

import (
	"testing"
	"time"
)

func at(hour, min int) time.Time {
	return time.Date(2026, 9, 7, hour, min, 0, 0, time.Local)
}

func TestInWindow(t *testing.T) {
	s := DefaultConfig().Schedule // 18:00-07:00 no rung, 07:00-18:00 rung

	tests := []struct {
		name     string
		now      time.Time
		wantIn   bool
		wantRung bool
	}{
		{"midday is the rung window", at(12, 0), true, true},
		{"late evening wraps into the night window", at(23, 30), true, false},
		{"after midnight is still the night window", at(2, 0), true, false},
		{"day window start is inclusive", at(7, 0), true, true},
		{"day window end is exclusive", at(18, 0), true, false},
		{"night window start is inclusive", at(18, 1), true, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			w, ok := s.InWindow(tc.now)
			if ok != tc.wantIn {
				t.Fatalf("in=%v want %v", ok, tc.wantIn)
			}
			if ok && w.BudgetRung != tc.wantRung {
				t.Errorf("rung=%v want %v (window %+v)", w.BudgetRung, tc.wantRung, w)
			}
		})
	}
}

func TestInWindowNoWindowsMeansNeverInWindow(t *testing.T) {
	if _, ok := (Schedule{}).InWindow(at(12, 0)); ok {
		t.Error("an empty window list must not match")
	}
}

func TestInWindowSkipsMalformedEntries(t *testing.T) {
	s := Schedule{Windows: []Window{
		{From: "not-a-time", To: "18:00", BudgetRung: true},
		{From: "07:00", To: "18:00"},
	}}
	w, ok := s.InWindow(at(12, 0))
	if !ok {
		t.Fatal("the well-formed window must still match")
	}
	if w.BudgetRung {
		t.Error("the malformed window must be skipped, not used")
	}
}

func TestInWindowGapIsNotInAnyWindow(t *testing.T) {
	s := Schedule{Windows: []Window{{From: "07:00", To: "12:00"}}}
	if _, ok := s.InWindow(at(15, 0)); ok {
		t.Error("15:00 is outside the only window")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/dispatch/ -run TestInWindow -v`
Expected: FAIL — `s.InWindow undefined` and `unknown field Windows`.

- [ ] **Step 3: Write minimal implementation**

In `internal/dispatch/types.go`, replace the `Schedule` struct:

```go
// Window is a span of the local day during which dispatch ticks act. From is
// inclusive, To exclusive; From > To wraps past midnight. BudgetRung turns the
// usage-budget rung on for the window.
type Window struct {
	From       string `json:"from"`
	To         string `json:"to"`
	BudgetRung bool   `json:"budget_rung"`
}

// Schedule is the single source of truth for when dispatch acts. The systemd
// timer is a bare hourly heartbeat, so these windows are the only place the
// hours are written down — the previous dispatch_at/retry_until fields were
// read by nothing and duplicated the timer.
type Schedule struct {
	Windows []Window `json:"windows"`
}
```

Create `internal/dispatch/window.go`:

```go
package dispatch

import (
	"strconv"
	"strings"
	"time"
)

// InWindow returns the first configured window covering now. A malformed
// entry is skipped rather than fatal, and no match means dispatch does not act
// — the safe direction for a schedule.
func (s Schedule) InWindow(now time.Time) (Window, bool) {
	cur := now.Hour()*60 + now.Minute()
	for _, w := range s.Windows {
		from, ok := parseHHMM(w.From)
		if !ok {
			continue
		}
		to, ok := parseHHMM(w.To)
		if !ok {
			continue
		}
		if covers(from, to, cur) {
			return w, true
		}
	}
	return Window{}, false
}

// covers reports whether minute-of-day cur falls in [from, to), wrapping past
// midnight when from > to. from == to covers the whole day.
func covers(from, to, cur int) bool {
	switch {
	case from == to:
		return true
	case from < to:
		return cur >= from && cur < to
	default:
		return cur >= from || cur < to
	}
}

func parseHHMM(s string) (int, bool) {
	h, m, found := strings.Cut(s, ":")
	if !found {
		return 0, false
	}
	hh, err := strconv.Atoi(h)
	if err != nil || hh < 0 || hh > 23 {
		return 0, false
	}
	mm, err := strconv.Atoi(m)
	if err != nil || mm < 0 || mm > 59 {
		return 0, false
	}
	return hh*60 + mm, true
}
```

In `internal/dispatch/config.go`, replace the `Schedule` line in `DefaultConfig`:

```go
		Schedule: Schedule{Windows: []Window{
			{From: "18:00", To: "07:00", BudgetRung: false},
			{From: "07:00", To: "18:00", BudgetRung: true},
		}},
```

In `internal/dispatch/config_test.go`, delete the now-invalid assertion in `TestLoadConfigMissingFileReturnsDefaults`:

```go
	if c.Schedule.DispatchAt != "22:00" || c.Schedule.RetryUntil != "06:00" {
		t.Errorf("schedule: %+v", c.Schedule)
	}
```

and replace it with:

```go
	if len(c.Schedule.Windows) != 2 || !c.Schedule.Windows[1].BudgetRung {
		t.Errorf("default windows: %+v", c.Schedule.Windows)
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -race ./internal/dispatch/ -v`
Expected: PASS — the new window tests plus every pre-existing dispatch test.

- [ ] **Step 5: Add the backwards-compatibility test**

Append to `internal/dispatch/config_test.go`:

```go
func TestLoadConfigIgnoresRetiredScheduleKeys(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dispatch.json")
	// A config written before windows existed must still load.
	os.WriteFile(path, []byte(`{"schedule":{"dispatch_at":"22:00","retry_until":"06:00"}}`), 0o600)

	c, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("retired keys must be ignored, not fatal: %v", err)
	}
	if len(c.Schedule.Windows) != 2 {
		t.Errorf("windows must fall back to defaults: %+v", c.Schedule.Windows)
	}
}

func TestLoadConfigWindowsReplaceTheDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dispatch.json")
	os.WriteFile(path, []byte(`{"schedule":{"windows":[{"from":"09:00","to":"10:00","budget_rung":true}]}}`), 0o600)

	c, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Schedule.Windows) != 1 || c.Schedule.Windows[0].From != "09:00" {
		t.Errorf("a configured list must replace the defaults, not merge: %+v", c.Schedule.Windows)
	}
}
```

Run: `go test -race ./internal/dispatch/ -run TestLoadConfig -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/dispatch/types.go internal/dispatch/config.go \
        internal/dispatch/window.go internal/dispatch/window_test.go \
        internal/dispatch/config_test.go
git commit -m "feat(dispatch): make configured windows the single schedule truth"
```

---

### Task 5: The budget rung in ApplyCaps

**Files:**
- Modify: `internal/dispatch/types.go` (add `Budget`, wire into `Config`)
- Modify: `internal/dispatch/config.go` (budget defaults)
- Create: `internal/dispatch/budget.go`
- Modify: `internal/dispatch/caps.go` (the `Counts` struct and the new first rung)
- Test: `internal/dispatch/budget_test.go`
- Modify: `internal/dispatch/caps_test.go` (migrate every call to the new signature)

**Interfaces:**
- Consumes: `usage.Rate` (Task 1).
- Produces: `dispatch.Budget{WindowHours, WindowBudgetUSD, DaytimeCap, MeanRunCostUSD float64, Pricing map[string]usage.Rate}`; `dispatch.BudgetState{Enabled, Unknown bool, UsedUSD, LimitUSD, PerRunUSD float64}`; `dispatch.NewBudgetState(b Budget, enabled bool, usedUSD float64, usedKnown bool) BudgetState`; `dispatch.Counts{OpenPRsByRepo map[string]int, GlobalOpen, DispatchedTonight int}`; the new `ApplyCaps(ordered []Candidate, cfg Config, counts Counts, budget BudgetState) []Decision`.

- [ ] **Step 1: Write the failing test**

Create `internal/dispatch/budget_test.go`:

```go
package dispatch

import (
	"strings"
	"testing"
)

func TestNewBudgetStateComputesTheLimit(t *testing.T) {
	b := Budget{WindowHours: 5, WindowBudgetUSD: 12, DaytimeCap: 0.8, MeanRunCostUSD: 2}
	s := NewBudgetState(b, true, 3, true)

	if s.LimitUSD != 9.6 {
		t.Errorf("limit = budget * cap: %v", s.LimitUSD)
	}
	if s.Unknown || !s.Enabled || s.UsedUSD != 3 || s.PerRunUSD != 2 {
		t.Errorf("%+v", s)
	}
}

func TestNewBudgetStateIsUnknownOnBadInput(t *testing.T) {
	ok := Budget{WindowHours: 5, WindowBudgetUSD: 12, DaytimeCap: 0.8, MeanRunCostUSD: 2}
	tests := []struct {
		name      string
		b         Budget
		usedKnown bool
	}{
		{"usage unreadable", ok, false},
		{"no window budget", Budget{WindowBudgetUSD: 0, DaytimeCap: 0.8, MeanRunCostUSD: 2}, true},
		{"no cap", Budget{WindowBudgetUSD: 12, DaytimeCap: 0, MeanRunCostUSD: 2}, true},
		{"no per-run estimate", Budget{WindowBudgetUSD: 12, DaytimeCap: 0.8, MeanRunCostUSD: 0}, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if s := NewBudgetState(tc.b, true, 0, tc.usedKnown); !s.Unknown {
				t.Errorf("must fail closed: %+v", s)
			}
		})
	}
}

func TestApplyCapsBudgetRung(t *testing.T) {
	cfg := DefaultConfig()
	budget := func(used float64) BudgetState {
		return NewBudgetState(Budget{WindowBudgetUSD: 10, DaytimeCap: 1.0, MeanRunCostUSD: 2}, true, used, true)
	}

	t.Run("under cap dispatches", func(t *testing.T) {
		ds := ApplyCaps([]Candidate{cand("a", 1)}, cfg, Counts{}, budget(4))
		if !ds[0].Dispatch {
			t.Errorf("%+v", ds[0])
		}
	})

	t.Run("projected cost crossing the line refuses", func(t *testing.T) {
		// 9 used + 2 projected > 10 limit, even though 9 < 10.
		ds := ApplyCaps([]Candidate{cand("a", 1)}, cfg, Counts{}, budget(9))
		if ds[0].Dispatch || !strings.HasPrefix(ds[0].Reason, "budget-exhausted") {
			t.Errorf("%+v", ds[0])
		}
	})

	t.Run("projection accumulates within one tick", func(t *testing.T) {
		// Room for exactly two runs: 5 used + 2 + 2 = 9 <= 10, a third would be 11.
		cs := []Candidate{cand("a", 1), cand("b", 2), cand("c", 3)}
		ds := ApplyCaps(cs, cfg, Counts{}, budget(5))
		if !ds[0].Dispatch || !ds[1].Dispatch {
			t.Fatalf("first two should dispatch: %+v %+v", ds[0], ds[1])
		}
		if ds[2].Dispatch {
			t.Errorf("third must be refused on the accumulated projection: %+v", ds[2])
		}
	})

	t.Run("unknown usage refuses everything", func(t *testing.T) {
		unknown := NewBudgetState(Budget{WindowBudgetUSD: 10, DaytimeCap: 1, MeanRunCostUSD: 2}, true, 0, false)
		ds := ApplyCaps([]Candidate{cand("a", 1)}, cfg, Counts{}, unknown)
		if ds[0].Dispatch || ds[0].Reason != "budget-unknown" {
			t.Errorf("%+v", ds[0])
		}
	})

	t.Run("disabled rung ignores usage entirely", func(t *testing.T) {
		night := NewBudgetState(Budget{WindowBudgetUSD: 10, DaytimeCap: 1, MeanRunCostUSD: 2}, false, 999, true)
		ds := ApplyCaps([]Candidate{cand("a", 1)}, cfg, Counts{}, night)
		if !ds[0].Dispatch {
			t.Errorf("the night window must not consult the budget: %+v", ds[0])
		}
	})
}

func TestApplyCapsBudgetRungRunsBeforeTheOtherCaps(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Limits.MaxDispatchesPerNight = 1
	exhausted := NewBudgetState(Budget{WindowBudgetUSD: 1, DaytimeCap: 1, MeanRunCostUSD: 2}, true, 1, true)

	ds := ApplyCaps([]Candidate{cand("a", 1)}, cfg, Counts{DispatchedTonight: 5}, exhausted)
	if !strings.HasPrefix(ds[0].Reason, "budget-exhausted") {
		t.Errorf("the budget reason must win over the night cap: %q", ds[0].Reason)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/dispatch/ -run TestApplyCapsBudget -v`
Expected: FAIL — `undefined: NewBudgetState`, `undefined: Counts`.

- [ ] **Step 3: Write minimal implementation**

In `internal/dispatch/types.go`, add the `Budget` type and the `Config` field. Add the import `"github.com/freaxnx01/bridge/internal/usage"`:

```go
// Budget configures the usage-budget rung. Every value is a calibrated proxy:
// no API reports how much of the 5h subscription window is left, so trailing
// consumption is summed in USD-equivalent against WindowBudgetUSD, which is
// pinned empirically against /usage.
type Budget struct {
	WindowHours     float64               `json:"window_hours"`
	WindowBudgetUSD float64               `json:"window_budget_usd"`
	DaytimeCap      float64               `json:"daytime_cap"`
	MeanRunCostUSD  float64               `json:"mean_run_cost_usd"`
	Pricing         map[string]usage.Rate `json:"pricing,omitempty"`
}
```

and in `Config`:

```go
	Budget Budget `json:"budget"`
```

In `internal/dispatch/config.go`, add to `DefaultConfig`:

```go
		Budget: Budget{
			WindowHours:     5,
			WindowBudgetUSD: 12.0,
			DaytimeCap:      0.80,
			MeanRunCostUSD:  2.0,
		},
```

Create `internal/dispatch/budget.go`:

```go
package dispatch

// BudgetState is the tick's already-measured budget position. Measuring is the
// caller's job — keeping it out of here is what lets ApplyCaps stay a pure
// function with no clock and no filesystem.
type BudgetState struct {
	Enabled   bool    // the current window turns the rung on
	Unknown   bool    // usage could not be measured — refuse everything
	UsedUSD   float64 // trailing-window consumption, interactive + pipeline
	LimitUSD  float64 // WindowBudgetUSD * DaytimeCap
	PerRunUSD float64 // projected cost of one dispatched run
}

// NewBudgetState builds the rung's input for one tick.
//
// usedKnown false means the measurement failed. That is not the same as zero
// used: the rung exists to protect the operator's headroom, so unreadable
// usage must block rather than wave work through. Nonsensical configuration
// (no budget, no cap, no per-run estimate) fails closed for the same reason.
func NewBudgetState(b Budget, enabled bool, usedUSD float64, usedKnown bool) BudgetState {
	s := BudgetState{
		Enabled:   enabled,
		UsedUSD:   usedUSD,
		LimitUSD:  b.WindowBudgetUSD * b.DaytimeCap,
		PerRunUSD: b.MeanRunCostUSD,
	}
	s.Unknown = !usedKnown ||
		b.WindowBudgetUSD <= 0 ||
		b.DaytimeCap <= 0 ||
		b.MeanRunCostUSD <= 0
	return s
}
```

In `internal/dispatch/caps.go`, add the `Counts` struct and rewrite `ApplyCaps`:

```go
// Counts are the tick's pre-existing counts: how many agent PRs are already
// open per repo and in total, and how many dispatches this night has produced.
type Counts struct {
	OpenPRsByRepo     map[string]int
	GlobalOpen        int
	DispatchedTonight int
}

// ApplyCaps walks an ordered candidate list and marks each one dispatch or
// skip, tightening four independent bounds as it goes:
//
//	budget      — the operator's remaining subscription headroom (daytime only)
//	per-repo    — avoids conflicting concurrent PRs in one repo
//	global      — the operator's review capacity
//	nightly     — bounds unattended spend, which the WIP cap alone cannot
//
// The budget rung is checked first because it is the only bound protecting the
// human rather than the machine: once the window is spent, nothing else about
// the candidate matters.
func ApplyCaps(ordered []Candidate, cfg Config, counts Counts, budget BudgetState) []Decision {
	perRepo := make(map[string]int, len(counts.OpenPRsByRepo))
	for k, v := range counts.OpenPRsByRepo {
		perRepo[k] = v
	}
	global := counts.GlobalOpen
	night := counts.DispatchedTonight
	spent := budget.UsedUSD

	out := make([]Decision, 0, len(ordered))
	for _, c := range ordered {
		limit := cfg.LimitFor(c.Repo)
		switch {
		case budget.Enabled && budget.Unknown:
			out = append(out, Decision{c, false, "budget-unknown"})
		case budget.Enabled && spent+budget.PerRunUSD > budget.LimitUSD:
			out = append(out, Decision{c, false,
				fmt.Sprintf("budget-exhausted %.2f/%.2f USD", spent, budget.LimitUSD)})
		case night >= cfg.Limits.MaxDispatchesPerNight:
			out = append(out, Decision{c, false,
				fmt.Sprintf("night cap %d/%d", night, cfg.Limits.MaxDispatchesPerNight)})
		case global >= cfg.Limits.GlobalOpenPRs:
			out = append(out, Decision{c, false,
				fmt.Sprintf("global cap %d/%d", global, cfg.Limits.GlobalOpenPRs)})
		case perRepo[c.Repo] >= limit:
			out = append(out, Decision{c, false,
				fmt.Sprintf("repo at WIP %d/%d", perRepo[c.Repo], limit)})
		default:
			perRepo[c.Repo]++
			global++
			night++
			spent += budget.PerRunUSD
			out = append(out, Decision{c, true, ""})
		}
	}
	return out
}
```

- [ ] **Step 4: Migrate the existing cap tests to the new signature**

In `internal/dispatch/caps_test.go`, every `ApplyCaps` call changes shape. The five existing calls become:

```go
	ds := ApplyCaps([]Candidate{cand("quotes", 1), cand("quotes", 2)}, cfg, Counts{}, BudgetState{})
	ds := ApplyCaps([]Candidate{cand("quotes", 1)}, cfg, Counts{OpenPRsByRepo: map[string]int{"quotes": 1}, GlobalOpen: 1}, BudgetState{})
	ds := ApplyCaps(cs, cfg, Counts{}, BudgetState{})
	ds := ApplyCaps([]Candidate{cand("a", 1), cand("b", 2)}, cfg, Counts{}, BudgetState{})
	ds := ApplyCaps([]Candidate{cand("a", 1)}, cfg, Counts{DispatchedTonight: 2}, BudgetState{})
	ds := ApplyCaps([]Candidate{cand("quotes", 1), cand("quotes", 2)}, cfg, Counts{}, BudgetState{})
```

A zero `BudgetState` has `Enabled: false`, so every pre-existing assertion keeps its original meaning. Do not change any assertion in that file.

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test -race ./internal/dispatch/ -v`
Expected: PASS — new budget tests plus all migrated cap tests.

- [ ] **Step 6: Commit**

```bash
git add internal/dispatch/types.go internal/dispatch/config.go \
        internal/dispatch/budget.go internal/dispatch/budget_test.go \
        internal/dispatch/caps.go internal/dispatch/caps_test.go
git commit -m "feat(dispatch): add the usage-budget rung ahead of the other caps"
```

---

### Task 6: Wire the rung into the dispatch tick

**Files:**
- Modify: `cmd/bridge/dispatch.go` (`runDispatch`, `applyDecisions`, new path/measurement helpers)
- Test: `cmd/bridge/dispatch_test.go`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `transcriptRoot() string`, `dispatchLedgerPath() string`, `measureWindowUSD(ctx context.Context, cfg dispatch.Config, now time.Time) (float64, bool)`.

**Context for the implementer:** two gates with deliberately different scopes.

- The **window** gate applies to `--auto` only. An explicit `dispatch now` is the operator asking for a tick, exactly as the existing pause flag behaves.
- The **budget** rung applies whenever the resolved window has `budget_rung`, `--auto` or not. A manual daytime dispatch burns the same quota, so it gets the same guard. If no window matches at all (a manual run at 03:00 under a day-only config), the rung is off.

- [ ] **Step 1: Write the failing test**

Append to `cmd/bridge/dispatch_test.go`:

```go
func TestMeasureWindowUSDCountsBothSources(t *testing.T) {
	projects := t.TempDir()
	cache := t.TempDir()
	t.Setenv("BRIDGE_CLAUDE_PROJECTS", projects)
	t.Setenv("XDG_CACHE_HOME", cache)

	now := time.Now().UTC()

	// One interactive turn: 1M output tokens of opus at 75 USD/Mtok.
	line := `{"type":"assistant","timestamp":"` + now.Add(-time.Hour).Format(time.RFC3339) +
		`","message":{"model":"claude-opus-4-7","usage":{"input_tokens":0,"output_tokens":1000000,` +
		`"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`
	dir := filepath.Join(projects, "proj")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.jsonl"), []byte(line+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	// One dispatched run in the ledger.
	var l usage.Ledger
	l.Append(usage.Run{At: now.Add(-time.Minute), Repo: "bridge", Issue: 254, EstUSD: 2})
	if err := usage.WriteLedger(dispatchLedgerPath(), l); err != nil {
		t.Fatal(err)
	}

	got, ok := measureWindowUSD(context.Background(), dispatch.DefaultConfig(), now)
	if !ok {
		t.Fatal("measurement should be known")
	}
	if diff := got - 77.0; diff > 0.01 || diff < -0.01 {
		t.Errorf("want 75 interactive + 2 pipeline = 77, got %v", got)
	}
}

func TestMeasureWindowUSDMissingSourcesAreZeroNotUnknown(t *testing.T) {
	t.Setenv("BRIDGE_CLAUDE_PROJECTS", filepath.Join(t.TempDir(), "absent"))
	t.Setenv("XDG_CACHE_HOME", t.TempDir())

	got, ok := measureWindowUSD(context.Background(), dispatch.DefaultConfig(), time.Now())
	if !ok || got != 0 {
		t.Errorf("a fresh install has measured zero usage, not unknown: got=%v ok=%v", got, ok)
	}
}

func TestMeasureWindowUSDUnreadableLedgerIsUnknown(t *testing.T) {
	t.Setenv("BRIDGE_CLAUDE_PROJECTS", filepath.Join(t.TempDir(), "absent"))
	cache := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", cache)

	// Corrupt ledger: readable file, invalid JSON.
	path := dispatchLedgerPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, ok := measureWindowUSD(context.Background(), dispatch.DefaultConfig(), time.Now()); ok {
		t.Error("a corrupt ledger must report unknown so the rung fails closed")
	}
}

func TestTranscriptRootHonoursTheEnvOverride(t *testing.T) {
	t.Setenv("BRIDGE_CLAUDE_PROJECTS", "/tmp/somewhere")
	if got := transcriptRoot(); got != "/tmp/somewhere" {
		t.Errorf("got %q", got)
	}
}
```

Add `"context"` and `"time"` to the test file's imports, plus `"github.com/freaxnx01/bridge/internal/usage"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/bridge/ -run TestMeasureWindowUSD -v`
Expected: FAIL — `undefined: measureWindowUSD`.

- [ ] **Step 3: Write minimal implementation**

In `cmd/bridge/dispatch.go`, add the helpers next to `dispatchStatePath`:

```go
func dispatchLedgerPath() string { return filepath.Join(cacheRoot(), "usage.json") }

// transcriptRoot is where Claude Code writes its session transcripts. The env
// override exists so tests never read the operator's real history.
func transcriptRoot() string {
	if v := os.Getenv("BRIDGE_CLAUDE_PROJECTS"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "projects")
}

// measureWindowUSD sums interactive and pipeline consumption over the trailing
// quota window. The bool reports whether the number can be trusted: false means
// fail closed, and is never the same as a measured zero.
func measureWindowUSD(ctx context.Context, cfg dispatch.Config, now time.Time) (float64, bool) {
	since := now.Add(-time.Duration(cfg.Budget.WindowHours * float64(time.Hour)))

	turns, err := usage.ScanTranscripts(ctx, transcriptRoot(), since)
	if err != nil {
		slog.Warn("dispatch: cannot read Claude transcripts — daytime dispatch will be blocked", "error", err)
		return 0, false
	}
	ledger, err := usage.LoadLedger(dispatchLedgerPath())
	if err != nil {
		slog.Warn("dispatch: cannot read the usage ledger — daytime dispatch will be blocked", "error", err)
		return 0, false
	}

	pricing := usage.DefaultPricing().Merge(cfg.Budget.Pricing)
	return usage.SumWindow(turns, pricing, since, now) + ledger.SumSince(since), true
}
```

Rewrite the body of `runDispatch` between the pause check and `ApplyCaps`:

```go
	now := time.Now()
	win, inWindow := cfg.Schedule.InWindow(now)
	// The window gate is --auto only: an explicit `dispatch now` is the
	// operator asking for a tick, the same exemption the pause flag has.
	if dispatchAuto && !inWindow {
		fmt.Fprintln(cmd.OutOrStdout(), "outside dispatch window — nothing to do")
		return nil
	}

	ctx := context.Background()
	repos, err := fetchRepoInputs(ctx)
	if err != nil {
		return err
	}

	// The rung applies whether or not this is --auto: a manual daytime
	// dispatch burns the same quota.
	rungOn := inWindow && win.BudgetRung
	usedUSD, usedKnown := 0.0, true
	if rungOn {
		usedUSD, usedKnown = measureWindowUSD(ctx, cfg, now)
	}
	budget := dispatch.NewBudgetState(cfg.Budget, rungOn, usedUSD, usedKnown)

	openByRepo, globalOpen := countOpenAgentPRs(repos)
	decisions := dispatch.ApplyCaps(
		dispatch.Order(collectCandidates(repos), cfg.RepoPriority),
		cfg,
		dispatch.Counts{
			OpenPRsByRepo:     openByRepo,
			GlobalOpen:        globalOpen,
			DispatchedTonight: state.NightBudgetUsed(now),
		},
		budget,
	)
```

The existing `if dispatchJSON { ... } else { ... }` block and the `dispatchDryRun` early return stay as they are. Change the final call to pass the context:

```go
	return applyDecisions(ctx, decisions, state, now, cfg)
```

Extend `applyDecisions` to record the ledger. Change its signature to
`func applyDecisions(ctx context.Context, ds []dispatch.Decision, state dispatch.State, now time.Time, cfg dispatch.Config) error`,
and after the dispatch loop, before the state write:

```go
	if dispatched > 0 {
		ledger, err := usage.LoadLedger(dispatchLedgerPath())
		if err != nil {
			return fmt.Errorf("read usage ledger: %w", err)
		}
		for _, d := range ds {
			if !d.Dispatch {
				continue
			}
			ledger.Append(usage.Run{
				At:     now,
				Repo:   d.Candidate.Repo,
				Issue:  d.Candidate.Issue.Number,
				EstUSD: cfg.Budget.MeanRunCostUSD,
			})
		}
		// Only the trailing window is ever summed; a week of history is
		// plenty for calibration and keeps the file bounded.
		ledger.Prune(now.AddDate(0, 0, -7))
		if err := usage.WriteLedger(dispatchLedgerPath(), ledger); err != nil {
			return fmt.Errorf("write usage ledger: %w", err)
		}
	}
```

Add `"github.com/freaxnx01/bridge/internal/usage"` to the file's imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -race ./cmd/bridge/ -v`
Expected: PASS — the four new tests plus every pre-existing `cmd/bridge` test.

- [ ] **Step 5: Add the window-gate test**

Append to `cmd/bridge/dispatch_test.go`:

```go
func TestRunDispatchAutoOutsideWindowSkipsBeforeFetching(t *testing.T) {
	cfgDir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", cfgDir)
	t.Setenv("XDG_CACHE_HOME", t.TempDir())

	// A window that cannot contain "now": one minute wide, an hour ago.
	past := time.Now().Add(-time.Hour)
	body := `{"schedule":{"windows":[{"from":"` + past.Format("15:04") + `","to":"` +
		past.Add(time.Minute).Format("15:04") + `","budget_rung":false}]}}`
	if err := os.MkdirAll(filepath.Join(cfgDir, "bridge"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfgDir, "bridge", "dispatch.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	dispatchAuto = true
	t.Cleanup(func() { dispatchAuto = false })

	var buf bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&buf)

	// No forge client is configured here: reaching the fetch would fail, so a
	// clean return is itself the assertion that the gate ran first.
	if err := runDispatch(cmd, nil); err != nil {
		t.Fatalf("out-of-window tick must return cleanly: %v", err)
	}
	if !strings.Contains(buf.String(), "outside dispatch window") {
		t.Errorf("got %q", buf.String())
	}
}
```

Run: `go test -race ./cmd/bridge/ -run TestRunDispatchAuto -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cmd/bridge/dispatch.go cmd/bridge/dispatch_test.go
git commit -m "feat(dispatch): gate ticks on the schedule window and usage budget"
```

---

### Task 7: Report usage in `dispatch status`

**Files:**
- Modify: `cmd/bridge/dispatch.go` (`runDispatchStatus`)
- Test: `cmd/bridge/dispatch_test.go`

**Interfaces:**
- Consumes: `measureWindowUSD` (Task 6), `dispatch.NewBudgetState` (Task 5).
- Produces: no new exported names; the JSON status object gains `budget_window_hours`, `budget_used_usd`, `budget_limit_usd`, `budget_known`, `budget_rung_active`.

**Context for the implementer:** this is what makes week-one calibration possible — read it against `/usage` at intervals to pin `window_budget_usd`. Both sources are local, so `status` must stay network-free, preserving the existing property documented on the function.

- [ ] **Step 1: Write the failing test**

Append to `cmd/bridge/dispatch_test.go`:

```go
func TestRunDispatchStatusReportsBudget(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("BRIDGE_CLAUDE_PROJECTS", filepath.Join(t.TempDir(), "absent"))

	var buf bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&buf)

	if err := runDispatchStatus(cmd, nil); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	if !strings.Contains(out, "budget window:") {
		t.Errorf("status must report the budget window:\n%s", out)
	}
	if !strings.Contains(out, "9.60") {
		t.Errorf("status must show the limit (12.00 * 0.80):\n%s", out)
	}
}

func TestRunDispatchStatusJSONCarriesBudgetFields(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("BRIDGE_CLAUDE_PROJECTS", filepath.Join(t.TempDir(), "absent"))

	dispatchJSON = true
	t.Cleanup(func() { dispatchJSON = false })

	var buf bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&buf)
	if err := runDispatchStatus(cmd, nil); err != nil {
		t.Fatal(err)
	}

	var got struct {
		BudgetUsedUSD  float64 `json:"budget_used_usd"`
		BudgetLimitUSD float64 `json:"budget_limit_usd"`
		BudgetKnown    bool    `json:"budget_known"`
	}
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.BudgetLimitUSD != 9.6 || !got.BudgetKnown {
		t.Errorf("%+v", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/bridge/ -run TestRunDispatchStatus -v`
Expected: FAIL — the output has no `budget window:` line and the JSON has no budget fields.

- [ ] **Step 3: Write minimal implementation**

In `runDispatchStatus`, after loading `cfg` and `state`, add the measurement, and update the function's doc comment to say it reads local usage sources but still makes no network call:

```go
	now := time.Now()
	win, inWindow := cfg.Schedule.InWindow(now)
	usedUSD, usedKnown := measureWindowUSD(context.Background(), cfg, now)
	budget := dispatch.NewBudgetState(cfg.Budget, inWindow && win.BudgetRung, usedUSD, usedKnown)
```

Replace the JSON branch's anonymous struct with:

```go
		return emitJSON(cmd.OutOrStdout(), struct {
			Limits            dispatch.Limits `json:"limits"`
			Paused            bool            `json:"paused"`
			DispatchedTonight int             `json:"dispatched_tonight"`
			LastTick          time.Time       `json:"last_tick,omitempty"`
			BudgetWindowHours float64         `json:"budget_window_hours"`
			BudgetUsedUSD     float64         `json:"budget_used_usd"`
			BudgetLimitUSD    float64         `json:"budget_limit_usd"`
			BudgetKnown       bool            `json:"budget_known"`
			BudgetRungActive  bool            `json:"budget_rung_active"`
		}{
			Limits:            cfg.Limits,
			Paused:            state.Paused,
			DispatchedTonight: state.NightBudgetUsed(now),
			LastTick:          state.LastTick,
			BudgetWindowHours: cfg.Budget.WindowHours,
			BudgetUsedUSD:     budget.UsedUSD,
			BudgetLimitUSD:    budget.LimitUSD,
			BudgetKnown:       !budget.Unknown,
			BudgetRungActive:  budget.Enabled,
		})
```

And in the text branch, after the `per-repo cap` line:

```go
	if budget.Unknown {
		fmt.Fprintf(w, "budget window: %gh — usage unreadable, daytime dispatch blocked\n", cfg.Budget.WindowHours)
	} else {
		pct := 0.0
		if budget.LimitUSD > 0 {
			pct = budget.UsedUSD / budget.LimitUSD * 100
		}
		fmt.Fprintf(w, "budget window: %gh — used $%.2f of $%.2f (%.0f%%)\n",
			cfg.Budget.WindowHours, budget.UsedUSD, budget.LimitUSD, pct)
	}
	fmt.Fprintf(w, "budget rung: %s\n", rungLabel(budget.Enabled, win, inWindow))
```

Add the small helper below the function:

```go
// rungLabel describes whether the budget rung is policing this moment, and
// which window that decision came from.
func rungLabel(enabled bool, win dispatch.Window, inWindow bool) string {
	if !inWindow {
		return "inactive (outside every configured window)"
	}
	if !enabled {
		return fmt.Sprintf("inactive (window %s-%s)", win.From, win.To)
	}
	return fmt.Sprintf("active (window %s-%s)", win.From, win.To)
}
```

Add `"context"` to the imports if Task 6 did not already.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -race ./cmd/bridge/ -v`
Expected: PASS.

- [ ] **Step 5: Run the full suite and every gate**

```bash
gofmt -l .
go vet ./...
golangci-lint run
go test -race ./...
```

Expected: `gofmt -l .` prints nothing; the rest are clean and green.

- [ ] **Step 6: Commit**

```bash
git add cmd/bridge/dispatch.go cmd/bridge/dispatch_test.go
git commit -m "feat(dispatch): report trailing-window usage in dispatch status"
```

---

### Task 8: Documentation and the timer (last, by constraint)

**Files:**
- Modify: `docs/dispatch.md`
- Modify: `docs/systemd/bridge-dispatch.timer`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the shipped behaviour of Tasks 1–7.
- Produces: nothing code-facing.

**Context for the implementer:** #254's binding sequencing constraint — the timer must not reach the workday before the guard exists. Every preceding task ships the guard; this task is the only one allowed to touch the `.timer`. Do not reorder it.

- [ ] **Step 1: Update the timer**

Replace `docs/systemd/bridge-dispatch.timer` with:

```ini
[Unit]
Description=bridge dispatch — hourly heartbeat; the dispatch windows live in dispatch.json

[Timer]
OnCalendar=*-*-* *:00:00
Persistent=false

[Install]
WantedBy=timers.target
```

- [ ] **Step 2: Document the rung in `docs/dispatch.md`**

Add a section covering, with no placeholders:

- The window model: `schedule.windows`, `from` inclusive / `to` exclusive, `from > to` wraps past midnight, and that the timer is now a bare hourly heartbeat so the windows are the only schedule truth.
- The budget rung: what it measures (interactive transcripts + the self-accounted run ledger over the trailing `window_hours`), that it runs ahead of the night/global/per-repo caps, and that it fails closed.
- The full config block from the spec's *Configuration* section, verbatim.
- The `budget-exhausted` and `budget-unknown` skip reasons as they appear in `--dry-run` and `--json`.
- The calibration procedure: run for a week, read `bridge dispatch status` against `/usage`, and pin `window_budget_usd` and `mean_run_cost_usd`.
- The three known approximations from the spec (rolling window vs. real reset, cost booked at dispatch time, hand-labelled runs and retries uncounted).
- The upgrade note: `dispatch_at`/`retry_until` are retired and ignored; reinstall the timer with `systemctl --user daemon-reload && systemctl --user restart bridge-dispatch.timer` for the windows to take effect.

- [ ] **Step 3: Update the changelog**

Under `## [Unreleased]` → `### Added` in `CHANGELOG.md`:

```markdown
- `bridge dispatch`: usage-budget rung reserving subscription headroom for
  interactive work during the day, measured from Claude Code transcripts and a
  local ledger of dispatched runs (#254)
- `bridge dispatch status`: trailing-window usage, limit, and utilization
```

and under `### Changed`:

```markdown
- `bridge dispatch`: dispatch hours moved from the systemd timer into
  `schedule.windows` in `dispatch.json`; the timer is now an hourly heartbeat.
  The retired `dispatch_at`/`retry_until` keys are ignored (#254)
```

- [ ] **Step 4: Verify the docs match the code**

Run: `bridge dispatch status` after `just build`, and confirm the printed budget lines match what `docs/dispatch.md` documents. Then re-run every gate:

```bash
gofmt -l . && go vet ./... && golangci-lint run && go test -race ./... && govulncheck ./...
```

Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add docs/dispatch.md docs/systemd/bridge-dispatch.timer CHANGELOG.md
git commit -m "docs(dispatch): document the usage-budget rung and hourly timer"
```

---

## Manual verification (after Task 8)

The rung's constants are empirical, so it is not finished until calibrated. Not a code task — an operator procedure.

- [ ] Run `bridge dispatch --dry-run` at midday and confirm the decisions show either dispatches or a `budget-exhausted`/`budget-unknown` reason.
- [ ] Compare `bridge dispatch status` against `/usage` in an interactive session at a few points across one 5h window, and pin `window_budget_usd`.
- [ ] After a handful of real pipeline runs, compare their reported `**Cost:**` values in the run-report comments against `mean_run_cost_usd` and adjust.
- [ ] Only then: `systemctl --user daemon-reload && systemctl --user restart bridge-dispatch.timer`, and confirm with `systemctl --user list-timers` that it fires hourly.
