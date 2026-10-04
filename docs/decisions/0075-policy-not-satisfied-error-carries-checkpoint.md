# ADR-0075: `PolicyNotSatisfiedError` carries the partial checkpoint, and sets `cause` directly

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** witness/migrate agent
- **Upstream reference:** `internal/witness/witness.go`'s `(*WitnessGateway).Witness`, `ErrPolicyNotSatisfied`

## Context

When no combination of witness responses satisfies the group's policy, Go returns **both** a value
and an error:

```go
return sigBlock.Bytes(), errors.Join(ErrPolicyNotSatisfied, err)
```

`sigBlock.Bytes()` is the checkpoint accumulated so far, with whatever signatures did successfully
verify — a caller might reasonably want that partial result even on failure (e.g. to log which
witnesses did respond). `AGENTS.md` §3.7/ADR-0004 both flag this "Go returns a value and an error"
shape as something throwing loses by default and that needs individual attention per call site that
hits it; this is one of them.

Separately, `errors.Join(ErrPolicyNotSatisfied, err)` is built specifically so
`errors.Is(returnedErr, ErrPolicyNotSatisfied)` succeeds — Go's `errors.Join` implements
`Unwrap() []error`, which `errors.Is` walks. `src/internal/gostd/errors.ts`'s `joinErrors`/`JoinError`
does **not** implement the equivalent fan-out for `errorIs`: `errorIs` only walks a single `cause`
chain, and ADR-0004's own review notes record this as a known, deliberate gap ("`errorIs`/`errorAs` do
not handle the Go 1.20 multi-error `Unwrap() []error` fan-out ... neither reachable by any current
caller"). This work package *is* such a caller: mechanically translating
`errors.Join(ErrPolicyNotSatisfied, err)` into `joinErrors([ErrPolicyNotSatisfied, err])` would make
`errorIs(caught, ErrPolicyNotSatisfied)` silently return `false`, breaking the one thing
`ErrPolicyNotSatisfied` being an exported sentinel is *for* — callers checking for this specific
condition the same way `log.go`'s `ErrPushback` is checked (`AGENTS.md` §3.6).

## Decision

`src/internal/witness/witness.ts` exports `PolicyNotSatisfiedError extends Error`:

- `checkpoint: Uint8Array` carries the value half of Go's pair — the under-signed checkpoint
  accumulated before giving up.
- `witnessErrors: readonly unknown[]` carries every per-witness failure collected during the attempt
  (the `err` Go accumulates via `errors.Join(err, r.err)` inside its loop), for diagnostics.
- The constructed `Error`'s `cause` is set **directly** to `ErrPolicyNotSatisfied` (not through
  `joinErrors`), so `errorIs(caught, ErrPolicyNotSatisfied)` succeeds via the ordinary single-link
  `cause` chain `errorIs` already walks correctly. The message text concatenates
  `ErrPolicyNotSatisfied.message` with each witness error's message, one per line — the same
  human-readable content `errors.Join`'s `.Error()` would have produced, just reached without relying
  on the unsupported multi-error walk.

## Consequences

- A caller can write `errorIs(err, ErrPolicyNotSatisfied)` and get the correct answer, and can also
  recover the partial checkpoint via `err instanceof PolicyNotSatisfiedError ? err.checkpoint : ...`
  if it wants Go's full return-pair behaviour.
- This is a new, donatable public symbol (`PolicyNotSatisfiedError`) with no direct Go counterpart
  (Go expresses the same information as an untyped `errors.Join` result plus a separate return
  value) — flagged here per `AGENTS.md` §6 ("any added API that upstream does not have").
- `witnessErrors` is `readonly unknown[]`, not `readonly Error[]`, because Go's own `err` accumulator
  is `error` (an interface), and this port's per-witness failures already arrive as `unknown` from
  the `.then(sig, err)` settlement in `WitnessGateway.witness` (see ADR-0072).
- This does not touch `gostd/errors.ts`'s shared, already-reviewed `JoinError`/`joinErrors` — a file
  owned by a different, completed work package. If a *second* real caller needs `errors.Join`'s full
  multi-error `errorIs` fan-out, that is the trigger ADR-0004's review notes anticipated for revisiting
  `JoinError` itself; this ADR works around the gap locally instead of reopening that file.

## Alternatives considered

- **Add `Unwrap(): unknown[]`-style fan-out support to `JoinError`/`errorIs` in `gostd/errors.ts`.**
  Would fix the gap generally, matching Go's `errors.Join` exactly. Rejected for this landing: it
  modifies a shared, already-reviewed file outside this work package's ownership, for a single call
  site, when a local, equally-correct fix (setting `cause` directly) exists. Worth revisiting if a
  second caller needs it — noted here for whoever does.
- **Throw a plain `Error` with `cause: joinErrors([ErrPolicyNotSatisfied, ...witnessErrors])` and
  accept that `errorIs` cannot find `ErrPolicyNotSatisfied`.** Rejected: this silently breaks the
  sentinel's entire purpose, and nothing about it is discoverable without reading `gostd/errors.ts`'s
  internals — exactly the kind of "quiet infidelity" `AGENTS.md`'s fidelity rules exist to prevent.
- **Drop the partial checkpoint entirely, matching a plain `throw new Error(...)`.** Simpler, but an
  unforced loss of information Go's return signature deliberately preserves.

## Review

