# ADR-0055: `identityHash` moves to `lifecycle.ts`; `ct_only.ts`'s temporary copy is deleted

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** storage-internal contributor
- **Upstream reference:** `lifecycle.go:101-105`, `ct_only.go`, `docs/decisions/0044-ct-only-partial-port.md`

## Context

`docs/decisions/0044-ct-only-partial-port.md` landed `src/ct_only.ts` with a temporary local copy
of `identityHash`, because `src/lifecycle.ts` — the file that owns it in Go (`lifecycle.go:102`)
— did not exist yet:

> Duplicate `identityHash` in `src/ct_only.ts` for now, marked with a `TODO(<owner>):` that names
> `lifecycle.go:102`, says the copy must be deleted, and records that the shared definition will
> have to be exported from `src/lifecycle.ts` because TypeScript cannot express Go's
> package-private visibility.

That ADR's Consequences section named this exact hand-off: "The Wave 3 append-lifecycle contributor
inherits four jobs: … export `identityHash` from `src/lifecycle.ts`, delete the copy in
`ct_only.ts` …". This work package ports `lifecycle.go` directly (`PORTING.md`'s mission table),
so the blocker ADR-0044 identified is resolved now rather than waiting for Wave 3, and the mission
brief explicitly calls this out: "go delete the duplicate in `src/ct_only.ts` and switch it to
import from your file."

## Decision

`identityHash` is exported from `src/lifecycle.ts`:

```ts
export function identityHash(data: Uint8Array): Uint8Array {
	return sha256(data);
}
```

byte-identical to both the deleted `ct_only.ts` copy and Go's `sha256.Sum256(data)`.
`src/entry.ts` (this work package's own file, `entry.go:68`: `h := identityHash(e.internal.Data)`)
imports it from `./lifecycle`. `src/ct_only.ts`'s local copy and its `TODO(<owner>):` doc comment
are deleted; its two call sites (`ctBundleIDHasher`'s x509 and precert branches) now import
`identityHash` from `./lifecycle` instead. The file's top-of-file comment, which described the
duplication, is updated to record that it has been resolved and by which ADR.

`ct_only_test.ts` is unchanged (it exercises `identityHash` only indirectly, through
`ctBundleIDHasher`'s output) and re-run to confirm the switch is behaviourally invisible: same 25
cases, same result.

## Consequences

- Closes one of the four items ADR-0044 left for whoever ports the append-lifecycle package.
  `docs/decisions/0044-ct-only-partial-port.md` itself is left unmodified (an ADR record is a
  historical decision, not a living TODO list) — this ADR is the record that the identityHash item
  specifically is done, and `ct_only.ts`'s own comments are updated to point here.
- `identityHash` is now a single definition with two importers (`entry.ts`, `ct_only.ts`), closing
  off the only way the two hashes could have drifted apart.
- The other three ADR-0044 items — `NewCertificateTransparencyAppender`, `convertCTEntry`, both
  `WithCTLayout` methods — remain genuinely blocked on `append_lifecycle.go`'s `Appender`/
  `AppendOptions` (this work package ports only `AddFn`/`IndexFuture`/`Index` from that file, per
  `docs/decisions/0054-append-lifecycle-partial-port.md`) and `migrate.go`'s `MigrationOptions`,
  neither of which exists yet. `ct_only.ts`'s row in `docs/PORTING-MAP.md` stays `in progress`.

## Alternatives considered

- **Leave the duplicate in place and only add the lifecycle.ts export.** Rejected: this is
  precisely the drift risk ADR-0044 flagged as the reason the duplication was temporary in the
  first place ("the risk is only that it is forgotten, which the TODO and this ADR exist to
  prevent"); leaving it in place after the blocker is gone would be exactly that forgetting.

## Review

- **Reviewer:** Storage-Internal Reviewer
- **Verdict:** approved
- **Notes:** Verified `identityHash(data) = sha256(data)` matches `lifecycle.go:102-105`
  (`h := sha256.Sum256(data); return h[:]`) byte-for-byte, and that it is now a single
  exported definition in `lifecycle.ts` imported by both `entry.ts` (`newEntry`) and
  `ct_only.ts` (`ctBundleIDHasher`'s two branches) — no duplicate remains (grep confirms).
  `lifecycle_test.ts` pins `identityHash === sha256`. Closes exactly one of ADR-0044's four
  items; the other three correctly remain deferred (see ADR-0059, which lands `convertCTEntry`).
