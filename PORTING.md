# PORTING.md — webtessera

**Read this file completely before writing a single line of code.** It is the contract that keeps
this port coherent no matter who contributes to it. [CONTRIBUTING.md](CONTRIBUTING.md) covers
the practical workflow and defers to this file on every rule about the code.

---

## 1. What this project is

`webtessera` is a **faithful TypeScript port of [Tessera](https://github.com/transparency-dev/tessera)**,
the tile-based transparency log framework from Google and the transparency-dev community, targeting
the places Go does not reach — **browsers, and servers or edge functions on whichever SQLite they
already have** — instead of Tessera's cloud object stores and databases. It is a port, not the
upstream project.

**The upstream Go source of truth is Tessera at commit `4a6d9f9`.** The pin lives in one file,
[`scripts/upstream.json`](scripts/upstream.json). Fetch the source with:

```sh
bun run upstream        # clones into .upstream/tessera (gitignored) and checks out the pin
```

Tessera's own dependencies, which this repository also ports, are read from the Go module cache once
`bun run fixtures` (or `cd fixtures/gen && go mod download`) has populated it. `go list -m -f '{{.Dir}}'
<module>` run inside `fixtures/gen` prints each directory.

| Go import path | Version | Where to read it |
| --- | --- | --- |
| `github.com/transparency-dev/tessera` | commit `4a6d9f9` | `.upstream/tessera` |
| `github.com/transparency-dev/merkle` | `v0.0.2` | Go module cache |
| `github.com/transparency-dev/formats` | `v0.0.0-20251017110053-404c0d5b696c` | Go module cache |
| `golang.org/x/mod/sumdb/note` | `golang.org/x/mod@v0.31.0` | Go module cache |
| `golang.org/x/crypto/cryptobyte` | `golang.org/x/crypto@v0.46.0` | Go module cache |

### The goal that overrides every other goal

This codebase is written to be read by the people who wrote the original, and to be trusted by
people who depend on transparency logs being correct. That means:

- **Fidelity beats cleverness.** If Go does something in a way that looks odd, port it that way and
  find out *why* before changing it. The Tessera authors already learned the lessons of Trillian v1;
  their odd-looking choices are usually scar tissue, not accidents.
- **Every upstream comment carries absolute weight.** Comments in the Go source are part of the
  specification. Port them. Do not summarise them. Do not "improve" them.
- **No invention.** You are not designing a transparency log. You are translating one.

Code with no upstream counterpart is limited to what the target runtimes force on us: the Go
standard-library stand-ins (§3.5.1), the web storage drivers (§8), barrel files and test tooling.
Everything else is a translation, and every divergence from it is recorded in an ADR (§6).

---

## 2. Directory layout

```
webtessera/
├── PORTING.md                  ← this file
├── CONTRIBUTING.md            ← how to contribute: setup, scripts, workflow
├── SECURITY.md                ← how to report a vulnerability
├── CHANGELOG.md               ← user-visible changes (Keep a Changelog)
├── LICENSE, NOTICE            ← Apache-2.0, and the attribution it requires
├── LICENSES/                  ← verbatim third-party licence texts (BSD-3-Clause for Go-derived code)
├── docs/
│   ├── README.md              ← index of this folder
│   ├── PORTING-MAP.md         ← file-by-file Go→TS status table (KEEP UPDATED)
│   ├── REVIEW-PROTOCOL.md     ← how ports, ADRs and pull requests are reviewed
│   ├── decisions/             ← ADRs. Every divergence from Go lives here.
│   │   └── 0000-template.md
│   └── notes/                 ← free-form design discussion, scratch analysis
├── examples/
│   ├── browser/               ← Vite demo: a log in IndexedDB, in a tab
│   └── cloudflare-durable-object/  ← Worker + Durable Object log
├── fixtures/
│   ├── gen/                   ← Go program that emits golden fixtures from real Tessera
│   └── data/                  ← generated fixtures, COMMITTED to the repo
├── scripts/
│   ├── fetch-upstream.mjs     ← `bun run upstream`: checks out Tessera at the pin
│   └── upstream.json          ← the pin: repository URL + commit
├── .upstream/                 ← gitignored; the upstream checkout (`bun run upstream`)
├── .githooks/pre-commit       ← Biome and gofmt on the staged files; `bun install` enables it
├── bunfig.toml, bun.lock      ← Bun's configuration and lockfile (§3.9)
└── src/
    ├── vendor/                ← ports of Go deps that have no TypeScript equivalent
    │   ├── merkle/{rfc6962,compact,proof,testonly}/
    │   ├── note/              ← golang.org/x/mod/sumdb/note (BSD-3-Clause)
    │   └── formats/{log,note}/ ← github.com/transparency-dev/formats (note: cosignature/v1 only)
    ├── api/                   ← mirrors tessera/api
    ├── internal/              ← mirrors tessera/internal
    │   └── gostd/             ← Go standard-library stand-ins (§3.5.1)
    ├── storage/
    │   ├── internal/          ← mirrors tessera/storage/internal
    │   ├── objectstore/       ← NEW (web): the ObjectStore contract + the driver that runs on it (§8)
    │   ├── memory/            ← NEW (web): in-memory backend, the `posix` of the browser
    │   ├── indexeddb/         ← NEW (web): browser persistence
    │   └── sqlite/            ← NEW: any SQLite engine, one small adapter per engine
    ├── client/                ← mirrors tessera/client
    ├── fsck/                  ← mirrors tessera/fsck
    ├── ctonly/                ← mirrors tessera/ctonly
    ├── http/                  ← NEW: serves a log over the tlog-tiles HTTP API
    ├── witness/               ← NEW: a tlog-witness server (the root package holds the client)
    ├── mirror/                ← mirrors tessera/cmd/experimental/mirror, plus S3-compatible sinks
    ├── testonly/              ← mirrors tessera/testonly (+ the fixture loader)
    ├── index.ts               ← package root barrel: what Go's `tessera` package exports (ADR-0133)
    └── *.ts                   ← mirrors tessera root package (entry.ts, append_lifecycle.ts, …)
```

### Public surface

The package entry points are the `exports` map in `package.json`. A directory that is a Go package
gets a barrel `index.ts` (it has no Go counterpart, because in Go the package itself is the unit of
import) that re-exports **exactly what the Go package exports**; `src/index.ts` plays that part for
Tessera's root package (ADR-0133). Symbols that are unexported in Go stay reachable only by importing
their file directly, which is what the ported tests do — see
`docs/decisions/0010-package-private-members.md`. Never widen a barrel to make something convenient
to import; that is added API, and added API needs an ADR (§6).

---

## 3. Fidelity rules

### 3.1 File names — identical to Go

`append_lifecycle.go` → `append_lifecycle.ts`. `ct_only.go` → `ct_only.ts`.
Yes, snake_case is unusual in TypeScript. It is deliberate: it makes a side-by-side diff against
the original trivial for a reviewer, which is the single most valuable property this codebase can
have. Directory names are identical too.

Test files: `paths_test.go` → `paths_test.ts` (**not** `paths.test.ts`). Vitest is configured to
pick up `*_test.ts`. Tests that need a real browser are `*_browser_test.ts` (§8).

### 3.2 Identifier names — mechanical mapping, documented once

| Go | TypeScript | Example |
| --- | --- | --- |
| exported type / struct / interface | same name, unchanged | `Entry`, `HashTile`, `RangeInfo` |
| exported const | same name, unchanged | `TileWidth`, `CheckpointPath` |
| exported func | **camelCase** of the same name | `NewEntry` → `newEntry`, `EntriesPathForLogIndex` → `entriesPathForLogIndex` |
| unexported func | camelCase, not exported | `fmtN` → `fmtN` |
| struct field | same name, camelCased if Go exported it | `RangeInfo.Index` → `RangeInfo.index` |
| method | camelCase | `(t HashTile) MarshalText` → `hashTile.marshalText()` |
| sentinel error var | same name | `ErrPushback` |

Functions are camelCase because Go's PascalCase is a *visibility* mechanism, not a naming style —
TypeScript expresses visibility with `export`. A TypeScript library with `NewEntry()` reads as a
bad transliteration; `newEntry()` is the faithful rendering of the same intent. Types and constants
keep their exact Go spelling because PascalCase/SCREAMING_CASE means the same thing in both
languages. **This mapping is mechanical: never rename beyond it, never "improve" a name.**
ADR-0002 records the reasoning.

### 3.3 Declaration order — identical to Go

Keep declarations in the same order they appear in the Go file. A reviewer must be able to scroll
both files in parallel.

### 3.4 Comments

- **Comments are in English.** Copy the upstream comment verbatim when it still applies. Adjust
  only the parts that are language-specific (`[]byte` → `Uint8Array`, `os.ErrNotExist` →
  `ErrNotExist`). Keep the Go doc-comment convention of starting with the identifier name.
- Where the port diverges from Go, add a short `// Port note:` paragraph explaining *why*, and link
  the ADR: `// Port note: see docs/decisions/0003-uint64-as-bigint.md`.
- Do not write comments that restate the code. Do not write phase/plan/TODO-list narration in code.
  Pending work is `TODO(<github-username>):` and nothing else — name the person who will do it, and
  keep it specific enough that someone else could.
- Every file keeps the upstream licence header when it is a port of an upstream file, with the
  original copyright line intact, plus our own line. See §9.

### 3.5 Types — the mapping table

| Go | TypeScript | Why |
| --- | --- | --- |
| `uint64` | `bigint` | Log sizes and indices are uint64 and the upstream tests explicitly exercise `math.MaxUint64` overflow. `number` silently loses precision above 2^53. Non-negotiable. ADR-0003. |
| `uint8`, `uint`, `int`, `int64` | `number` | Bounded by construction (tile levels ≤ 63, partial sizes < 256, slice offsets). |
| `[]byte` | `Uint8Array` | Never `string`, never `Buffer` (`Buffer` does not exist on the edge). |
| `string` | `string` | |
| `[][]byte` | `Uint8Array[]` | |
| `error` return | thrown `Error` subclass | See §3.6. |
| `context.Context` | `AbortSignal` (usually optional, last parameter) | |
| `iter.Seq[T]` | `Generator<T>` | Use `function*`. |
| `time.Duration` | `number` (milliseconds) | Name the variable `…Ms` when the unit is not obvious. |
| `sync.Mutex`, `sync.WaitGroup`, `sync.Once` | `Mutex`, `WaitGroup`, `Once` from `src/internal/gostd/sync.ts` | |
| `errgroup.Group` | `ErrGroup` from `src/internal/gostd/sync.ts` | |
| `time.Ticker` loop | `ticker()` from `src/internal/gostd/sync.ts` | |

### 3.5.1 Go stdlib shims — use them, do not reinvent them

`src/internal/gostd/` holds the Go standard-library facilities TypeScript lacks. They are written,
tested, and shared across the whole port:

- **`bytes.ts`** — `bytesEqual`, `bytesCompare`, `concatBytes`, `toHex`/`fromHex`, `toUTF8`/`fromUTF8`,
  `toBase64`/`fromBase64`, big-endian uint16/uint64 read/append. Covers Go's `bytes`,
  `encoding/hex`, `encoding/base64`, `encoding/binary`.
- **`errors.ts`** — `SentinelError`, `ErrNotExist`, `wrapError`, `errorIs`, `errorAs`,
  `throwIfAborted`. Covers `errors.Is`/`As`, `%w` wrapping, `os.ErrNotExist`.
- **`sync.ts`** — `Mutex`, `WaitGroup`, `ErrGroup`, `Once`, `sleep`, `ticker`. Covers `sync`,
  `sync/atomic`, `time.Ticker`, `x/sync/errgroup`.
- Further single-purpose shims sit beside them (`bits.ts`, `strconv.ts`, `strings.ts`, `unicode.ts`,
  `io.ts`, `list.ts`, `cryptobyte.ts`, `rand.ts`); `docs/PORTING-MAP.md` lists what each covers.

If one of them is missing something you need, **add it there with tests**. Do not write a local copy;
four private `bytesEqual`s is exactly the incoherence this directory prevents.

> **On mutexes specifically** (ADR-0004): JavaScript is single-threaded and runs to completion, so a
> Go critical section that stays *synchronous* in TypeScript needs no lock — drop it and say why in a
> `// Port note:`. A critical section that spans an `await` genuinely does need `Mutex`, because
> `await` is an interleaving point. Decide per case; never transliterate blindly in either direction.

### 3.6 Errors

Go returns errors; TypeScript throws. Port `return nil, fmt.Errorf(...)` as `throw new Error(...)`
with the **same message text**, because upstream tests assert on message content.

- Sentinel errors (`ErrPushback`, `ErrNotExist`) become exported singleton `Error` instances of a
  named subclass, so `errorIs(e, ErrPushback)` can walk the `cause` chain the way `errors.Is` walks
  the wrap chain.
- `fmt.Errorf("...: %w", err)` becomes `new Error("...", { cause: err })`.
- Use the helpers in `src/internal/gostd/errors.ts`. Do not hand-roll error identity checks.
- `os.ErrNotExist` maps to the exported `ErrNotExist` sentinel — several upstream interfaces are
  specified in terms of it (`LogReader.readCheckpoint`).

### 3.7 Async

Everything that takes a `context.Context` in Go returns a `Promise` in TypeScript. Everything that
does not, stays synchronous — in particular **the Merkle hashing and proof code is synchronous**
(that is why we use `@noble/hashes` and not WebCrypto's async `subtle.digest`; ADR-0005).

### 3.8 Source style

Biome is the formatter and linter; `bun run lint:fix` settles every style question. The conventions it
cannot enforce on its own:

- Relative imports carry an explicit `.ts` extension (`import { x } from "./paths.ts"`); `tsc`
  rewrites them to `.js` on emit. Type-only imports use `import type`.
- Erasable syntax only (`erasableSyntaxOnly`): no `enum`, no `namespace`, no constructor parameter
  properties. The sources must run unmodified under Node's type stripping.
- `#field` is for genuinely private state. A Go identifier that is unexported but used across files
  or by the ported tests becomes a `_`-prefixed member marked `@internal` (ADR-0010).
- ESM only. The compiler is strict, including `exactOptionalPropertyTypes` and
  `noUncheckedIndexedAccess`; do not loosen either to make a port compile.

### 3.9 Tooling: Bun runs the scripts, Node runs the tests

Bun is the package manager and the script runner: `bun install`, `bun run <script>`, `bunx`. The tests
are the exception, because on which runtime they run is part of what this project promises (Node 22 and
24, Vitest's Chromium and workerd pools, `node:sqlite`). ADR-0240 has the evidence. So:

- **Run tests with `bun run test:unit`** (and `test:browser`, `test:workers`, `test:services`), which
  starts Vitest on Node. Never `bun test`: that is Bun's own runner, and it neither knows Vitest's `vi`,
  `expectTypeOf` and `import.meta.glob` nor this repository's `*_test.ts` naming. Likewise `bun run build`,
  never `bun build`.
- **Never run Vitest on Bun's runtime** (`bunx --bun vitest`, `bun --bun`, `[run] bun = true` in a bunfig):
  `node:sqlite` is absent there, so seven suites fail to load, and the workerd pool hangs.
- **Node must be on `PATH`.** Without it Bun makes `node` mean itself and the suites silently run on Bun.
- Releases are packed with Bun and published with `npm publish --provenance` (`bun publish` has neither
  provenance nor trusted publishing). Nothing else uses npm.
- `bun install` also runs `scripts/prepare.mjs`: it links the repository root into
  `node_modules/webtessera` (Bun cannot do that for a workspace root, and the examples and the site import
  the library by name) and enables `.githooks/pre-commit`. The hook only checks (Biome on the staged files,
  gofmt on the staged Go); `git commit --no-verify` skips it, and CI does not.

---

## 4. TDD — the required workflow

For every file you port, in this order:

1. **Read the Go source *and its test file* end to end.** Also read every Go file it imports from
   within Tessera. Do not start from the function signature alone.
2. **Port the test file first.** `paths_test.go` → `paths_test.ts`, same test names, same table-driven
   cases, same values. Run it. **It must fail** (module not implemented yet). A test that passes
   before you write the implementation is a broken test.
3. **Port the implementation** until the tests are green.
4. **Wire in golden fixtures** (§5) for anything that produces bytes: tiles, bundles, checkpoints,
   proofs, paths, notes.
5. **Update `docs/PORTING-MAP.md`** — mark the file done, record the test count.
6. **Write an ADR** for every divergence, and for every upstream file you decided *not* to port.

Never skip step 2. Never mark work complete with a failing or skipped test. If you cannot make a
test pass, say so explicitly in your pull request — do not delete it, do not `.skip` it, do not
weaken the assertion.

### Table-driven tests

Go's table-driven tests map to `it.each` / a `for` loop over a `const tests = [...]` array. Keep the
case names identical to Go's so a reviewer can grep both suites.

---

## 5. Golden fixtures — how we prove 100% compatibility

`fixtures/gen/` is a **Go program that imports the real Tessera** and emits its outputs as JSON into
`fixtures/data/`. Those files are committed. TypeScript tests load them and assert byte-equality.

This is the primary evidence of compatibility, and it is auditable: anyone can run `bun run fixtures`
(which first runs `bun run upstream`) and confirm `git status --porcelain fixtures/data` stays empty. CI
does exactly that on every push. `fixtures/README.md` explains the corpus and how to audit it.

- Fixtures are JSON. Byte arrays are lower-case hex strings. `uint64` values are JSON **strings**
  (they must survive round-tripping without precision loss).
- Never hand-edit a file in `fixtures/data/`. If a fixture is wrong, fix the generator and re-run
  `bun run fixtures`.
- Never change a fixture to make a TypeScript test pass. **The fixture is right and your port is
  wrong.** If you genuinely believe the fixture is wrong, stop and raise it in the pull request or
  an issue — do not quietly regenerate or adjust it.
- Add a generator case whenever you port something byte-producing. Generator code is Go and its
  comments are English. The generator calls upstream and records what came back; it must never
  compute a hash, path or encoding itself.

---

## 6. ADRs — how decisions get made

Every one of these requires an ADR in `docs/decisions/NNNN-kebab-title.md`, copied from
`0000-template.md`:

- Not porting an upstream file, package, or function.
- Any behavioural divergence from Go, however small.
- Any added API that upstream does not have.
- Any dependency added to `package.json` that ships (`dependencies`); a tooling `devDependency`
  needs a one-sentence justification in its pull request instead.
- Any choice where you found yourself thinking "I'll just do it the TypeScript way".

**An ADR is not in force until someone other than its author has reviewed it.** The template has a
`## Review` section with `Reviewer:` and `Verdict:` fields. The author proposes; the reviewer
challenges, requests changes, or approves. If they disagree, both positions get written down and the
maintainers decide — do not silently settle it. `docs/REVIEW-PROTOCOL.md` describes what a reviewer
checks.

ADRs are historical records. Do not rewrite an accepted one to match later thinking: supersede it
with a new ADR and mark the old one's status accordingly. Take the next unused number; if two pull
requests collide, the later one renumbers.

`docs/notes/` is for free-form thinking that is not yet a decision. Use it liberally; it keeps
speculation out of the code comments.

---

## 7. Dependencies and runtime constraints

Runtime dependencies of the library (`dependencies` in `package.json`): **`@noble/hashes`,
`@noble/curves`, and nothing else.** They are audited, zero-dependency, synchronous, and run
identically in Node, browsers, and workerd.

> noble v2 exports carry an explicit `.js` extension. Import
> `from "@noble/hashes/sha2.js"` and `from "@noble/curves/ed25519.js"`. Without the extension the
> import fails to resolve.

- No Node built-ins (`node:crypto`, `node:buffer`, `node:fs`) in code under `src/` that ships. This
  code runs on the edge and in a browser tab.
- No `Buffer`. No `process`. No `setTimeout`-based control flow that assumes Node timers.
- Anything else requires an ADR, and the bar is "there is no other way".
- No `any` anywhere in library code (§3.8, §10). Go's `any` becomes a type parameter or `unknown`.
- Test-only code (`*_test.ts`, `testing/`, `src/testonly/`) is excluded from the published build and
  may use test tooling, but must not leak into the exports map.

---

## 8. Web storage drivers

Upstream ships storage drivers for POSIX, GCP, AWS and MySQL. None of them runs in a browser tab or
a Worker, so this repository ships its own. They are the one place where the code is new rather than
translated, and they are held to the same standard: a driver bolts onto the *upstream* interfaces
(`Driver`, `LogReader`, `Antispam`, `Follower`) from the outside. If a driver needs an upstream
interface to change, that is an ADR and probably a design smell — say so.

The design (ADR-0100) has three layers:

- **The `ObjectStore` contract** — `src/storage/objectstore/objectstore.ts`. Six operations: `get`,
  `stat`, `put`, `create` (create-if-absent, the counterpart of `O_CREAT|O_EXCL`), `deletePrefix`
  and `lock`. Keys are slash-separated tlog-tiles paths (`checkpoint`, `tile/0/x001/234`,
  `tile/entries/000.p/7`), with the driver's private state under `.state/`, so a backend holds a
  byte-for-byte copy of a static tlog-tiles log. Every operation is atomic per key and resolves only
  once durable for that backend; `lock` excludes every holder that can reach the same data and
  honours an `AbortSignal`. Read the file; its doc comments are the specification.
- **The driver** — a port of `storage/posix/files.go`, parametrised by an `ObjectStore` instead of a
  filesystem. It lives next to the contract in `src/storage/objectstore/` and is the only place
  that knows how a Tessera log maps onto keys. Fidelity rules apply to it exactly as to any other
  port: the golden `log_<N>` fixtures were produced by the real POSIX driver, and what this driver
  writes for the same entries is judged against them.
- **The backends** — one directory each, each implementing nothing but `ObjectStore`:
  - `src/storage/memory/` — in memory; the reference backend, for tests and for offline or
    ephemeral logs.
  - `src/storage/indexeddb/` — IndexedDB for persistence; cross-tab exclusion through Web Locks.
    Tested in real Chromium (`bun run test:browser`, `*_browser_test.ts`).
  - `src/storage/sqlite/` — any SQLite engine, through one structurally typed adapter per engine
    (`adapters/`), with in-process or lease locking and fencing (ADR-0150 to ADR-0155). Tested on
    node:sqlite and libSQL in Node, sqlite-wasm in Chromium, D1 and Durable Objects in workerd
    (`bun run test:workers`, `*_workers_test.ts`) and live rqlite (`bun run test:services`,
    `*_services_test.ts`).

Adding or changing a backend:

1. Implement `ObjectStore`; do not add operations to the contract without an ADR.
2. Call `describeObjectStoreConformance` from `src/storage/objectstore/testing/conformance.ts` in
   the backend's test file, with a factory for fresh empty stores. Every backend is held to the same
   behaviour by that one suite; fix the backend, not the suite, when they disagree.
3. Call `describeDriverConformance` from `testing/driver_conformance.ts`, and
   `describeGoldenCompatibility` from `testing/golden.ts`: the golden suite proves the backend
   writes byte-for-byte what the real Tessera writes for the same entries. A backend that does not
   pass it is not done. If it runs in Node, add it to `bun run interop` too (`scripts/interop/`), so
   that Tessera's Go client verifies a log it wrote, and it continues a log Go wrote.
4. Put runtime-specific tests where the right runner picks them up by suffix: `*_browser_test.ts`
   (Chromium), `*_workers_test.ts` (workerd), `*_services_test.ts` (live servers) — and keep
   `testing/` helpers out of the published build.
5. Update `examples/` and the README's driver table if the backend is something a user would reach
   for.

---

## 9. File header

Ports of upstream Apache-2.0 files (Tessera, `transparency-dev/merkle`, `transparency-dev/formats`):

```ts
// Copyright 2024 The Tessera authors. All Rights Reserved.
// Copyright 2026 MedDeck LTDA. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// ... (full Apache-2.0 header, verbatim from the upstream file)
//
// Ported from tessera/api/layout/paths.go @ 4a6d9f9
```

Keep the upstream copyright year and holder exactly as the original file has it (some are
"Google LLC", some are "The Tessera authors"). New files that are ours carry only the MedDeck line
and the Apache-2.0 header.

**Derivatives of Go-licensed code are BSD-3-Clause, not Apache-2.0.** `golang.org/x/mod/sumdb/note`,
`golang.org/x/crypto/cryptobyte`, the Go standard library (`container/list`) and
`transparency-dev/formats/note`'s cosignature code carry "The Go Authors" copyright and a BSD-style
notice upstream. Their ports keep the Go Authors line and the BSD notice, add the MedDeck line, and
do **not** get the Apache header (ADR-0024, ADR-0040):

```ts
// Copyright 2019 The Go Authors. All rights reserved.
// Copyright 2026 MedDeck LTDA. All Rights Reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in LICENSES/BSD-3-Clause-Go.txt.
//
// Ported from golang.org/x/mod/sumdb/note/note.go @ v0.31.0
```

The licence text itself lives in `LICENSES/`, and `NOTICE` attributes each third-party source. If a
change brings in code from a new origin, add its licence text to `LICENSES/` and an entry to `NOTICE`
in the same pull request. Never "tidy" a BSD header into an Apache one: relicensing someone else's
code is not ours to do.

**Mixed files.** When only part of a file is translated from third-party code (for example
`src/internal/gostd/bytes.ts`, whose base64 decoder transcribes Go's `encoding/base64`), the header
carries both copyright lines, a sentence naming the derived declarations, the Apache-2.0 notice for
the rest of the file, and the third-party licence text; each derived declaration also says what it is
derived from. Upstream notices embedded in a file (such as Sunlight's ISC notice in
`src/ctonly/ct.ts`) are carried over verbatim.

---

## 10. Definition of done, per pull request

Do not report success unless all of these are true. State each one explicitly in the pull request.

- [ ] Every Go file in scope has a TS counterpart at the mirrored path, or an ADR saying why not.
- [ ] Every Go **test** file in scope has a TS counterpart with the same cases.
- [ ] `bun run lint` is clean.
- [ ] `bun run typecheck` passes with zero errors.
- [ ] `bun run test:unit` passes. Paste the real summary line.
- [ ] `bun run test:browser` and `bun run test:workers` pass when you touched `src/storage/` or anything
      runtime-sensitive (CI runs both regardless).
- [ ] Golden fixtures asserted for everything byte-producing, and `bun run fixtures` leaves
      `git status --porcelain fixtures/data` empty.
- [ ] `docs/PORTING-MAP.md` updated.
- [ ] ADRs written for every divergence and every omission.
- [ ] No `any`, no `@ts-expect-error`, no `.skip`, no commented-out code, no `console.log`.
- [ ] No Node built-ins or `Buffer` in library code; no new runtime dependency without an ADR.
- [ ] File headers follow §9; `NOTICE` and `LICENSES/` updated if the change brings in code from a
      new origin.
- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]` for any user-visible change.

If something is incomplete, **say so plainly and list what is missing**. A precise report of partial
work is far more useful than a confident claim that turns out to be wrong. Do not describe a test as
passing unless you ran it and saw it pass.
