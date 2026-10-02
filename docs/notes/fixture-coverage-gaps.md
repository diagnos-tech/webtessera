# Fixture coverage gaps

What the golden fixture generator (`fixtures/gen/`) could **not** reach, and why. Nothing in
`fixtures/data/` is approximated or hand-written; if a case is missing it is missing for one of the
reasons below.

Companion to `fixtures/README.md` and `docs/decisions/0006-golden-fixtures-from-go.md`.

---

## 1. `ctonly` leaf indices at or above 2^40 — no recordable value

`ctonly/ct.go` embeds the leaf index in a 40-bit SCT extension:

```go
if c.LeafIndex >= 1<<40 {
    b.SetError(errors.New("leaf_index out of range"))
    return
}
```

`LeafData` and `MerkleTreeLeaf` then call `b.BytesOrPanic()`, so out-of-range indices **panic**
rather than return an error. There is no marshalled value and no error return to record.

`ctonly.json` records the indices that are out of range in a `panicIndices` list, and the largest
legal index (`2^40 - 1`) is covered as a normal case. A port must decide how to surface the failure;
whatever it chooses is a divergence needing its own ADR, because throwing where Go panics is not the
same thing as Go's error contract.

## 2. `api.HashTile.MarshalText` error branch — unreachable

```go
if _, err := r.Write(n); err != nil {
    return nil, err
}
```

`r` is a `*bytes.Buffer`, whose `Write` never returns a non-nil error. The branch is dead code. No
fixture can exercise it, and a port that omits the error return is faithful. `api_hash_tile.json`
therefore has no `marshal` error cases, only `unmarshal` ones.

## 3. `layout.Range` early termination — not expressible in JSON

`Range` returns an `iter.Seq[RangeInfo]`, and `appendImpl`'s `if !yield(ri) { return }` lets a
consumer stop iteration early. A fixture can only record the full sequence a consumer that never
stops would see. Early termination is a property of the language's iterator protocol, not of Tessera,
and the port's `Generator<RangeInfo>` gets it from JavaScript for free.

## 4. Cloud storage drivers — no infrastructure

The full-log fixtures (`log_<N>.json`) are built with `storage/posix`, the only driver that runs
locally with no external service. `storage/gcp` needs Spanner and GCS, `storage/aws` needs S3 and
MySQL, `storage/mysql` needs MySQL.

This is not a coverage hole in the *format*: every driver writes tiles and bundles through the same
`storage/internal` sequencer and the same `api/layout` paths, so the bytes are driver-independent by
construction. What is not covered is driver-specific behaviour — and webtessera does not port any of
those drivers. Its drivers (memory, IndexedDB, Durable Object, S3) are new and are validated against
the `log_<N>.json` fixtures instead.

## 5. Witnessed / cosigned checkpoints — needs live witnesses

`tessera.WithWitnesses` contacts witness HTTP endpoints and collects cosignatures in the
`formats/note` cosignature-v1 format, which carries a timestamp — non-deterministic even if witnesses
were available.

`checkpoint.json` covers the *wire shape* of a multiply-signed checkpoint: `size 8, log and witness`
is a real note with two signatures from two different keys, parsed through `ParseCheckpoint` with and
without the second verifier supplied. What it does not cover is the cosignature-v1 timestamped
signature format from `formats/note/note_cosigv1.go`.

If webtessera ports witnessing, that needs its own generator case with a pinned timestamp — probably
by calling the cosignature signer directly rather than by running the witness protocol.

## 6. Log sizes above a few thousand entries — infeasible to build, not needed

The largest end-to-end log fixture is 5000 entries (`log_5000.json`, ~446 kB of JSON). Building a log
near `2^32`, never mind `2^64`, is not possible.

The boundary behaviour that actually matters at those sizes lives in pure functions, and those *are*
covered up to `math.MaxUint64`:

- `layout_paths.json` / `layout_tile.json` — path construction and tile geometry at `MaxUint64`;
- `layout_parse.json` — the `i > (math.MaxUint64-n)/1000` overflow guard in `ParseTileIndexPartial`,
  from both sides;
- `compact_range.json` — `RangeNodes` / `RangeSize` / `Decompose` over ranges reaching `MaxUint64`;
- `proof_inclusion.json` / `proof_consistency.json` — `proof.Inclusion` and `proof.Consistency` node
  IDs for trees of size `MaxUint64`.

What is genuinely untested is a *hash* over a tree of that size, which no implementation of anything
can produce.

## 7. `note.Open`'s unexported error identities

