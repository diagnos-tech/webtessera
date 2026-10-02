# ADR-0064: `client/fetcher.go`'s `FileFetcher` is not ported

- **Status:** proposed
- **Date:** 2026-08-19
- **Author:** client contributor
- **Upstream reference:** `client/fetcher.go` (`FileFetcher`)

## Context

`client/fetcher.go` defines two fetcher implementations. `HTTPFetcher` fetches log
artifacts over HTTP. `FileFetcher` fetches them from a local POSIX filesystem:

```go
type FileFetcher struct {
	Root string
}

func (f FileFetcher) ReadCheckpoint(_ context.Context) ([]byte, error) {
	return os.ReadFile(path.Join(f.Root, layout.CheckpointPath))
}
func (f FileFetcher) ReadTile(ctx context.Context, l, i uint64, p uint8) ([]byte, error) {
	return fetcher.PartialOrFullResource(ctx, p, func(ctx context.Context, p uint8) ([]byte, error) {
		return os.ReadFile(path.Join(f.Root, layout.TilePath(l, i, p)))
	})
}
```

`PORTING.md` §7 is explicit: "No Node built-ins (`node:crypto`, `node:buffer`, `node:fs`).
This code runs on the edge", and `FileFetcher` is built entirely out of `os.ReadFile` and
`path.Join` — a POSIX filesystem is exactly what a browser tab or a Cloudflare
Worker/Durable Object (this port's actual targets, per `PORTING.md` §1) does not have.

`PORTING.md` §2's directory layout already assigns the equivalent role to a different,
purpose-built package: `src/storage/memory/` is described as "NEW (web): in-memory
driver, **the `posix` of the browser**" — i.e. the web-native stand-in for exactly the
local/offline, no-network storage role `FileFetcher` plays in Go, but implemented without
a real filesystem underneath it. That package is Wave 4's responsibility, not this one's.

## Decision

`FileFetcher` is not ported. `HTTPFetcher` is ported in full (`src/client/fetcher.ts`),
using the standard `fetch` and `URL` globals in place of `net/http` and `net/url` — these
are available unmodified in a browser tab, in Node, and in workerd, which is exactly the
portability `PORTING.md` §1 asks this whole package for.

## Consequences

- `src/client/fetcher.ts` exports `HTTPFetcher`/`newHTTPFetcher` only; there is no
  `FileFetcher` or `newFileFetcher` symbol, and none of `docs/PORTING-MAP.md`'s row for
  `client/fetcher.go` claims full coverage of it — the row notes this omission and points
  here.
- The "posix of the browser" role stays exactly where PORTING.md §2 already put it
  (`src/storage/memory/`, Wave 4), so there is no functional gap this decision leaves
  unfilled — only a different package fills it, with a different (non-`FileFetcher`-shaped)
  interface appropriate to `Driver`/`LogReader`, not `TileFetcherFunc`.
- Because there is no upstream `fetcher_test.go` either (see
  `docs/decisions/0065-client-log-fixture-reads-static-testdata.md`'s sibling note in
  `client_test.ts` and the mission brief), there was never a test case at risk of being
  silently dropped by this decision — `client/fetcher_test.ts` in this port covers only
  `HTTPFetcher`, by construction, and says so in its header comment.

## Alternatives considered

- **Port `FileFetcher` against application-side Node dependencies.**
  Rejected: `client/fetcher.ts` is library code, and application code bolts onto upstream
  interfaces from the outside (`PORTING.md` §8 says the same of the storage drivers);
  moving a whole upstream type into application code would be the reverse of that, and it would
  still leave `client/fetcher.ts` itself missing the symbol relative to Go's actual
  export list, which is the thing a transparency-dev reviewer would notice.
- **Port `FileFetcher` against an injected filesystem-like interface (e.g. `{ readFile(path):
  Promise<Uint8Array> }`) instead of `node:fs` directly**, letting a Node caller pass a
  real implementation and a browser caller pass nothing. Considered seriously: this would
  keep the exported symbol. Rejected for this ADR because it is genuinely new,
  upstream-has-no-counterpart API surface (Go's `FileFetcher` is concretely POSIX, not
  abstracted), and because `src/storage/memory` already exists specifically to be this
  package's local/offline story — inventing a second one here would fork that
  responsibility across two packages. If a future package wants this shape, it should
  get its own ADR built around what it's actually for, not be smuggled in here to make a
  Go-vs-TypeScript symbol diff look smaller.
- **Skip `HTTPFetcher` too, and port neither.** Rejected: `HTTPFetcher` is the fetcher
  that actually matters for this port's stated purpose ("lets a browser tab or edge
  worker verify a transparency log", `PORTING.md` §1's mission statement) and has a clean,
  fully-portable translation via `fetch`/`URL`; dropping it would leave the client package
  with no working fetcher implementation at all.

## Review

- **Reviewer:** Client Reviewer
- **Verdict:** approved
- **Notes:** Confirmed against `client/fetcher.go` that `FileFetcher` is built entirely on
  `os.ReadFile`/`path.Join`, which PORTING.md §7 forbids in donatable edge code and which has no
  meaning in a browser/Worker. `HTTPFetcher` is ported in full via `fetch`/`URL`, and its exported
  surface (`HTTPFetcher`, `newHTTPFetcher`, `setAuthorizationHeader`, `readCheckpoint`, `readTile`,
  `readEntryBundle`) matches Go's, minus only `FileFetcher`. The omission is the single missing
  symbol relative to Go's export list and is honestly flagged. Agree the memory driver (Wave 4)
  fills the local/offline role, so no functional gap. The rejected "inject a filesystem interface"
  alternative is the right call — it would be new, upstream-less API surface.
