# ADR-0044: `ct_only.ts` lands without its append-lifecycle half, and temporarily carries its own `identityHash`

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** ct agent
- **Upstream reference:** `ct_only.go`, `lifecycle.go:101-105`, `entry.go`, `append_lifecycle.go`, `migrate.go`

## Context

`ct_only.go` is one Go file straddling two work packages. Three of its declarations are pure
byte-level functions with no dependency beyond `layout` and `cryptobyte`, and the tests in
`ct_only_test.go` exercise exactly those. The rest reaches into the append lifecycle:

```go
func NewCertificateTransparencyAppender(a *Appender) func(context.Context, *ctonly.Entry) IndexFuture
func convertCTEntry(e *ctonly.Entry) *Entry
func (o *AppendOptions) WithCTLayout() *AppendOptions
func (o *MigrationOptions) WithCTLayout() *MigrationOptions
```

`Appender` and `IndexFuture` come from `append_lifecycle.go`, `AppendOptions` from the same file,
`MigrationOptions` from `migrate.go`, and `Entry` from `entry.go`. None of those has been ported;
`src/append_lifecycle.ts`, `src/migrate.ts` and `src/entry.ts` belong to the Wave 3 append-lifecycle
package and do not exist.

`convertCTEntry` is the tightest coupling of the four. It does not merely take an `*Entry` — it
writes the struct's *unexported* `internal.Identity` field and installs its `marshalForBundle` hook:

```go
r := &Entry{}
r.internal.Identity = e.Identity()
r.marshalForBundle = func(idx uint64) []byte {
	r.internal.LeafHash = e.MerkleLeafHash(idx)
	r.internal.Data = e.LeafData(idx)
	return r.internal.Data
}
```

There is no way to write that without the real `Entry`, and guessing at its shape would hand the
Wave 3 agent a fake to reconcile against.

Separately, `ctBundleIDHasher` calls `identityHash`, which lives in `lifecycle.go`:

```go
// identityHash calculates the antispam identity hash for the provided (single) leaf entry data.
func identityHash(data []byte) []byte {
	h := sha256.Sum256(data)
	return h[:]
}
```

It is package-private and shared by `entry.go`, `lifecycle.go` and `ct_only.go` — three files in one
Go package. TypeScript has no package-private visibility and no cross-file sharing without an
`export`, so `src/lifecycle.ts` will have to export it, and `src/lifecycle.ts` does not exist yet.

Finally, `ct_only_test.go` is an in-package test. It calls `ctEntriesPath`, `ctBundleIDHasher` and
`ctMerkleLeafHasher`, all lower-case and therefore unexported in Go.

## Decision

**Port the standalone half now.** `src/ct_only.ts` contains `ctEntriesPath`, `ctBundleIDHasher`,
`copyBytes`, `copyUint16LengthPrefixed`, `copyUint24LengthPrefixed` and `ctMerkleLeafHasher`, in
upstream's declaration order, with `ct_only_test.go` ported in full.

**Leave the append-lifecycle half as three `TODO(<owner>):` comments and no code**, each naming the
upstream symbol, its line, and the file that will provide it. No placeholder types, no stub
interfaces: an invented `AppendOptions` would be worse than an absence, because it would compile.
The comments sit at the top of the file in the position their Go declarations occupy, so the file
still reads in upstream order.

Note that the two `WithCTLayout` methods need nothing new from this package — the three functions
they install are all present — so the Wave 3 agent's remaining work is to add the option structs and
wire them up.

**Duplicate `identityHash` in `src/ct_only.ts` for now**, marked with a `TODO(<owner>):` that names
`lifecycle.go:102`, says the copy must be deleted, and records that the shared definition will have
to be **exported** from `src/lifecycle.ts` because TypeScript cannot express Go's package-private
visibility. It is three lines and behaviourally unambiguous (`sha256` of the input), so the
duplication cannot drift semantically; the risk is only that it is forgotten, which the `TODO` and
this ADR exist to prevent. The alternative — importing from a module that does not exist — would
have broken the whole test suite for every other agent working in parallel.

**Export the three functions that are unexported in Go.** `ctEntriesPath`, `ctBundleIDHasher` and
`ctMerkleLeafHasher` are `export`ed so that `src/ct_only_test.ts` can reach them, which is the
general consequence of Go's in-package tests having no TypeScript equivalent. They are not
re-exported from the package's public entry points, so they stay off the published API surface.

Error text is preserved verbatim, including upstream's asymmetries, because they are what a reader
debugging a malformed bundle will grep for:

- `ctBundleIDHasher` says `unknown entry type at entry index %d` while `ctMerkleLeafHasher` says
  `unknown entry type 0x%x at entry index %d` — the first omits the value. Ported as-is.
- `ctBundleIDHasher` says `failed to read …` where `ctMerkleLeafHasher` says `failed to copy …` for
  the same field. Ported as-is.

Go's `sha256.Size` becomes noble's `sha256.outputLen`, the direct equivalent.