- **Reviewer:** Witness/Migrate Reviewer (agent)
- **Verdict:** approved
- **Notes:** Checked against Go's `return sigBlock.Bytes(), errors.Join(ErrPolicyNotSatisfied, err)`.
  Setting `cause` directly to `ErrPolicyNotSatisfied` (not via `joinErrors`) is correct and
  necessary: `gostd/errors.ts`'s `errorIs` walks only the single `.cause` link, not `JoinError`'s
  `.errors` fan-out (the known gap ADR-0004's review recorded), so `joinErrors([ErrPolicyNotSatisfied,
  ...])` would make `errorIs(caught, ErrPolicyNotSatisfied)` silently return `false` — breaking the
  one thing the exported sentinel exists for. `checkpoint` carries Go's value-half (the under-signed
  block); `witnessErrors` carries the per-witness failures Go accumulates via
  `errors.Join(err, r.err)`. Message text (`ErrPolicyNotSatisfied.message` + each witness message,
  newline-joined) reproduces `errors.Join`'s `.Error()` output without relying on the unsupported
  walk. `witnessErrors: readonly unknown[]` is justified — Go's accumulator is `error` and the
  settlements arrive as `unknown` (ADR-0072). Correctly scoped as a local fix rather than reopening
  the shared, already-reviewed `gostd/errors.ts`. New public symbol flagged per AGENTS.md §6.

## Update (2026-10-02)

The gap this ADR works around is closed: `errorIs` and `errorAs` in `gostd/errors.ts` now walk
`JoinError.errors` depth-first, as Go's `errors.Is` and `errors.As` walk `Unwrap() []error` (see the
update to ADR-0057). The decision above still holds and is still correct: `PolicyNotSatisfiedError`
sets `cause` to `ErrPolicyNotSatisfied`, so `errorIs(e, ErrPolicyNotSatisfied)` succeeds, and the message
text is unchanged. What no longer holds is the reason given for not using `joinErrors`: building the
error with `joinErrors([ErrPolicyNotSatisfied, ...witnessErrors])` would now also satisfy `errorIs`. This
update changes no code; whether to switch to `joinErrors`, which would also let `errorIs` find each
witness's own error, is for the owner of `internal/witness/witness.ts`, whose comment on
`PolicyNotSatisfiedError` still describes the old gap.

*Review of this update: approved, ADR review agent (independent), 2026-10-04.* The claim is that the gap the ADR worked around is closed: `errorIs`/`errorAs`
walk `JoinError.errors` depth-first (checked against Go's `errors.is` in 1.25.5 and by running `errors_test.ts`, 31 cases, in my review of ADR-0004 and ADR-0057), so
building the error with `joinErrors` would now satisfy `errorIs`, and the reason given in the Decision for not using it no longer holds. The update changes no code and says
so; the Decision's observable results (`errorIs(e, ErrPolicyNotSatisfied)` true, message text) are unchanged, as the second update confirms.

## Update (2026-10-02): `PolicyNotSatisfiedError` is now a `JoinError`

Following the update above, the workaround is removed. `PolicyNotSatisfiedError` extends `JoinError`,
joining `ErrPolicyNotSatisfied` with `joinErrors(witnessErrors)` (or `ErrPolicyNotSatisfied` alone when
there are none) — the structure of Go's `errors.Join(ErrPolicyNotSatisfied, err)`. It no longer sets
`cause`. `errorIs(e, ErrPolicyNotSatisfied)` still succeeds, now through the joined list, and `errorIs`
for any one witness's error now succeeds too, as `errors.Is` does in Go. The message text is unchanged
(`errors.Join` renders the same lines). `checkpoint` and `witnessErrors` are kept. The class's comment in
`internal/witness/witness.ts` describes this. Test: "a policy failure is ErrPolicyNotSatisfied and each
witness error, as errors.Join makes it" in `witness_test.ts`.

*Review of this update: approved, ADR review agent (independent), 2026-10-04.* Go's `Witness` ends `return sigBlock.Bytes(), errors.Join(ErrPolicyNotSatisfied, err)`
where `err` is the accumulation `err = errors.Join(err, r.err)` over failed witnesses and over responses that do not end in a newline
(`invalid signature from witness: %q`). `PolicyNotSatisfiedError` in `src/internal/witness/witness.ts` extends `JoinError` with
`[ErrPolicyNotSatisfied]` or `[ErrPolicyNotSatisfied, joinErrors(witnessErrors)]`, no longer sets `cause`, and keeps `checkpoint` and `witnessErrors`; the loop in
`WitnessGateway.witness` pushes both kinds of failure (including the `invalid signature` one, text via `quote`) into `witnessErrors`, so the joined set is Go's. The top
level has Go's shape. Below it Go's accumulation nests (`Join(Join(nil, e1), e2)` is a join of a join and `e2`) where the port joins `witnessErrors` flat; `Is`, `As` and the
message (newline-joined lines) cannot tell the two apart, only the `errors` array's shape can, and nothing reads that. The test "a policy failure is ErrPolicyNotSatisfied and
each witness error, as errors.Join makes it" (`internal/witness/witness_test.ts:602`) asserts `errorIs(err, ErrPolicyNotSatisfied)`, the two-line message and `checkpoint`; it does not assert
`errorIs` for the witness's own error, which the update also claims. That follows from the depth-first traversal tested in `errors_test.ts` ("finds a target joined at any depth"), so I
accept it, but a one-line assertion would pin it. 30 cases of `internal/witness/witness_test.ts` pass. Not blocking.
