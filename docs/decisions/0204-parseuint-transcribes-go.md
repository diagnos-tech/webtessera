# ADR-0204: `parseUint` transcribes Go's `strconv.ParseUint`, and bounds the input it quotes

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** hardening agent
- **Upstream reference:** Go `strconv/atoi.go` (`ParseUint`, `NumError`, `ErrSyntax`, `ErrRange`, `underscoreOK`) and `strconv/quote.go`/`strconv/isprint.go` (`Quote`, `IsPrint`), Go 1.25.5

## Context

`src/internal/gostd/strconv.ts` stood in for `strconv.ParseUint` with its own loop: validate every character,
accumulate `n = n * base + d` in an unbounded `bigint`, and compare with `2^bitSize − 1` at the end. Three
consequences:

1. **Quadratic cost.** Go stops at the digit that overflows (`if n >= cutoff { return maxVal, rangeError }`).
   The port kept multiplying an ever-growing `bigint`, so an attacker-supplied number of a few hundred
   thousand digits took seconds of synchronous CPU — enough to stall an event loop past any timeout. Inputs
   come from places an operator does not control: a witness's `409` response body, a tile path segment, a
   checkpoint's size line.
2. **Wrong error precedence.** Because overflow was only checked at the end, `"99999999999999999999x"` was
   reported as a syntax error where Go reports `value out of range` (the merkle audit's F13/F19 and the
   note/gostd audit measured 1,820 such mismatches).
3. **Errors were strings, not sentinels.** `ErrSyntax`/`ErrRange` were exported string constants, so
   `errorIs(err, ErrRange)` — the port of `errors.Is(err, strconv.ErrRange)` — could not work.

Go's message is `strconv.ParseUint: parsing "<the whole input, quoted>": <reason>`, which grows with the
input.

## Decision

- `parseUint` is a line-by-line transcription of Go 1.25.5's `ParseUint` (the derived declarations carry the
  Go BSD notice, per AGENTS.md §9): the empty-string check first, then base validation (including base 0's
  prefix and underscore rules, and `underscoreOK`), then bit size (`0` means `IntSize`, 64 on every platform
  Tessera targets), then the per-digit loop with Go's `cutoff` and `maxVal` checks, returning `ErrRange` at the
  overflowing digit. The accumulator is a `number` while the value stays below 2^53 and a `bigint` after; both
  paths make the same decisions, and the loop is linear in the input length.
- Errors are `NumError`s (`func`, `num`, `err`, with `cause = err`), and `ErrSyntax`/`ErrRange` are
  `SentinelError`s, so `errorIs` matches them as `errors.Is` does.
- The message keeps Go's format but quotes at most `maxQuotedNum` (64) code points of the input, followed by
  `...` when it is longer. Every realistic input — a 20-digit uint64, an 8-digit key hash — is shorter, so
  for those the text is exactly Go's. `NumError.num` holds the full input, as Go's `Num` does.
- `quote` now escapes non-printable runes the way Go's `Quote` does (`\u00a0`, `\u2028`, `\U0010ffff`, …).
  Printability is Go's `IsPrint`, transcribed with Go 1.25.5's own tables (`strconv/isprint.go`, Unicode
  15.0.0), so the result does not depend on the JavaScript engine's Unicode version (Chromium 141 already
  ships Unicode 16, Node 22 does not). A lone surrogate, which no Go string can hold, is escaped as `\ufffd`.
  `quote` agrees with Go 1.25.5's `strconv.Quote` on every one of the 1,112,064 Unicode scalar values.

## Consequences

- A differential run against Go (60,350 inputs over bases 0, 2, 8, 10, 16, 36 and invalid ones, bit sizes 0, 8,
  16, 32, 53, 63, 64 and invalid ones) agrees on value, error text and `errors.Is` classification for every
  input whose quoted form is at most 64 code points; the 25 differences are all the deliberate truncation of
  longer inputs. Go's own `parseUint64Tests`, `parseUint64BaseTests` and `parseUint32Tests` tables are ported.
- A 4,000,000-digit input is rejected in milliseconds.
- Error messages for inputs longer than 64 code points differ from Go's by the truncation. Nothing in the
  repository's tests or fixtures uses such an input.
- Base 0, previously unimplemented, now works; no caller uses it.

## Alternatives considered

- **Keep the old loop and add a length cap.** Rejected: any cap is arbitrary, still leaves the precedence bug,
  and Go's loop is short enough to transcribe.
- **Quote the whole input, as Go does.** Rejected: an error message whose size is chosen by the peer is a
  memory and log-amplification hazard in a long-running log process.
- **Truncate by UTF-16 code units.** Rejected: it can split a surrogate pair, which `quote` would then escape
  as `�`.

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Read Go's `strconv.ParseUint`, `underscoreOK` and `lower` (local Go 1.24.7 source; the ADR cites 1.25.5, which I could not run) against `strconv.ts`; the control flow, base/bit-size handling, cutoff and `maxVal` checks, and error precedence are a line-for-line transcription, with a `number` fast path below 2^53 that makes the same decisions.
  - Differential against real Go (my own corpus, not the ADR's): 120,000 inputs over bases {0,2,8,10,16,36,1,37,-1}, bit sizes {0,8,16,32,53,63,64,-1,65}, digit/underscore/prefix/sign/space/non-ASCII alphabets, lengths up to 200. Zero differences in value, error class (`errorIs` against `ErrRange`/`ErrSyntax`) or text, other than 19,451 messages for inputs over 64 code points, all of which are exactly Go's text with the quoted input cut to 64 code points plus `...` (checked by reconstruction). `quote` compared on all 1,112,064 Unicode scalar values against Go's `strconv.Quote`: byte-identical. A 4,000,000-digit input is rejected in about 3 ms. `NumError`, `ErrSyntax` and `ErrRange` behave as described (`cause` chain, sentinels).
  - Wording, non-blocking: 'an attacker-supplied number of a few hundred thousand digits took seconds of synchronous CPU' is the one phrase in the ADR that reads as an attack description with a payload size; 'cost quadratic in the input length, so a long digit string from a peer could occupy the event loop' says the same neutrally. No construction is given.
  - Full `bun run test:unit` (Vitest on Node 22.22.0), run twice during the review: 122 files, 3439 tests, all passed.

## Update (2026-10-04): wording

In the Context, "an attacker-supplied number of a few hundred thousand digits took seconds of synchronous CPU"
should read: the cost was quadratic in the input's length, so a long digit string from a peer could occupy the event
loop. The fix and its tests are unchanged.

**Review of this update:** ADR review agent (independent), 2026-10-04. Verdict: approved. The replacement wording is accurate, and it is the neutral one the Review asked
for. I timed the first version of `parseUint` (`git show ddeaec4:src/internal/gostd/strconv.ts`, a `bigint` accumulator with no early exit) on `"9" x n` in base 10, 64 bits, in
a scratch file: 50,000 digits 213 ms, 100,000 digits 854 ms, 200,000 digits 3.8 s, 400,000 digits 28 s, so the cost is quadratic in the input length (about four times for each
doubling, worse above that), where the current `parseUint` takes under a millisecond for all four. "Could occupy the event loop" follows from that. The Context's original phrase is
left in place, which is how an Update works, and the code and tests are untouched by this Update.
