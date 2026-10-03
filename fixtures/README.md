# Golden fixtures

`fixtures/data/*.json` is the evidence for webtessera's compatibility claim. Every value in it was
produced by **executing the real Tessera Go implementation**, not by reasoning about it. TypeScript
tests load these files and assert byte-equality.

Two rules, from AGENTS.md §5:

- **Never hand-edit a file in `fixtures/data/`.** Fix the generator and re-run it.
- **Never change a fixture to make a TypeScript test pass. The fixture is right and your port is
  wrong.** If you genuinely believe a fixture is wrong, stop and escalate — do not quietly adjust it.

## Regenerating

```sh
bun run fixtures
```

That runs `bun run upstream` first, which clones Tessera into `.upstream/tessera` (gitignored) and checks
out the pinned commit, and then `go run . -out ../data` inside `fixtures/gen`. The repository URL and
the commit live in one place, `scripts/upstream.json`; `fixtures/gen/go.mod` points its `replace`
directive at the same checkout (`../../.upstream/tessera`), and `fixtures/gen/client.go` reads
upstream's static `testdata/log` from it.

Requirements: Go 1.24 or newer (CI uses 1.24; the committed data was first produced with 1.25.5 and
regenerates byte-identically under 1.24.7), `git`, and Node >= 20 for the checkout script.

`bun run upstream` is idempotent: when `.upstream/tessera` is already at the pin it does nothing, and it
refuses to run over local modifications, because fixtures generated from a patched upstream are not
evidence of anything. `node scripts/fetch-upstream.mjs --force` discards them.

To move the pin, edit `scripts/upstream.json`, run `bun run fixtures`, and review the resulting
`git diff -- fixtures/data` like any other change to the compatibility evidence. A pin bump belongs in
its own pull request, together with a review of upstream's diff against the port.

Regeneration is **deterministic**: running it twice must leave `fixtures/data/` byte-identical. That
is the property that makes the fixtures auditable, so it is not negotiable. Concretely, the generator
contains no timestamps, no randomness, and no map iteration whose order reaches the output; the note
signing keys are hard-coded literals rather than freshly generated; and the full-log fixtures disable
garbage collection and use a single batch so the set of files a log writes is a pure function of its
size.

The generator also deletes any `.json` in the output directory it did not write, so removing a
generator case cannot leave an orphaned fixture behind.

## Auditing these fixtures independently

You do not have to trust this repository. A reviewer can check the fixtures three ways, in
increasing order of effort:

1. **Regenerate and diff.** Run `bun run fixtures` and confirm `git status --porcelain fixtures/data` is
   empty. This proves the committed files are what upstream at the pinned commit produces. CI runs
   exactly this check on every push.

2. **Cross-check within the corpus.** Several fixtures are produced by *different* upstream code
   paths that must agree, so they check each other:
   - `log_<N>.json`'s `checkpointHash` is the root of a real POSIX-backed Tessera log.
   - `compact_range.json` reaches the same root for size N via `merkle/compact`.
   - `proof_consistency.json`'s `roots` reaches it again via `merkle/testonly.Tree`.

   All three agree for every size the fixtures cover. Three independent upstream implementations of
   the same tree, one number.

3. **Cross-check against material that predates Tessera.** `proof_inclusion.json`'s `reference`
   section is the canonical eight-leaf RFC 6962 tree from `merkle/testonly.LeafInputs()`, whose node
   and root hashes are published in `merkle/testonly/constants.go` and in the CT test corpora that
   Trillian, Sunlight and others have used for a decade. `rfc6962.json` includes the four vectors
   from upstream's own `rfc6962_test.go` under their upstream case names.

## What is in each file

