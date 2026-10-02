# ADR-0057: `errors.Join` ported to `gostd/errors.ts` as `joinErrors`

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** storage-internal contributor
- **Upstream reference:** `storage/internal/integrate.go` (`tileWriteCache.Err`), Go's `errors` package (`errors.Join`)

## Context

`tileWriteCache.Err()` aggregates every error the write-cache's Visitor recorded during a single
integration pass:

```go
type tileWriteCache struct {
	m   map[TileID]*populatedTile
	err []error
	...
}

func (tc *tileWriteCache) Err() error {
	return errors.Join(tc.err...)
}
```

`errors.Join` (Go 1.20+) is not covered by `docs/decisions/0004-errors-context-and-concurrency.md`,
which maps `errors.Is`/`errors.As`/`fmt.Errorf("%w")` but not the multi-error `Join`/
`Unwrap() []error` fan-out — that ADR's review notes explicitly call this out as a known,
previously-unneeded gap: "`errorIs`/`errorAs` do not handle the Go 1.20 multi-error
`Unwrap() []error` fan-out (Tessera wraps single errors only)". `tileWriteCache.Err` is the first
real caller in this port that needs `Join` specifically, so per `PORTING.md` §3.5.1 ("If one of
them is missing something you need, add it there with tests. Do not write a local copy"), it
belongs in `gostd/errors.ts` rather than as a one-off local helper in `integrate.ts`.

`docs/decisions/0052-tilewritecache-visitor-is-synchronous.md` explains that, given this work
package's own invariants, `tc.errs` is never actually populated by `integrate()`'s real call path
— but `tileWriteCache` is a general-purpose class parameterised by a caller-supplied `getTile`
(preserved faithfully; see that ADR), and `Err()`/`err()` is directly asserted by the ported
`TestTileVisit`, so the aggregation machinery is real, tested surface regardless of whether this
specific caller ever exercises the error path.

## Decision

`joinErrors` and its return type `JoinError` are added to `src/internal/gostd/errors.ts`:

```ts
export class JoinError extends Error {
	readonly errors: readonly unknown[];
	constructor(errors: readonly unknown[]) {
		super(errors.map((e) => (e instanceof Error ? e.message : String(e))).join("\n"));
		this.name = "JoinError";
		this.errors = errors;
	}
}

export function joinErrors(errs: readonly unknown[]): Error | undefined {
	const filtered = errs.filter((e) => e !== undefined && e !== null);
	if (filtered.length === 0) return undefined;
	return new JoinError(filtered);
}
```

This mirrors Go's `(*joinError).Error()`, which concatenates each wrapped error's message with a
newline between them, and Go's nil-filtering (`errors.Join` counts only non-nil errors; if none
remain, it returns `nil`). `JoinError.errors` mirrors Go's `Unwrap() []error`, which is what lets
`errors.Is`/`errors.As` walk into a joined error's members — `errorIs`/`errorAs` in this file do
not currently walk `JoinError.errors` (they follow `.cause` only, per the existing single-error
chain), which is the same known, documented gap `docs/decisions/0004-errors-context-and-concurrency.md`
already accepted; nothing in this work package calls `errorIs`/`errorAs` on a `JoinError`, so nothing
regresses, and `errors` is exposed publicly (not `#private`) precisely so a future caller that
does need it can walk it directly without this file changing again.

`storage/internal/integrate.ts`'s `tileWriteCache.err()` calls `joinErrors(this.errs)` directly.

`errors_test.ts` gains five cases: empty input, all-nullish input, multi-error message joining,
`.errors` carrying the filtered list, and a non-`Error` entry stringified the way Go's `%v` would
render it — all added to the existing file, not a new one, matching how `errors_test.ts` already
covers every other export of this module in one place.

## Consequences

- `gostd/errors.ts` grows one more export; every other work package that already imports from it
  is unaffected (existing exports and their behaviour are untouched).
- `tileWriteCache.err()`'s message text, when it *does* fire, now matches Go's `(*joinError).Error()`
  exactly (newline-joined messages), which matters if a future caller ever surfaces this error to
  a user or asserts on its text.

## Alternatives considered

- **A local, `integrate.ts`-only join helper.** Rejected by `PORTING.md` §3.5.1's explicit
  instruction not to write a local copy of a Go-stdlib-shaped facility gostd is missing — "four
  private `bytesEqual`s is exactly the incoherence this directory prevents," and the same applies
  to a private `joinErrors`.
- **Skip `errors.Join` entirely and have `Err()` return only the first error.** Rejected: it is a
  real behavioural divergence from Go (`errors.Join`'s whole point is reporting *every* recorded
  error, not just the first), and `TestTileVisit`'s assertions on `Err()` — even though the
  current test data never populates more than zero errors — would silently lose fidelity for any
  future test or caller that does.

## Review

- **Reviewer:** Storage-Internal Reviewer
- **Verdict:** approved
- **Notes:** Verified `joinErrors` mirrors `errors.Join`: nil/undefined-filtering, `undefined`
  return when nothing remains (Go's `nil`), and newline-joined messages matching
  `(*joinError).Error()`. `JoinError.errors` exposes the joined list (Go's `Unwrap() []error`)
  for a future caller. `tileWriteCache.err()` calls it. Consistent with PORTING.md §3.5.1 (add
  to gostd, not a local copy). The documented gap — `errorIs`/`errorAs` don't yet walk
  `JoinError.errors` — is inherited from ADR-0004 and unexercised here (nothing in scope calls
  `errorIs` on a `JoinError`), so nothing regresses.
