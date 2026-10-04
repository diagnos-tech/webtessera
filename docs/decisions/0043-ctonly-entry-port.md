# ADR-0043: `ctonly.Entry` becomes a class with a field-object constructor, and gains the test file upstream lacks

- **Status:** proposed
- **Date:** 2026-08-19
- **Author:** ct contributor
- **Upstream reference:** `ctonly/ct.go`

## Context

`ctonly.Entry` is a plain struct with four methods, and callers build it with a composite literal
that names only the fields it cares about:

```go
ctonly.Entry{
	Timestamp:         1234,
	IsPrecert:         false,
	Certificate:       testCert,
	FingerprintsChain: testFingerprintsChain,
}
```

The omitted fields take their zero values — `nil` for the three `[]byte`s, `false` for `IsPrecert` —
and every encoder in the file observes only their length, so `nil` and empty are indistinguishable
in the output.

One field has no clean TypeScript analogue: `FingerprintsChain [][32]byte`. Go's `[32]byte` is a
fixed-size **value** type, and `ct.go` copies out of it with `b.AddBytes(f[:])`.

The file also has no test of its own upstream. `ctonly/ct.go` is covered only indirectly, by
`ct_only_test.go` in the root package, which round-trips `LeafData` through the bundle parsers. That
round-trip would pass just as happily against a consistently wrong encoding: if `addUint40` wrote
little-endian, `LeafData` and `ctMerkleLeafHasher` would agree with each other and disagree with
every other CT log on the internet.

## Decision

`Entry` is a class with `readonly` fields, constructed from an all-optional `EntryFields` object:

```ts
export interface EntryFields {
	readonly timestamp?: bigint;
	readonly isPrecert?: boolean;
	readonly certificate?: Uint8Array;
	readonly precertificate?: Uint8Array;
	readonly issuerKeyHash?: Uint8Array;
	readonly fingerprintsChain?: readonly Uint8Array[];
}
```

The constructor fills each absent field with Go's zero value: `0n`, `false`, an empty `Uint8Array`,
an empty array. `EntryFields` is an addition upstream has no counterpart for; it exists solely to
stand in for the composite literal, and it is the reason `new Entry({...})` in the ported tests
looks like `ctonly.Entry{...}` in the Go ones.

A class rather than an interface plus free functions, because `LeafData`, `MerkleTreeLeaf`,
`MerkleLeafHash` and `Identity` are methods in Go and PORTING.md §3.2 maps a Go method to a method.

`FingerprintsChain [][32]byte` becomes `readonly Uint8Array[]`. TypeScript cannot express a
32-element byte array as a type, and inventing a branded `Hash32` would spread through every caller
to buy a check that no upstream caller performs either — `ct.go` never validates the length, it just
appends. The 32-byte-ness is enforced where it actually matters, by SHA-256 producing the values.
Consequently the port cannot reject a malformed chain that Go's type system would have rejected at
compile time; the entry-bundle format has no per-fingerprint length prefix, so such a chain produces
a bundle no parser can split. This is a real, if narrow, loss of safety and is recorded as such.

`Identity()` returns noble's `sha256(...)` output directly rather than copying out of a
`[sha256.Size]byte` array, since noble already returns a fresh `Uint8Array`.

`Entry.timestamp` and the `idx`/`leafIndex` parameters are `bigint` (`uint64`, ADR-0003).
`addUint40` therefore takes a `bigint` and masks with `& 0xffn`, which is the only way to get bits
32..39 right — a `number`-based shift would truncate to 32 bits and silently zero the top byte of
the leaf index.

**A new `src/ctonly/ct_test.ts` is added, with no upstream counterpart.** It pins:

- the exact hex of `leafData` and `merkleTreeLeaf` for x509 and precert entries, including that the
  fingerprints chain and the precertificate appear in the bundle entry but **not** in the
  MerkleTreeLeaf;
- `merkleLeafHash` as `sha256(0x00 ‖ merkleTreeLeaf)`;
- `identity` selecting the precertificate when `isPrecert`, the certificate otherwise;
- the 40-bit leaf-index encoding at eight indices chosen so that each of the five byte positions
  carries a distinct value — a little-endian or 32-bit-wide `addUint40` fails at least one of them;
