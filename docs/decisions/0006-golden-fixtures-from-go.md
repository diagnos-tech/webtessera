# ADR-0006: Generate golden fixtures by executing real Tessera

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** fixtures contributor
- **Upstream reference:** `api/layout`, `api/state.go`, `ctonly/ct.go`, `storage/posix/files.go`, `cmd/examples/posix-oneshot/main.go`, and the vendored `merkle` / `formats` / `sumdb/note` modules

## Context

webtessera claims to be byte-compatible with Tessera. A claim like that is worth exactly as much as
the evidence behind it, and there are only three ways to produce that evidence:

1. **Port the Go tests and trust them.** This is necessary but not sufficient. Upstream's tests are
   mostly structural — `paths_test.go` asserts a handful of paths, `range_test.go` compares a compact
   range against a reference tree built by the same package. Porting them proves the port is
   self-consistent, not that it agrees with Go. A port with a systematically wrong `HashChildren`
   would pass every ported test.

2. **Hand-write expected values from the spec.** This is how ports usually get their vectors, and it
   is where they go wrong. The moment someone types a hash literal, the fixture stops being evidence
   about Tessera and starts being evidence about the person who typed it. It also cannot scale: the
   `tile/entries/019.p/136` bundle of a 5000-entry log is not something anyone types.

3. **Run the original and record what it does.** This produces vectors that are, by construction,
   whatever upstream actually does — including the parts nobody documented, the parts that look like
   bugs, and the parts that are scar tissue from Trillian v1.

Option 3 is the only one that supports the claim we are making. It is also the only one a
transparency-dev reviewer can audit without reading our code: they check out Tessera at the pinned
commit, run our generator, and diff.

There is a second reason this matters more here than in a typical port. A transparency log's failure
mode is silent: a wrong `uint64` truncation or a swapped hash argument produces a *valid-looking*
proof for the wrong leaf. There is no crash, no exception, no wrong-looking output. Byte-level golden
data is the only thing that catches that class of bug.

## Decision

### The generator

`fixtures/gen/` is a Go program with its own `go.mod` that imports the real Tessera via a `replace`
directive pointing at the pinned checkout (`4a6d9f9`). `go run ./... -out ../data` regenerates
everything. `fixtures/data/*.json` is committed.

The generator **never computes an expected value itself**. It calls upstream and records what came
back. Where it constructs data — the malformed notes, the truncated entry bundles — that data is
always an *input*; the expected result still comes from calling upstream on it. Well-formed entry
bundles are built with `tessera.NewEntry(...).MarshalBundleData(i)` rather than by hand for exactly
this reason.

### Determinism is a hard requirement

Running the generator twice over an existing `fixtures/data/` must leave the tree byte-identical.
This is what makes "regenerate and diff" a meaningful audit: if regeneration produced churn, a
reviewer could not tell a real difference from noise, and the audit would be worthless.

What this rules out, and what the generator does instead:

| Hazard | Mitigation |
| --- | --- |
| Timestamps | None recorded. The pinned upstream commit identifies the provenance instead. |
| Freshly generated signing keys | The Ed25519 key pairs are hard-coded literals in `fixtures/gen/note.go`, generated once and pasted. Ed25519 signing is deterministic, so a fixed key makes every signed note reproducible. |
| Go map iteration order | Structs everywhere; the one directory walk sorts its paths explicitly. |
| Tessera's async checkpoint publisher | The full-log fixtures use `PublicationAwaiter` to block until the published checkpoint covers the last entry, then shut down. The checkpoint body has no timestamp, so its bytes depend only on origin, size and root. |
| Intermediate partial tiles from multi-pass integration | One batch sized to hold every entry, with a batch max-age long enough that only reaching the size can flush it. Integration therefore happens exactly once. |
| Tessera's garbage collector removing superseded partial tiles mid-run | `WithGarbageCollectionInterval(0)` disables it, making the set of files on disk a pure function of the tree size. |

The generator also removes any `.json` in the output directory it did not write, so deleting a
generator case cannot leave an orphan behind for a test to keep asserting against.

### Encoding

Per PORTING.md §5, and unchanged by this ADR:

- byte arrays → lower-case hex strings;
- `uint64` → decimal **strings**, because a JSON number is an IEEE-754 double and cannot carry a
  `uint64` above 2^53 (ADR-0003);
- `uint8` / `int` / counts → JSON numbers;
- 2-space indent, stable key order, trailing newline, no HTML escaping.

Two additions this ADR makes:

- **Every file carries a `description` / `upstream` / `commit` header**, so a fixture is
  self-describing when read in isolation and a reviewer can see which revision produced it.
- **Errors are recorded as `wantErr: true` plus `wantErrMsg` with the exact message text.** Upstream's
  tests assert on message content, and PORTING.md §3.6 requires the port to throw with the same text.
  Recording only a boolean would let the port drift on messages that upstream treats as API.

### The rule

**The fixture is right and your port is wrong.**

A fixture is upstream's observed behaviour. If a TypeScript test disagrees with one, the port is
wrong — including in the cases where the port looks more correct. Upstream's odd-looking choices are
usually scar tissue, and reproducing them is the entire point of a faithful port.

Nobody may edit `fixtures/data/` by hand, and nobody may adjust a fixture to make a test pass. An
contributor who believes a fixture is genuinely wrong must stop and escalate in their report rather than
change it. If the fixture really is wrong, the fix is a change to the generator, which regenerates
every dependent value at once and shows up as a reviewable diff.

## Consequences

- **A Go toolchain and the pinned upstream checkout become a build-time dependency** for anyone
  regenerating fixtures. They are not needed to run the TypeScript tests, only to change the
  fixtures. This is a real cost on donation: transparency-dev would need to decide whether to keep
  the generator in-tree (pointing at the tessera module rather than a local path) or freeze the data.
  Keeping it is strongly recommended; frozen goldens rot.

