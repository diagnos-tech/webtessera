# ADR-0093: `cmd/fsck/tui/`, `cmd/fsck/internal/tui/` and `cmd/fsck/main.go` are not ported

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** fsck contributor
- **Upstream reference:** `cmd/fsck/main.go`, `cmd/fsck/tui/fsck_panel.go`, `cmd/fsck/tui/layerbar.go`, `cmd/fsck/tui/layerbar_test.go`, `cmd/fsck/tui/stats_view.go`, `cmd/fsck/internal/tui/app.go`

## Context

This resolves the `cmd/fsck/tui/`, `cmd/fsck/internal/tui/` row in
`docs/decisions/0001-scope-and-module-inclusion.md`'s module-inclusion register, which has
sat `pending` since that register was created — this work package is the first to actually
reach `fsck/` with the context needed to make the case. It also covers `cmd/fsck/main.go`,
which has no row of its own yet in that register (only `docs/PORTING-MAP.md` forward-
references one, in its notes column: `"ADR-0001 \`cmd/fsck\` row"`) but is the same kind of
exclusion for the same reason, so this ADR adds that row too rather than leaving a gap.

`fsck/fsck.go` and `fsck/status.go` — ported in this same work package as
`src/fsck/fsck.ts` and `src/fsck/status.ts` — are a **library**: `Fsck`/`newFsck`/`check`/
`status`, with no dependency on a terminal, a process, or CLI flags. Three upstream files
build a command-line *tool* on top of that library:

- **`cmd/fsck/main.go`** (162 lines) parses CLI flags (`flag.String`, `flag.Uint`,
  `flag.Bool`, …) for `--storage_url`, `--bearer_token`, `-N`, `--origin`, `--public_key`,
  `--qps`, `--ui`; constructs a `client.FileFetcher` or `client.NewHTTPFetcher` from a
  `net/url.URL`; reads a public key file from disk via `os.ReadFile`; wires up
  `golang.org/x/time/rate` QPS limiting; and either runs the Bubbletea TUI or falls into a
  `for { select { ... case <-time.After(time.Second): klog.V(1).Infof(...) } }` polling
  loop that logs `f.Status()` once a second.
