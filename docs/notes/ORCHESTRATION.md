# Orchestration state

Running record of who is doing what. **Any contributor picking up this project cold should read this
file, then `PORTING.md`, then `docs/REVIEW-PROTOCOL.md`.** Keep it updated; it is the coordination
spine and it is what lets work resume after a context reset.

## Ground truth

- Upstream Go: `/home/gg/dev/Maravi/_future/tessera` @ `4a6d9f9` (107 Go files, ~16k non-test LOC).
- Vendored Go deps in the module cache — see `PORTING.md` §1 for exact paths.
- Go 1.25.5 is installed and upstream's own tests pass, so fixtures can be regenerated at will.

## Foundation — done, by the lead

| Artifact | Purpose |
| --- | --- |
| `PORTING.md` | The contract. Fidelity rules, type mapping, TDD workflow, definition of done. |
| `docs/REVIEW-PROTOCOL.md` | Reviewer job description. One reviewer per work package, never the author. |
| `docs/decisions/0001..0005` | Scope register, naming, `uint64`→`bigint`, errors/context/concurrency, noble crypto. |
| `src/internal/gostd/bytes.ts` | Go `bytes`/`hex`/`base64`/`binary`. |
| `src/internal/gostd/errors.ts` | `errors.Is`/`As`, `%w` wrapping, `ErrNotExist`. |
| `src/internal/gostd/sync.ts` | `Mutex`, `WaitGroup`, `ErrGroup`, `Once`, `sleep`, `ticker`. 20 tests green. |
| toolchain | `package.json`, `tsconfig.json`, `vitest.config.ts` (node, `*_test.ts`), `vitest.workers.config.ts` (DO only). Smoke-tested. |

## Waves

Each row is one contributor. Reviewers are spawned per package once the implementer reports, and they are
never the contributor that wrote the code.

### Wave 1 — in flight

| Package | Scope | Blocks |
| --- | --- | --- |
| Fixtures | `fixtures/gen/` (Go) → `fixtures/data/`, `src/testonly/fixtures.ts` | everything's compat proof |
| Merkle | `src/vendor/merkle/**`, `src/internal/gostd/bits.ts` | W2 integrate, W2 client, W4 fsck |
| Note | `src/vendor/note/**`, `src/vendor/formats/log/**` | W2 client, W3 append_lifecycle |
| Layout | `src/api/**`, `src/internal/parse/**`, `docs/PORTING-MAP.md` | nearly everything |

### Wave 2 — blocked on W1

- `src/storage/internal/{integrate,queue,tileid}.ts` + `src/{entry,log,lifecycle}.ts` — needs Merkle `compact`, Layout `api`.
- `src/client/{client,fetcher,stream}.ts` + `src/internal/{future,fetcher}` — needs Merkle `proof`, Note, Layout.

### Wave 3

- `src/append_lifecycle.ts`, `await.ts`, `antispam.ts`, `witness.ts`, `internal/witness/`, `migrate*.ts`, `otel.ts` — the orchestration layer, largest package.
- `src/ctonly/ct.ts`, `src/ct_only.ts`, `src/internal/gostd/cryptobyte.ts` — **self-contained, can run any time**.
  Landed by the CT contributor: `cryptobyte.ts` and `ctonly/ct.ts` are complete; `ct_only.ts` is partial.
  Its `NewCertificateTransparencyAppender`, `convertCTEntry` and the two `WithCTLayout` methods are
  left as `TODO(gustavo):` for whoever takes the append-lifecycle package, and `identityHash` is
  duplicated there until `src/lifecycle.ts` exists to export it. ADRs 0040–0044, all awaiting review.

### Wave 4

- `src/fsck/**` + `src/internal/gostd/list.ts` (Go `container/list`) — **done**, by the fsck
  contributor. `list.ts`/`list_test.ts` (10/10 tests), `fsck/status.ts`/`status_test.ts` (12
  tests: 10 upstream `TestUpdate` + 2 new), `fsck/fsck.ts`/`fsck_test.ts` (6 tests: 4
  upstream `TestTrimFullToPartial` subtests + 2 new fixture-backed `check()` end-to-end
  cases against `client_log`). `fsck/index.ts` barrel added (`package.json` already
  declared the `./fsck` export). ADR-0090 (list.ts), ADR-0091 (fsck translation choices),
  ADR-0092 (fsck's visitor needs no ADR-0052 treatment — it does no I/O), ADR-0093
  (`cmd/fsck/tui/`, `cmd/fsck/internal/tui/`, `cmd/fsck/main.go` not ported — resolves
  ADR-0001's terminal-UI row). All four ADRs await review. Full suite green: 1462/1462
  (`bunx vitest run --config vitest.config.ts`); `bunx tsc --noEmit` clean for every file
  this contributor touched (one pre-existing, unrelated failure in `src/await_test.ts` from
  concurrent work on `src/await.ts`, not part of this landing).
- `src/storage/{memory,indexeddb,durableobject,s3}/` — `memory` is the reference driver the conformance suite runs against.

### Wave 5 — `src/adapters/**` (pt-BR comments, not donated)

Session log with server countersigning, magic-files vault sync, Firestore backup + election,
read-only editor export. See `PORTING.md` §8.

### Wave 6 — conformance suite, README for transparency-dev reviewers, resolve every `pending` row in ADR-0001.

## Standing rules for every contributor

1. Read `PORTING.md` fully first. It overrides your instincts about idiomatic TypeScript.
2. TDD: port the Go test file, watch it fail, then implement.
3. Never invent fixture data. Never edit `fixtures/data/` by hand. If a fixture and your port
   disagree, **the fixture is right**.
4. Every divergence and every omission gets an ADR. ADR numbers are allocated per work package to
   avoid collisions — check `docs/decisions/` for the highest in use before claiming a block.
5. Report honestly. Paste real command output. A precise partial report beats an overstated one.