| File | Upstream | What it pins |
| --- | --- | --- |
| `layout_paths.json` | `api/layout` | `NWithSuffix`, `TilePath`, `EntriesPath`, `EntriesPathForLogIndex`, `CheckpointPath` |
| `layout_parse.json` | `api/layout` | `ParseTileLevelIndexPartial`, `ParseTileLevel`, `ParseTileIndexPartial`, including every rejection and its exact message |
| `layout_tile.json` | `api/layout` | `TileHeight`/`TileWidth`/`EntryBundleWidth`, `PartialTileSize`, `NodeCoordsToTileAddress` |
| `layout_range.json` | `api/layout` | `Range(from, N, treeSize)`, including empty and single-bundle ranges |
| `rfc6962.json` | `merkle/rfc6962` | `EmptyRoot`, `HashLeaf`, `HashChildren` |
| `compact_range.json` | `merkle/compact` | `Range` append/merge with full visitor output, `RangeNodes`, `RangeSize`, `Decompose`, `NodeID` arithmetic |
| `proof_inclusion.json` | `merkle/proof` | inclusion proofs for every leaf of every tree of size 1..40, selected proofs in trees up to 5000, `proof.Inclusion` node IDs, `RootFromInclusionProof` rejections, and the RFC 6962 reference tree |
| `proof_consistency.json` | `merkle/proof` | consistency proofs for every `(size1, size2)` pair up to 40 plus selected large pairs, `proof.Consistency` node IDs, `VerifyConsistency` rejections |
| `api_hash_tile.json` | `api` | `HashTile.MarshalText`/`UnmarshalText`, including non-multiple-of-32 rejections |
| `api_entry_bundle.json` | `api` | `EntryBundle.UnmarshalText`, including dangling bytes and truncated length prefixes |
| `note.json` | `golang.org/x/mod/sumdb/note` | key encoding, key hashing, `Sign`, `Open`, and every malformed note upstream rejects |
| `checkpoint.json` | `formats/log` | `Checkpoint.Marshal`/`Unmarshal`, signed checkpoints, `ParseCheckpoint` |
| `ctonly.json` | `ctonly` | `Entry.LeafData`, `MerkleTreeLeaf`, `MerkleLeafHash`, `Identity` |
| `log_<N>.json` | `storage/posix` | a complete log of N entries: every tile, every entry bundle, and the signed checkpoint, keyed by tlog-tiles path, plus the driver's private `.state/` files (`version`, `treeState`) as Go wrote them |

### Encoding

- Byte arrays are **lower-case hex strings**.
- `uint64` values are **decimal strings**, never JSON numbers — a JSON number is a double in every
  JavaScript runtime and cannot carry a `uint64` above 2^53. See
  `docs/decisions/0003-uint64-as-bigint.md`.
- `uint8`, `int` and small counts are plain JSON numbers.
- 2-space indent, stable key order, trailing newline.
- Every file starts with `description`, `upstream` and `commit`.

Where upstream returns an error, the fixture records `wantErr: true` plus `wantErrMsg` with the exact
message text, because upstream's own tests assert on message content and so must the port.

### The log corpus

Every fixture that needs a body of entries uses the same one: **entry `i` is the UTF-8 bytes of
`entry-<i>`**. That is why `log_5000.json`, `compact_range.json` and `proof_inclusion.json` describe
the same tree and can be cross-checked against each other.

The note/checkpoint signing keys are in `fixtures/gen/note.go` as hard-coded literals. They are test
data and protect nothing.

## Using the fixtures from TypeScript

```ts
import { loadFixture, u64 } from "../../testonly/fixtures.ts";

interface LayoutPaths {
  readonly tilePath: readonly { tileLevel: string; tileIndex: string; p: number; want: string }[];
}

const f = await loadFixture<LayoutPaths>("layout_paths");
for (const tc of f.tilePath) {
  expect(tilePath(u64(tc.tileLevel), u64(tc.tileIndex), tc.p)).toBe(tc.want);
}
```

The loader is `src/testonly/fixtures.ts`. It is dependency-free and its decoders are strict: a
fixture that has been hand-edited or re-encoded by another tool fails at load time rather than
producing a subtly wrong `Uint8Array`.

## Known gaps

`docs/notes/fixture-coverage-gaps.md` records what the generator could not reach and why. Nothing in
`fixtures/data/` is approximated or hand-written; if a case is missing, it is missing on purpose and
documented there.
