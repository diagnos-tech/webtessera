# PORTING.md — webtessera

**Read this file completely before writing a single line of code.** It is the contract that
lets many contributors produce one coherent codebase.

---

## 1. What this project is

`webtessera` is a **faithful TypeScript port of [Tessera](https://github.com/transparency-dev/tessera)**,
Google/transparency-dev's tile-based transparency log framework, targeting **browsers and edge
runtimes** (Cloudflare Workers / Durable Objects) instead of servers and cloud object stores.

**The upstream Go source of truth lives at `/home/gg/dev/Maravi/_future/tessera`.**
Pinned at commit `4a6d9f9`. Its vendored dependencies live in the Go module cache:

| Go import path | Local path |
| --- | --- |
| `github.com/transparency-dev/tessera` | `/home/gg/dev/Maravi/_future/tessera` |
| `github.com/transparency-dev/merkle` | `~/go/pkg/mod/github.com/transparency-dev/merkle@v0.0.2` |
| `github.com/transparency-dev/formats` | `~/go/pkg/mod/github.com/transparency-dev/formats@v0.0.0-20251017110053-404c0d5b696c` |
| `golang.org/x/mod/sumdb/note` | `~/go/pkg/mod/golang.org/x/mod@v0.31.0/sumdb/note` |

### The goal that overrides every other goal

This codebase is **intended to be donated to the transparency-dev / C2SP community**. It will be
read by the people who wrote the original. That means:

- **Fidelity beats cleverness.** If Go does something in a way that looks odd, port it that way and
  find out *why* before changing it. The Tessera authors already learned the lessons of Trillian v1;
  their odd-looking choices are usually scar tissue, not accidents.
- **Every upstream comment carries absolute weight.** Comments in the Go source are part of the
  specification. Port them. Do not summarise them. Do not "improve" them.
- **No invention.** You are not designing a transparency log. You are translating one.

---

## 2. Directory layout

```
packages/webtessera/
├── PORTING.md                  ← this file
├── docs/
│   ├── PORTING-MAP.md         ← file-by-file Go→TS status table (KEEP UPDATED)
│   ├── decisions/             ← ADRs. Every divergence from Go lives here.
│   │   └── 0000-template.md
│   └── notes/                 ← free-form design discussion, scratch analysis
├── fixtures/
│   ├── gen/                   ← Go program that emits golden fixtures from real Tessera
│   └── data/                  ← generated fixtures, COMMITTED to the repo
└── src/
    ├── vendor/                ← ports of Go deps that have no TypeScript equivalent
    │   ├── merkle/{rfc6962,compact,proof,testonly}/
    │   ├── note/              ← golang.org/x/mod/sumdb/note
    │   └── formats/log/       ← github.com/transparency-dev/formats/log
    ├── api/                   ← mirrors tessera/api
    ├── internal/              ← mirrors tessera/internal
    ├── storage/
    │   ├── internal/          ← mirrors tessera/storage/internal
    │   ├── memory/            ← NEW (web): in-memory driver, the `posix` of the browser
    │   ├── indexeddb/         ← NEW (web): browser persistence
    │   ├── durableobject/     ← NEW (edge): Cloudflare DO persistence
    │   └── s3/                ← NEW (web): S3-compatible object store via @repo/magic-files
    ├── client/                ← mirrors tessera/client
    ├── fsck/                  ← mirrors tessera/fsck
    ├── ctonly/                ← mirrors tessera/ctonly
    ├── testonly/              ← mirrors tessera/testonly
    ├── *.ts                   ← mirrors tessera root package (entry.ts, append_lifecycle.ts, …)
    └── adapters/              ← OURS. NOT donated. See §8.
```

### The donation boundary

Everything **except `src/adapters/`** is donatable. `src/adapters/` is diagnos-specific glue and
must never be imported by anything outside it. Enforced by review: if a file under `src/api`,
`src/storage/internal`, `src/client`, `src/vendor` or the root imports from `src/adapters/`, that is
a **blocking** review finding.

---

## 3. Fidelity rules

### 3.1 File names — identical to Go

`append_lifecycle.go` → `append_lifecycle.ts`. `ct_only.go` → `ct_only.ts`.
Yes, snake_case is unusual in TypeScript. It is deliberate: it makes a side-by-side diff against
the original trivial for a reviewer, which is the single most valuable property this codebase can
have. Directory names are identical too.

Test files: `paths_test.go` → `paths_test.ts` (**not** `paths.test.ts`). Vitest is configured to
pick up `*_test.ts`.

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
TypeScript expresses visibility with `export`. A donated TS library with `NewEntry()` reads as a
bad transliteration; `newEntry()` is the faithful rendering of the same intent. Types and constants
keep their exact Go spelling because PascalCase/SCREAMING_CASE means the same thing in both
languages. **This mapping is mechanical: never rename beyond it, never "improve" a name.**

### 3.3 Declaration order — identical to Go

Keep declarations in the same order they appear in the Go file. A reviewer must be able to scroll
both files in parallel.

### 3.4 Comments

- **Ports (everything outside `src/adapters/`): comments in English.**
  Copy the upstream comment verbatim when it still applies. Adjust only the parts that are
  language-specific (`[]byte` → `Uint8Array`, `os.ErrNotExist` → `ErrNotExist`). Keep the Go
  doc-comment convention of starting with the identifier name.
- Where the port diverges from Go, add a short `// Port note:` paragraph explaining *why*, and link
  the ADR: `// Port note: see docs/decisions/0003-uint64-as-bigint.md`.
- **`src/adapters/`: comments in Portuguese (pt-BR), senior level** — matching the rest of the
  diagnos monorepo.
- Do not write comments that restate the code. Do not write phase/plan/TODO-list narration in code.
  Pending work is `TODO(gustavo):` and nothing else.
- Every file keeps the upstream Apache-2.0 header when it is a port of an upstream file, with the
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
- Use the helpers in `src/internal/errors.ts`. Do not hand-roll error identity checks.
- `os.ErrNotExist` maps to the exported `ErrNotExist` sentinel — several upstream interfaces are
  specified in terms of it (`LogReader.readCheckpoint`).

### 3.7 Async

Everything that takes a `context.Context` in Go returns a `Promise` in TypeScript. Everything that
does not, stays synchronous — in particular **the Merkle hashing and proof code is synchronous**
(that is why we use `@noble/hashes` and not WebCrypto's async `subtle.digest`).

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
test pass, say so explicitly in your report — do not delete it, do not `.skip` it, do not weaken
the assertion.

### Table-driven tests

Go's table-driven tests map to `it.each` / a `for` loop over a `const tests = [...]` array. Keep the
case names identical to Go's so a reviewer can grep both suites.

---

## 5. Golden fixtures — how we prove 100% compatibility

`fixtures/gen/` is a **Go program that imports the real Tessera** and emits its outputs as JSON into
`fixtures/data/`. Those files are committed. TypeScript tests load them and assert byte-equality.

This is the primary evidence of compatibility, and it is auditable: a reviewer can regenerate the
fixtures and diff them.

- Fixtures are JSON. Byte arrays are lower-case hex strings. `uint64` values are JSON **strings**
  (they must survive round-tripping without precision loss).
- Never hand-edit a file in `fixtures/data/`. If a fixture is wrong, fix the generator and re-run
  `bun run fixtures`.
- Never change a fixture to make a TypeScript test pass. **The fixture is right and your port is
  wrong.** If you genuinely believe the fixture is wrong, stop and escalate in your report.
- Add a new generator case whenever you port something byte-producing. Generator code is Go and its
  comments are English.

---

## 6. ADRs — how decisions get made

Every one of these requires an ADR in `docs/decisions/NNNN-kebab-title.md`, copied from
`0000-template.md`:

- Not porting an upstream file, package, or function.
- Any behavioural divergence from Go, however small.
- Any added API that upstream does not have.
- Any dependency added to `package.json`.
- Any choice where you found yourself thinking "I'll just do it the TypeScript way".

**An ADR is not valid until a reviewer has signed it.** The template has a `## Review` section
with `Reviewer:` and `Verdict:` fields. Implementing contributor proposes; reviewer challenges,
requests changes, or approves. If they disagree, both positions get written down and it escalates to
the maintainers — do not silently settle it.

`docs/notes/` is for free-form thinking that is not yet a decision. Use it liberally; it keeps
speculation out of the code comments.

---

## 7. Dependencies

Allowed in donatable code: **`@noble/hashes`, `@noble/curves`, and nothing else.** They are audited,
zero-dependency, synchronous, and run identically in Node, browsers, and workerd.

> noble v2 exports carry an explicit `.js` extension. Import
> `from "@noble/hashes/sha2.js"` and `from "@noble/curves/ed25519.js"`. Without the extension the
> import fails to resolve — this has already cost one debugging round, do not repeat it.

- No Node built-ins (`node:crypto`, `node:buffer`, `node:fs`). This code runs on the edge.
- No `Buffer`. No `process`. No `setTimeout`-based control flow that assumes Node timers.
- Anything else requires an ADR, and the bar is "there is no other way".
- `src/adapters/` may depend on `@repo/*` workspace packages (`magic-files`, `security-module`,
  `core`, `editor`). Donatable code may not.

---

## 8. `src/adapters/` — ours, not donated

Comments in Portuguese. This is where diagnos-specific behaviour lives:

- **`session/`** — every server API call becomes an immutable entry in a per-session log. The server
  countersigns each append against the previous hash, so the user holds a tamper-evident receipt of
  their whole session and cannot forge it.
- **`magic-files/`** — level-2 sync: pushes tiles/bundles/checkpoints into the workspace vault
  through `@repo/magic-files`.
- **`firestore/`** — Firestore as a backup for IndexedDB, and the leader election that decides which
  tab/client flushes, via `@repo/security-module`'s election primitives.
- **`editor/`** — exports a session's commits into a read-only `@repo/editor` document, for the
  "export session" debug affordance.

Adapters bolt onto the *upstream* interfaces (`LogReader`, `Driver`, `Antispam`, `Follower`). If an
adapter needs an upstream change to work, that is an ADR and probably a design smell — say so.

---

## 9. File header

Ports of upstream files:

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
"Google LLC", some are "The Tessera authors"). New files that are ours carry only the MedDeck line.

---

## 10. Definition of done, per assignment

Do not report success unless all of these are true. State each one explicitly in your report.

- [ ] Every assigned Go file has a TS counterpart at the mirrored path, or an ADR saying why not.
- [ ] Every assigned Go **test** file has a TS counterpart with the same cases.
- [ ] `bun run test:unit` passes from `packages/webtessera`. Paste the real summary line.
- [ ] `bun run typecheck` passes with zero errors. Paste the real output.
- [ ] Golden fixtures asserted for everything byte-producing.
- [ ] `docs/PORTING-MAP.md` updated.
- [ ] ADRs written for every divergence and every omission.
- [ ] No `any`, no `@ts-expect-error`, no `.skip`, no commented-out code, no `console.log`.
- [ ] Nothing outside `src/adapters/` imports from `src/adapters/`.

If something is incomplete, **say so plainly and list what is missing**. A precise report of partial
work is far more useful than a confident claim that turns out to be wrong. Do not describe a test as
passing unless you ran it and saw it pass.