`src/ct_only_test.ts` adds a `bundle parser errors` block beyond the three upstream tests, reaching
every error branch in both parsers. One of those tests documents a behaviour worth knowing: the
`unexpected %d bytes of trailing data` check is only reachable after the loop has consumed
`EntryBundleWidth` entries, because before that the trailing bytes are read as the start of the next
entry and fail there instead. A second block asserts both parsers against
`fixtures/data/ctonly.json`, feeding them Go-produced leaf data and requiring the identity hashes
and Merkle leaf hashes Go recorded.

## Consequences

- `src/ct_only.ts` is incomplete and must not be marked `done` in `docs/PORTING-MAP.md` until the
  three `TODO(<owner>):` blocks are resolved. Its row says `in progress` and names this ADR.
- The Wave 3 append-lifecycle agent inherits four jobs: port the three deferred declarations, export
  `identityHash` from `src/lifecycle.ts`, delete the copy in `ct_only.ts`, and port the
  `WithCTLayout` methods onto their option structs.
- Until then, nothing can actually *append* to a CT log through this package. The bundle parsers and
  the entry encoders are usable standalone — which is what an antispam follower or a migration
  source needs — but the appender entry point is absent.

## Alternatives considered

- **Wait for Wave 3 and port `ct_only.go` in one piece.** Rejected: it would leave `ctonly/ct.ts`,
  `cryptobyte.ts` and both bundle parsers unported and unreviewed for the duration, and those are
  the parts with the byte-level risk. The original work plan explicitly lists this package as
  runnable at any time.
- **Stub `AppendOptions`, `Appender` and `Entry` so the file compiles whole.** Rejected, and
  explicitly forbidden by the work package. A stub that compiles is a stub that gets built on, and
  the real `Entry` has unexported fields whose shape cannot be guessed.
- **Import `identityHash` from a not-yet-existing `./lifecycle`.** Rejected: it fails at module
  resolution, breaking the test run for everyone working in the repository concurrently.
- **Inline `sha256(data)` at both call sites and drop the helper.** Rejected: it erases the name
  `identityHash`, which is what makes the Wave 3 substitution a one-line change and what tells a
  reader that these two hashes are the antispam identity and not some other digest.
- **Put `identityHash` in `src/internal/gostd/`.** Rejected: it is Tessera domain logic, not a Go
  standard-library facility. `gostd/` is for what TypeScript lacks, not for what has not landed yet.

## Review

- **Reviewer:** CT Reviewer (opus)
- **Verdict:** approved
- **Notes:** Diffed `src/ct_only.ts` line-by-line against `ct_only.go` @ `4a6d9f9`
  (read in full, including the four deferred declarations). Confirmed the partial-port
  decision was executed correctly:
  - No fake/placeholder type was invented. `Appender`, `IndexFuture`, root `Entry`,
    `AppendOptions`, `MigrationOptions` are absent, not stubbed — the file compiles because
    the deferred declarations are `TODO(<owner>):` comments, not code.
  - Each `TODO(<owner>):` names the exact upstream symbol, its line
    (`ct_only.go:38/47/60/67`), and the future file that will provide it
    (`append_lifecycle.ts`, `entry.ts`, `migrate.ts`) — precise enough to grep and wire up.
  - `identityHash` duplication is genuinely necessary (importing a non-existent
    `./lifecycle` would break module resolution for every concurrent agent), is clearly
    marked temporary with a `TODO(<owner>):` naming `lifecycle.go:102`, and is byte-correct:
    verified `lifecycle.go:102` is `sha256.Sum256(data)`, and the TS is `sha256(data)`.
  - `copyBytes`, `copyUint16LengthPrefixed`, `copyUint24LengthPrefixed` all return `boolean`
    for success (not throwing) — the Go parser-loop shape is preserved.
  - Every error message is verbatim, including the two upstream asymmetries: `ctBundleIDHasher`
    omits the entry-type value (`unknown entry type at entry index %d`) while
    `ctMerkleLeafHasher` includes it (`unknown entry type 0x%x …`), and `read …` vs `copy …`.
    `sha256.Size` → `sha256.outputLen` is correct (both 32).
  - The unreachable-trailing-bytes claim is accurate: both parsers loop
    `i < EntryBundleWidth && !b.Empty()`, so the `unexpected %d bytes of trailing data`
    branch is only reachable after 256 entries are consumed; below that, extra bytes are
    parsed as the next entry and fail there. `ct_only_test.ts` pins **both** paths (the
    256-entries-plus-2-bytes trailing case and the 1-entry-plus-2-bytes "failed to read/copy
    timestamp of entry index 1" case).
  - Golden-fixture cross-checks in `ct_only_test.ts` feed Go-produced `leafData` into both
    parsers and assert against Go-recorded `identity`/`merkleLeafHash` — real, non-vacuous.
  Three upstream tests (`TestCTEntriesPath`, `TestCTIdentityHasher`, `TestCTMerkleLeafHasher`)
  are ported with matching cases and values, including the upstream "Preertificate" typo.
  25/25 tests pass. This ADR's own counts are accurate (its "34" note was not present; the
  count error was in ADR-0043 and PORTING-MAP, now fixed).

## Update (2026-10-02)

Status changed from "proposed" to "accepted" on the strength of the approved verdict recorded
above; no new review was made. The temporary items this ADR describes were closed by ADR-0055
(`identityHash`), ADR-0059 (`convertCTEntry`) and ADR-0130 (the rest; still proposed).