- **`cmd/fsck/internal/tui/app.go`** (127 lines) wraps `github.com/charmbracelet/bubbletea`
  (`tea.NewProgram`), redirects Go's own `flag`-based logging (`flag.Set("logtostderr",
  "false")`) through an `io.Pipe` so log lines render *above* the TUI rather than
  corrupting it, and drives the Bubbletea event loop against a real TTY.
- **`cmd/fsck/tui/{fsck_panel,layerbar,stats_view}.go`** (539 lines combined, plus
  `layerbar_test.go`) are the Bubbletea view/model code itself: a `lipgloss`-styled panel
  showing per-tile-level progress bars (`layerbar.go`'s `Range`-to-terminal-width mapping),
  a stats view, and the top-level `fsck_panel` compositing them.

## Decision

None of `cmd/fsck/main.go`, `cmd/fsck/tui/**`, `cmd/fsck/internal/tui/**` is ported. The
`cmd/fsck/tui/`, `cmd/fsck/internal/tui/` row in ADR-0001's register moves from `pending` to
**not ported**, citing this ADR. A new row is added for `cmd/fsck/main.go`, also **not
ported**, citing this ADR.

**What capability is lost:** a standalone, interactive command-line tool a human operator
runs against a real log's HTTP or filesystem endpoint, with either a live terminal
dashboard (progress bars per tile level, updated once a second) or a plain logging fallback,
plus CLI-flag-driven configuration (storage URL, bearer token, worker count, QPS limiting,
public key file).

**What replaces it:** nothing directly, and nothing needs to — the capability that matters
for this codebase's actual consumers (`src/adapters/**`, a future diagnos debug UI, or a
transparency-dev reviewer evaluating the library) is `Fsck.check()`/`Fsck.status()`
themselves, which are fully ported, tested, and exported from `src/fsck/index.ts`. Anyone
wanting a terminal or browser dashboard over fsck's progress can poll `status()` (it returns
a `Status` object with `entryRanges`/`tileRanges`/`bytesFetched`/`resourcesFetched`/
`errorsEncountered`, and `Status.toString()` renders the same
`Tiles/N: [a,b):State, ...` / `EntryBdl: ...` text `Status.String()` does in Go) and render
it however suits the host environment — a terminal is simply not one of this port's target
environments (`PORTING.md` §1: "browsers and edge runtimes ... instead of servers"), so there
is no environment left to build a *replacement* TUI for.

## Consequences

- `docs/PORTING-MAP.md`'s six rows for these files (`cmd/fsck/internal/tui/app.go`,
  `cmd/fsck/main.go`, `cmd/fsck/tui/fsck_panel.go`, `cmd/fsck/tui/layerbar.go`,
  `cmd/fsck/tui/layerbar_test.go`, `cmd/fsck/tui/stats_view.go`) move from `pending ADR` to
  `not ported`, citing this ADR, in the same landing that adds this file.
- `charmbracelet/bubbletea` and `charmbracelet/lipgloss` are never added as dependencies —
  consistent with `PORTING.md` §7's dependency allow-list (`@noble/*` only in donatable
  code), and there was never a case for adding them regardless, since neither has any
  meaning without a real TTY.
- `golang.org/x/time/rate` (QPS limiting) and `net/url` flag-parsing wiring are likewise not
  needed; a caller embedding `Fsck` in a browser or Worker context that wants rate-limiting
  can wrap its own `Fetcher` implementation, exactly as `main.go`'s `rateLimitedSrc` wraps
  `fsck.Fetcher` in Go — that wrapping pattern needs no help from this library either way.
- If a future work package wants a debug UI over `fsck`'s progress (the kind of thing
  `PORTING.md` §8 gestures at for `src/adapters/**`), it would poll `Fsck.status()` from
  scratch, not port anything from this exclusion — there is nothing in the excluded Go
  files that transfers to a DOM-rendered progress view; the two rendering models (a
  terminal's fixed-width character grid vs. a web page) do not share implementation, only
  the same underlying `Status` data.

## Alternatives considered

- **Port `cmd/fsck/main.go`'s non-TUI polling branch only, as a Node-only debug CLI.**
  Rejected: this package's stated targets are "browsers and edge runtimes," and a Node CLI
  entry point is a third target this codebase does not otherwise support anywhere (no other
  `cmd/*` has been ported, and the ones still `pending` in ADR-0001 are pending for the same
  reason). Introducing exactly one CLI entry point for this single command would be
  inconsistent with every other `cmd/` exclusion and is not something any current consumer
  (`src/adapters/**`) needs.
- **Port the Bubbletea views as inert data-shaping code, dropping only the actual
  `tea.NewProgram` rendering.** Rejected: `layerbar.go`'s whole job is mapping a `Range` to
  a fixed terminal-column width and a `lipgloss` style/colour — there is no part of it that
  is meaningfully reusable outside a monospace terminal grid; a DOM progress bar would be
  written from scratch against CSS, not adapted from this code.

## Review

- **Reviewer:** Fsck Reviewer
- **Verdict:** approved
- **Notes:** Verified the excluded files exist upstream and the line-count claims are
  accurate: `cmd/fsck/main.go` = 162 lines, `cmd/fsck/internal/tui/app.go` = 127 lines,
  `cmd/fsck/tui/{fsck_panel.go=143, layerbar.go=258, stats_view.go=138}` = 539 combined,
  plus `layerbar_test.go` (113). Confirmed `main.go` is CLI/flag/TTY wiring
  (`flag.String`/`flag.Uint`, `client.FileFetcher`/`NewHTTPFetcher`, `os.ReadFile`,
  `x/time/rate`, bubbletea vs. a 1-second polling loop) with no library logic that isn't
  already in the ported `Fsck.check()`/`.status()`. The exclusion is well-argued and the
  capability-lost/what-replaces-it sections are honest. Also confirmed the scope-register
  update in `docs/decisions/0001-scope-and-module-inclusion.md` is accurate: the
  `cmd/fsck/tui/`, `cmd/fsck/internal/tui/` row now reads **not ported / ADR-0093**, and a
  new `cmd/fsck/main.go` row was added, also **not ported / ADR-0093** — both correctly out
  of `pending`, matching this ADR's Decision. Separately relevant to ADR-0091: `main.go`
  does `ctx, cancel := context.WithCancel(...)` and calls `cancel()` on return (lines 50,
  88, 96), which is exactly the mechanism that masks the upstream goroutine leak ADR-0091
  discusses — corroborated here. No dependency-allowlist violation (bubbletea/lipgloss/
  x/time/rate never added).
