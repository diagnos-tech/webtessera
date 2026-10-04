# ADR-0220: Add an environment-explicit safe API, `webtessera/server` and `webtessera/browser`, over the port

- **Status:** accepted
- **Date:** 2026-10-03
- **Author:** DX guardrails contributor
- **Upstream reference:** n/a (no upstream counterpart). It is built on `append_lifecycle.go`, `await.go`,
  `witness.go`, `client/client.go`, golang.org/x/mod `sumdb/note`, and transparency-dev/formats `log`, `note`
  and `proof`, all as ported.

## Context

The port mirrors Go's API exactly (PORTING.md §1, §3). That is what makes it reviewable against Tessera, and it
is powerful, but it is easy to misuse in the places webtessera targets that Go does not:

- A note signer key string (`PRIVATE+KEY+…`) passed to `newSigner` works the same in a browser bundle as on a
  server, so nothing stops a log's secret from shipping to every visitor.
- `newMemoryDriver()` is the README's first example, and a log kept in memory on a server loses its tree when
  the process restarts while its checkpoints live on in clients.
- SQLite's default locking is per-adapter; two processes appending to one SQLite file under "local" locking each
  believe they hold the tree lock, and the key signs two diverging trees.
- `appender.add(entry)()` resolves before the entry is verifiable; returning that index as if it were proof is a
  common mistake, and `PublicationAwaiter` has a sharp edge (ADR-0226).
- Verifying a checkpoint with the wrong key, or forgetting the witness policy, is silent.

The project owner asked for the best possible developer experience, with guardrails that make these mistakes
impossible, and for code that **explicitly declares whether it runs in the server's private environment or the
browser's public one**. That is added API with no upstream counterpart, which PORTING.md §1 otherwise limits to
what the runtimes force on us; this ADR records the exception and its boundaries.

## Decision

Add a layer over the port, in its own entry points, that never changes how the ported API behaves.

**Entry points** (`package.json` `exports`; `tsconfig.json` `paths`; vitest's self-aliases follow `exports`):

| Import | Environment | Contents |
| --- | --- | --- |
| `webtessera/server` | the server's private environment: Node, Deno, Bun, edge runtimes | `openServerLog`, `importLogKey`, `generateLogKey`, receipts, `detectRuntime` |
| `webtessera/browser` | the browser's public environment: windows, workers, service workers | `openBrowserLog`, `openDeviceKey`/`loadDeviceKey`/`saveDeviceKey`/`deleteDeviceKey`, `fromCryptoKey`, `generateLogKey`, receipts, `detectRuntime` |
| `webtessera/formats/proof` | any | the port of transparency-dev/formats `proof` (ADR-0224) |

`webtessera/server` is guarded against browsers at build time and at run time (ADR-0221). `webtessera/browser`
holds no secret material and so is safe to import anywhere, including on a server that only verifies receipts.

**Names.** `server` and `browser` name the environment a developer is deciding about, in the words they use for
it, and read correctly at the import site. Alternatives are listed below.

**Layout.** Code with no upstream counterpart lives apart from the translation:

- `src/safe/`: what both environments share: key custody (`keys.ts`, ADR-0222), receipts (`receipt.ts`,
  ADR-0225), the high-level log (`log.ts`, ADR-0226) and runtime detection (`runtime.ts`, ADR-0221). It has no
  entry point of its own: each entry point re-exports the part that is safe in its environment, so there is no
  environment-neutral path to `importLogKey`.
- `src/server/`, `src/browser/`: the entry points and what is specific to each (the HTTP handler and SQLite
  defaults; device keys in IndexedDB, ADR-0227).

**What the layer may change in the port: nothing behavioural.** The additions to ported files are purely
additive and reviewed in their own ADRs: `AsyncSigner` and `signAsync` in `src/vendor/note/note.ts`,
`AppendOptions.withCheckpointAsyncSigner` in `src/append_lifecycle.ts` (ADR-0223), and the `bufio.Scanner`
stand-in in `src/internal/gostd/bufio.ts` (ADR-0224). Every golden, fixture and differential test runs unchanged.

**Small and composed.** Each environment has one factory, whose result exposes the ported `reader` and
`appender`. Anything the layer does not do is done with the ported API on those handles (mirroring with
`webtessera/mirror`, auditing with `webtessera/fsck`, witnessing with `webtessera/witness`), which
`docs/guides/safe-api.md` shows.

## Consequences

- Two more public entry points to keep stable, and a vocabulary (`LogKey`, `Receipt`, `TransparencyLog`) that
  is ours, not Go's. These names are not mechanical translations and do not follow ADR-0002, because they
  translate nothing; they are kept out of the ported barrels.
- Reviewers of this layer cannot check it against Go line by line; they check it against the ported functions
  it composes, which each module names at its top.
- PORTING.md §1 ("No invention") and §2 (directory layout) should mention the layer, so that later contributors
  neither port into `src/safe/` nor add invention to the translation. That edit is the maintainers'.
- The README leads with the safe API ("The safe API") and keeps the ported API for those who need it
  ("Quick start: the full API").

## Alternatives considered

- **Document the pitfalls and keep only the ported API.** Rejected: the owner's requirement is that the mistakes
  be impossible, not documented, and a bundled private key is not caught by any test a developer would write.
- **Add the guardrails to the ported functions** (refuse `newSigner` in a browser, make `newAppender` refuse a
  memory driver). Rejected: every one is a behavioural divergence from Go in code whose value is fidelity, and
  the golden and differential suites would have to special-case them.
- **One entry point with a runtime switch** (`openLog` deciding by environment). Rejected: the decision then
  happens at run time, invisibly, where the requirement is that the code declare it; and the server half could
  not be kept out of browser bundles.
- **Other names:** `webtessera/private` and `webtessera/public` (describe the threat model but not where the
  code runs, and "public" reads as "the public API"); `webtessera/node` and `webtessera/web` (wrong for Deno,
  Bun and Workers, and Workers are "web"); `webtessera/signer` and `webtessera/client` (the browser also signs
  its own log, and `webtessera/client` already exists as Tessera's `client` package).
- **A separate package** (`@webtessera/safe`). Rejected for now: it would version the layer apart from the port
  it depends on byte for byte, for no benefit to users, and it can still be split later.

## Review

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Checked the entry-point table against the tree: `package.json` `exports` has `./server`, `./browser` and `./formats/proof`; `tsconfig.json` `paths` has the same three; `src/server/index.ts` and `src/browser/index.ts` export exactly the contents the table lists; `src/safe/` has no entry point of its own, and `importSignerKey` is imported only by `src/server/keys.ts` (and the golden test helper), so there is no environment-neutral path to it. No file outside `src/safe`, `src/server`, `src/browser` and test tooling imports the layer, and `src/index.ts` does not export it. PORTING.md now carries the paragraph the Consequences asked the maintainers for.
  - Read the additions to ported files (see ADR-0223 and ADR-0224): additive. "The additions ... are purely additive" was overtaken by ADR-0224's first Update, which switches `src/witness.ts` to the shared `Scanner`; that is recorded there, and I verified it behaviour-identical (ADR-0224 notes). Non-blocking.
  - Challenged the alternatives. A run-time switch cannot keep the server half out of a browser bundle (I demonstrated the bundler mechanism for ADR-0221), and putting guardrails into the ported functions would make the golden and differential suites special-case them: both rejections stand. The choice of names is judgement, not a Go-fidelity question.
  - Every other ADR of the layer (0221 to 0227) was reviewed in the same pass, and the layer's tests pass: unit 3439, Chromium 265, workerd 300; `bun run lint` (521 files) and both `tsc --noEmit` projects exit 0.
