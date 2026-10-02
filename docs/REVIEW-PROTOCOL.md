# Review protocol

How ports, ADRs and pull requests are reviewed in this repository. Every change is reviewed by
someone who did **not** write it. This file is the reviewer's checklist; read it together with
[`AGENTS.md`](../AGENTS.md), which holds the rules being checked. A reviewer may be a maintainer, a
contributor or an AI agent — the checklist is the same.

The people who wrote the original may well read this code. Review accordingly.

---

## 1. Your posture

You are not proof-reading TypeScript. **You are checking a translation against its source.**

Open the Go file and the TypeScript file side by side and go through them line by line. If you find
yourself reviewing the TypeScript on its own merits — "this could be a `map`", "this name is a bit
long" — you have drifted off the job. The question is only ever: *does this do what the Go does?*

Assume the contributor was competent and hurried. The bugs you are looking for are not sloppy ones;
they are the ones that come from translating an idiom without noticing it carried meaning.

Upstream Tessera is available at the pinned commit with `pnpm upstream` (`.upstream/tessera`); the Go
dependencies it needs are in the Go module cache once `pnpm fixtures` has run once.

## 2. What to check, in priority order

### 2.1 Fidelity (blocking)

- **Every** exported symbol in the Go file exists in the TypeScript file, under the ADR-0002 mapping.
  Missing symbols are the most common defect and the easiest to miss — enumerate them explicitly,
  do not eyeball it.
- Declaration order matches.
- Behaviour matches on every branch, including error branches. Walk each `if err != nil`.
- **Error message text is identical.** Upstream tests assert on it.
- Upstream comments are present and unmangled. A comment that was silently dropped is a blocking
  finding: comments are specification here (`AGENTS.md` §1).
- Boundary conditions: empty input, size 0, size 1, exactly 256, 257, partial tiles, `MaxUint64`.
- Integer widths: `uint64` → `bigint`, everything narrower → `number` (ADR-0003). Look hard for a
  `Number(...)` that silently truncates, and for `bigint`/`number` mixing patched with a cast.

### 2.2 Correctness traps specific to this port

- **Off-by-one in tile/partial-tile arithmetic.** The highest-yield place to look.
- **Signedness and shifts.** Go's `>>` on unsigned is a logical shift. JavaScript's `>>` on `number`
  is *arithmetic* on a 32-bit signed value and will produce garbage above 2^31. On `bigint`, `>>` is
  an arithmetic shift on an arbitrary-precision signed value, which matches Go for non-negatives —
  but check for negatives.
- **Bit intrinsics.** `bits.TrailingZeros64`, `bits.OnesCount64`, `bits.Len64` reimplemented for
  `bigint`. Check `0`, `1`, every power of two, and `MaxUint64` specifically.
- **Slice aliasing.** Go slices share backing arrays; `Uint8Array.subarray` does too, `slice` does
  not. Where upstream relies on a copy, the port must copy; where upstream relies on aliasing, the
  port must alias. Both directions are real bugs.
- **`await` inside a critical section.** Per ADR-0004, a synchronous Go critical section needs no
  lock, but one spanning an `await` does. Check each dropped mutex individually and confirm the
  `// Port note:` justifying it is actually true.
- **UTF-8.** Go's `[]byte(s)` is UTF-8. A port using `charCodeAt` corrupts anything non-ASCII.
- **Map iteration order.** Go's is randomised, JavaScript's is insertion-ordered. If upstream sorts
  before emitting, the port must sort too — even though its map "happens to" be ordered. Relying
  on that accident is a latent bug.

### 2.3 Tests (blocking)

- Every Go test file has a TypeScript counterpart, with the same cases and the same values.
- **Run the suite yourself** (`pnpm test:unit`, plus `pnpm test:browser` / `pnpm test:workers` for
  storage changes). Do not trust the author's report.
- Look for tests that pass vacuously: an assertion on a value the test itself computed with the code
  under test, a `try/catch` that swallows, a table with an empty case list, a loop with no iterations.
- Any `.skip`, `.only`, `@ts-expect-error`, `any`, or commented-out test is a blocking finding.
- Golden fixtures: confirm the fixture is actually asserted against, and that **the port was changed
  to match the fixture, not the fixture changed to match the port**. Check `git log`/`git diff` on
  `fixtures/data/` if anything looks convenient, and confirm `pnpm fixtures` leaves
  `git status --porcelain fixtures/data` empty.

### 2.4 ADRs (blocking)

- Every divergence from Go has an ADR. Every upstream file not ported has an ADR.
- **Challenge them.** An ADR that only lists the reasons its author was right is not a decision
  record. Push back where the reasoning is thin, especially on omissions.
- Sign the `## Review` section: `Reviewer:`, `Verdict:` (approved / changes requested / disputed),
  and `Notes:` saying **what you actually checked against the Go source**.
- If you and the author disagree, **write both positions into the ADR and escalate to the
  maintainers**. Do not quietly settle it, and do not defer to the author because they know the
  code better — the whole point of a second reader is that they are not invested in the first
  answer.

### 2.5 Hygiene (non-blocking unless egregious)

No `console.log`. No Node built-ins or `Buffer` in library code. Runtime dependencies limited to
`@noble/*` (`AGENTS.md` §7). Comments in English. File headers follow `AGENTS.md` §9, and code from a
new third-party origin comes with its licence text in `LICENSES/` and an entry in `NOTICE`. A
user-visible change has a `CHANGELOG.md` entry.

### 2.6 Web storage drivers (no Go original)

The `ObjectStore` contract, the driver and the memory, IndexedDB and Durable Object backends
(`AGENTS.md` §8) have no Go file to be compared with, so the questions change:

- Does the backend honour every sentence of the contract in `src/storage/objectstore/objectstore.ts`
  — atomicity per key, durability before a promise resolves, `create` as create-if-absent, `lock`
  excluding every holder that can reach the data and honouring its `AbortSignal`?
- Does it run the shared `describeObjectStoreConformance` suite unmodified, in the runtime it
  targets (real Chromium, workerd), not only against a Node fake?
- Does the driver stay a faithful port of `storage/posix/files.go` where it can, with every
  departure explained in an ADR, and does it write what the golden `log_<N>` fixtures say a log
  contains?

## 3. Fix what you find

You are not writing a memo. Where you can, **fix the defects you find** — push to the branch if you
are allowed to, otherwise propose the exact change — then re-run the checks.

Two exceptions, which you escalate instead of fixing:

- A disagreement about a *decision* (an ADR). Write both positions down; the maintainers resolve it.
- A defect whose fix would change an interface other work depends on (published API, or another
  pull request in flight). Report it clearly with the proposed change so it can be sequenced,
  rather than breaking someone else's build underneath them.

## 4. Your report

State plainly, with real pasted command output:

1. **Verdict:** approved / changes requested / disputed.
2. Files reviewed, and for each, whether you read the Go original **in full**.
3. Defects found, with severity, and for each: fixed by you, or escalated and why.
4. `pnpm test:unit` result **after** any fixes. Paste the summary line.
5. `pnpm lint` and `pnpm typecheck` results after any fixes. Paste the output.
6. ADRs signed, and any you disputed.
7. **Anything you could not verify**, and why.

Item 7 is the one that matters most. A review that says "I could not confirm the partial-tile
behaviour above size 2^32 because there is no fixture for it" is worth more than one that says
everything looks good. **Never report a clean review you did not actually perform**, and never
describe a test as passing unless you ran it and watched it pass.