- **`fixtures/data/` is about 3.3 MB across 21 files.** That is large for a source tree. It buys
  exhaustive coverage where exhaustive coverage is cheap: an inclusion proof for every leaf of every
  tree up to size 40, a consistency proof for every valid size pair in that range, and every byte of
  three full logs. The alternative — sampling — would leave exactly the ragged-right-border shapes
  where proof bugs live untested.

- **Fixture regeneration touches many files at once.** A one-line change to the entry corpus rewrites
  megabytes. That is intentional: it makes any change to the corpus impossible to sneak past review.

- **The generator's coverage is a moving target.** PORTING.md §5 already requires adding a generator
  case whenever something byte-producing is ported. Cases the generator cannot reach are recorded in
  `docs/notes/fixture-coverage-gaps.md` rather than approximated.

- **Some fixtures record Go's wrapping `uint64` arithmetic.** `compact.NodeID.Coverage()` at level 63
  overflows and wraps in Go; the fixture records the wrapped value. A `bigint` port does not wrap on
  its own and must mask to 64 bits to match. This is a real fidelity requirement that the fixtures
  surfaced, and it is exactly the kind of thing hand-written vectors would have missed.

## Alternatives considered

- **Port upstream's test tables only, no generated goldens.** Cheapest, and PORTING.md §4 requires it
  anyway. Rejected as *sufficient* evidence: it proves internal consistency, not agreement with Go,
  and upstream's own tables do not cover entry bundles, tiles on disk, note wire format, or anything
  above size 8 for proofs.

- **Vendor upstream's `testdata/` directory.** Tessera ships some test data. Rejected: it is sparse,
  it exists to serve specific Go tests rather than to specify the format, and it does not cover the
  boundaries this port needs (256/257, `MaxUint64`, partial tiles at several levels).

- **Generate fixtures in TypeScript from the port itself.** Rejected outright — it would assert that
  the port agrees with itself, which is not a claim anyone needs.

- **A cross-language conformance harness** that runs Go and TypeScript side by side in CI instead of
  committing data. Stronger in principle: it catches drift the moment upstream changes. Rejected for
  now because it makes every test run depend on a Go toolchain, it cannot run in the workerd pool, and
  it produces no artefact a reviewer can read. Committed goldens plus a pinned commit give most of the
  benefit with none of that. Worth revisiting if this is donated and lands in upstream's CI.

- **Record only hashes of the fixture data rather than the data.** Smaller, and enough to detect
  drift. Rejected: a failing test would say "the bytes differ" and nothing else, which is close to
  useless when debugging a Merkle proof.

## Review

- **Reviewer:** fixtures reviewer
- **Verdict:** approved
- **Notes:**

  Checked against the pinned upstream (upstream Tessera @ `4a6d9f9`, Go 1.25.5).

  - **Generator calls real upstream, never reimplements.** Read all 13 Go files in `fixtures/gen/`.
    Every expected value is produced by upstream: `merkle/rfc6962`, `merkle/compact`, `merkle/proof`,
    `merkle/testonly`, `api/layout`, `api`, `ctonly`, `formats/log`, `sumdb/note`, and a real
    `storage/posix` log read back off disk. The only hand-built bytes are decoder *inputs* (malformed
    notes, truncated bundles, `encodedVerifierKey`); the `want` in each case still comes from calling
    upstream, and `note.go` even asserts the unknown-algorithm case reaches its intended branch.

  - **Determinism.** Ran `go run ./... -out ../data` three times (before and after my own probes);
    `sha256sum` of all 21 files was byte-identical each time. Fixtures are untracked in git so I used
    sha256 rather than `git diff`.

  - **Independent recomputation (not the generator's or the port's code).** Wrote a from-scratch
    RFC 6962 implementation in Python using only `hashlib` and recomputed: 45 `rfc6962` leaf/node/
    empty-root hashes; the 8-leaf reference tree roots and every inclusion proof (root recomputed from
    the proof); `smallTrees` entry-corpus roots/proofs at sizes 1,2,7,8,13,40; 861 consistency proofs
    verified against independently-computed roots; all 8 `log_<N>` checkpoint hashes equal my
    independent Merkle Tree Hash of `entry-<i>`, with level-0 tiles = concatenated leaf hashes,
    level-1 tiles = independent subtree roots, and bundles decoding correctly; 17 `compact_range`
    roots; 34 `ctonly` cases (`MerkleLeafHash == HashLeaf(MerkleTreeLeaf)`, `Identity == sha256(cert)`).
    All matched.

  - **The wrapping `uint64` claim in Consequences is real and correctly recorded.** `NodeID.Coverage()`
    is `index<<level, (index+1)<<level` in wrapping uint64. Recomputed all 56 `nodeIds` rows masked to
    2^64; the 8 level-63 rows record the wrapped value (e.g. index `2^63-1` → begin `2^63`, end `0`),
    not the mathematically larger one. A `bigint` port must mask, exactly as the ADR warns.

  - **Encoding contract (PORTING.md §5).** Walked every parsed JSON value: no bare number ≥ 2^53 and
    no floats — all `uint64` are decimal strings; largest bare int anywhere is 256 (a count). Hex is
    lower-case by construction (`hex.EncodeToString`); 2-space indent, trailing newline, header with
    `commit: 4a6d9f9` present in all 21 files. The loader (`src/testonly/fixtures.ts`) rejects
    upper-case hex, `0x` prefixes, odd-length hex, leading-zero / out-of-range `uint64`, and
    path-traversal names, and its test re-derives values from `@noble/hashes` (a different SHA-256).