- the `leaf_index out of range` error at `1 << 40`.

It then asserts byte-equality against `fixtures/data/ctonly.json`, whose 34 cases were produced by
executing upstream `ctonly.Entry` (see `fixtures/gen/ctonly.go`), covering the index axis up to
`2^40 - 1`, the timestamp axis up to `MaxUint64`, empty and multi-kilobyte certificates, and
chains of 0, 1, 2, 3 and 8 fingerprints.

## Consequences

- `new Entry({...})` costs one object literal that Go does not need. In exchange, an entry cannot be
  half-constructed: there is no equivalent of assigning `IsPrecert = true` and forgetting
  `Precertificate`, because the fields are `readonly`.
- `EntryFields` is exported API that upstream does not have. If Tessera later adds a field to
  `Entry`, it has to be added in two places here.
- A test file that does not exist upstream will draw a reviewer's attention. The header comment on
  `ct_test.ts` states the reason: these bytes go on the public CT wire, and the upstream round-trip
  test cannot detect an encoding that is wrong in the same way on both sides.

## Alternatives considered

- **A plain interface plus free functions `leafData(e, idx)`.** More idiomatic for a data-only type.
  Rejected: it renames four upstream methods into free functions, breaking the parallel reading of
  `ct.go`, and it separates the encoders from the data they are specified against.
- **A constructor with six positional parameters.** Rejected: `new Entry(1234n, false, cert, empty, empty, chain)`
  is exactly the transposition hazard the composite literal exists to avoid, and the two adjacent
  `Uint8Array` fields (`precertificate`, `issuerKeyHash`) make it worse.
- **Mutable public fields assigned after construction, mirroring Go most literally.** Rejected: it
  permits partially-initialised entries and defeats `readonly`, for no gain in reviewability.
- **A branded 32-byte type for the fingerprints chain.** Rejected as described above: cost spread
  across every caller, benefit not present upstream.
- **Relying only on the golden fixtures and writing no hand-computed expectations.** Rejected: the
  fixture proves agreement with Go, but the hand-computed hex in `ct_test.ts` documents *what the
  format is*, which is what a reader needs when a fixture regenerates and changes.

## Review

- **Reviewer:** CT Reviewer
- **Verdict:** approved
- **Notes:** Diffed `src/ctonly/ct.ts` line-by-line against `ctonly/ct.go` @ `4a6d9f9`
  (read in full). Every method and field maps under the ADR-0002 rule, declaration order
  matches, and every upstream comment is preserved. The `Entry`-as-class / `EntryFields`
  decision is sound and does not change the wire bytes. `addUint40` is a correct big-endian
  uint40 (`& 0xffn` masking on `bigint`, MSB first); `ct_test.ts`'s index `0x0102030405`
  case gives all five byte positions distinct values, so it alone pins byte order and width,
  and the boundary cases (`0xff`, `0x100`, `0xffffffff`, `0x100000000`, `2^40-1`) exercise
  each position individually — a little-endian or 32-bit-wide encoder fails at least one.
  The `1n << 40n` bound and the `leaf_index out of range` error text match Go exactly, and
  the error propagates through `bytesOrPanic` the way Go propagates through `BytesOrPanic`.
  Corrected one factual error in this ADR: the fixture has **34** cases, not 40 (counted
  `fixtures/data/ctonly.json`). Independently reconstructed all 34 fixtures' `leafData`,
  `merkleTreeLeaf`, `merkleLeafHash` and `identity` from the raw input fields per
  RFC 6962 / static-ct-api (0 mismatches), confirming the golden tests are non-vacuous and
  the fixture is byte-correct, not merely self-consistent with the code under test.
  52/52 tests in `ct_test.ts` pass.

## Update (2026-10-04)

The loss of safety recorded above (a fingerprint that is not 32 bytes reaches the encoder) is now closed at the point it
matters: `Entry.leafData` throws `RangeError("ctonly: fingerprintsChain[<i>] is <n> bytes, want 32")` before encoding
anything, instead of writing a bundle entry that no parser can split. The field's type is unchanged, and every entry
Go can represent encodes exactly as before (the golden fixtures and the audit's 49 `LeafData`/`MerkleTreeLeaf` cases
are unaffected). `ct_test.ts` pins it.