`Open` returns three exported error types (`UnverifiedNoteError`, `InvalidSignatureError`,
`UnknownVerifierError`) and several unexported sentinels (`errMalformedNote`, `errInvalidSigner`,
`errMismatchedVerifier`) that callers can only distinguish by message text.

`note.json` records both `wantErrMsg` and a `wantErrKind` naming the exported type where there is
one, and `"error"` otherwise. A port cannot be checked against Go's *identity* for the unexported
ones, only against their message — which is what upstream's own tests do too.

`errMismatchedVerifier` in particular is only reachable through a `Verifiers` implementation that
returns a verifier whose name or hash differs from the one requested. `note.VerifierList` cannot do
that, so reaching it requires a custom `Verifiers`, which has no wire representation to record. It is
not covered.

## 8. `internal/parse.CheckpointUnsafe` — no direct import, generated fixture deliberately declined

`docs/PORTING-MAP.md` asks for a `parse_checkpoint_unsafe` generator case. The generator does not
produce one. A plain *import* is blocked, and the one linker-level workaround that does work is
declined on the merits (see below).

`internal/parse` sits under `github.com/transparency-dev/tessera/internal/`, and Go only lets
packages under `github.com/transparency-dev/tessera/` import it. The generator's module path is
`github.com/meddeck/webtessera/fixtures/gen`, so the compiler rejects a direct import outright:

```
probe_internal.go:3:8: use of internal package github.com/transparency-dev/tessera/internal/parse not allowed
```

The `replace` directive does not change this — the rule is evaluated on import paths, not on disk
locations. Nothing exported by Tessera reaches `CheckpointUnsafe`: `storage/posix` calls it but does
not expose it.

Four ways out, none of them taken:

- Give the generator a module path under `github.com/transparency-dev/tessera/`. Squatting on
  upstream's namespace in a codebase intended for donation to upstream — no.
- Add a forwarding shim inside the upstream checkout. Modifying the pinned source destroys the
  "check out `4a6d9f9`, regenerate, diff" audit.
- Copy `CheckpointUnsafe` into the generator. That is hand-writing the expected behaviour, which is
  the one thing these fixtures exist to avoid.
- **`go:linkname` the symbol.** This one actually works, and calls the *real* upstream function
  rather than a copy: `internal/parse` is already linked into the generator binary transitively
  through `storage/posix` (which `log.go` imports), so a bodyless declaration plus
  `//go:linkname checkpointUnsafe github.com/transparency-dev/tessera/internal/parse.CheckpointUnsafe`
  and `import _ "unsafe"` resolves at link time. The reviewer confirmed this empirically: it
  reproduces upstream's output for all four branches, including the empty-origin line that
  `CheckpointUnsafe` accepts and `formats/log`'s `Unmarshal` rejects. It is declined anyway, for two
  reasons. (1) It adds no coverage: `CheckpointUnsafe` is a 15-line function with exactly four
  branches — 4-part split failure, size parse failure, hash decode failure, and success — and
  upstream's own `parse_test.go` table (ported verbatim in `parse_test.ts`, including the
  empty-origin *accept* case) exercises every one of them, so a golden fixture would assert nothing
  the ported table does not already assert. (2) Reaching into an upstream *internal* package through
  the linker is exactly the kind of fragile hack a generator meant for donation to that upstream
  should not carry; it also relies on `storage/posix` continuing to pull `internal/parse`
  transitively, an implementation detail that is not part of any contract.

**Mitigation.** `src/internal/parse/parse_test.ts` ports upstream's own `parse_test.go` table,
including its three rejection cases, so the rejection behaviour is covered by the same assertions
upstream makes. `parse_fixtures_test.ts` additionally cross-checks the accepted path against
`checkpoint.json`. What is genuinely uncovered is any rejection upstream's own test does not
exercise — where the two parsers deliberately disagree (`CheckpointUnsafe` accepts an empty origin
line, `formats/log`'s `Unmarshal` does not), only upstream's table stands behind the port.

This gap would close by itself if the generator ever moved into the Tessera tree, which is the
expected end state if this port is donated.

## 9. Go's wrapping `uint64` arithmetic is recorded, not avoided

`compact.NodeID.Coverage()` computes `index << level`, which overflows silently for large inputs;
`compact_range.json` records the wrapped result Go produces. A `bigint` port does not wrap and must
mask to 64 bits to match.

This is listed here not as a gap but as a warning: the fixture is right, and a port that produces the
mathematically larger number is wrong. See ADR-0006.
