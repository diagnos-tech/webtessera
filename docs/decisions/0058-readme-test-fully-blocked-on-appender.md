# ADR-0058: `README_test.go` is not portable yet — both its tests need `Appender`

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** storage-internal agent
- **Upstream reference:** `README_test.go`

## Context

The mission brief for this work package asks for `README_test.ts` — "port what applies to types
you now have, and record in an ADR what you can't reach yet because it needs `Appender`, which
doesn't exist until Wave 3" — mirroring how `docs/decisions/0044-ct-only-partial-port.md` split
`ct_only.go` into a portable two-thirds and a deferred third.

`README_test.go` has exactly two test functions, and both are entirely about constructing and
using an `Appender`:

```go
func constructStorage() {
	driver, _ := posix.New(ctx, posix.Config{Path: "/tmp/mylog"})
	signer := createSigner()
	appender, shutdown, reader, err := tessera.NewAppender(
		ctx, driver, tessera.NewAppendOptions().WithCheckpointSigner(signer))
	...
}
func TestConstructStorage(t *testing.T) { constructStorage() }

func constructAndUseAppender() {
	driver, _ := posix.New(ctx, posix.Config{Path: "/tmp/mylog"})
	signer := createSigner()
	appender, shutdown, reader, err := tessera.NewAppender(
		ctx, driver, tessera.NewAppendOptions().WithCheckpointSigner(signer))
	...
	index, err := appender.Add(ctx, tessera.NewEntry(data))()
	...
}
func TestConstructAndUseAppender(t *testing.T) { constructAndUseAppender() }

func createSigner() note.Signer {
	s, _, _ := note.GenerateKey(rand.Reader, "TestKey")
	r, err := note.NewSigner(s)
	...
}
```

Unlike `ct_only.go` — which had three standalone, byte-level functions (`ctEntriesPath`,
`ctBundleIDHasher`, `ctMerkleLeafHasher`) with no dependency on the append lifecycle at all,
alongside four declarations that did — `README_test.go` has **no** function whose *test* is
independently exercisable. Both `constructStorage` and `constructAndUseAppender` call
`tessera.NewAppender`/`tessera.NewAppendOptions` (this work package ports only
`AddFn`/`IndexFuture`/`Index` from `append_lifecycle.go`, per
`docs/decisions/0054-append-lifecycle-partial-port.md`) and `posix.New` (a storage driver;
`docs/PORTING-MAP.md` lists the whole `storage/posix/` package as `pending ADR`, not assigned to
any wave yet). `createSigner` is the one piece that depends only on already-landed code
(`src/vendor/note/note.ts`, Wave 1) — but it is a test *helper*, not a test, and porting a helper
with nothing to call it produces no coverage and no file that fits this codebase's convention that
every `*_test.ts` file contains actual tests (`AGENTS.md` §3.1).

## Decision

**`src/README_test.ts` is not created by this work package.** There is no partial slice to port:
every test in the file requires `Appender`, and `Appender` does not exist. This ADR is the record
`docs/PORTING-MAP.md`'s row for `README_test.go` points to, so the next agent who reaches this
file (necessarily the Wave 3 append-lifecycle agent, or Wave 4 once `storage/posix` — or another
in-scope driver — lands, whichever comes second) knows the constraint is not "nobody got to it,"
it is "nothing could be exercised yet."

Whoever ports `README_test.go` once `Appender` and a storage driver both exist should note that
`createSigner` has no direct upstream test of its own (it is used, not tested, by both
`TestConstructStorage`/`TestConstructAndUseAppender`) and that this port's driver choice will not
be `posix` (out of scope entirely, per `docs/decisions/0001-scope-and-module-inclusion.md`'s
`storage/posix/` row) but whichever of `memory`/`indexeddb`/`durableobject`/`s3` is available —
the two `#region` markers in the Go source (`common_imports`, `construct_example`,
`use_appender_example`) exist because `README.md` embeds these exact code blocks via `mdcode`; a
faithful port should preserve that structure so the eventual `README.md` for this package can do
the same.

## Consequences

- `docs/PORTING-MAP.md`'s `README_test.go` row stays `not started`, naming this ADR rather than an
  agent name, per that file's own rule ("Any status other than `done`/`not started` needs either
  an ADR reference or an agent's name in `notes`").
- No `src/README_test.ts` exists in the tree yet. This is deliberate, not an oversight: creating
  an empty or stub file would violate `AGENTS.md`'s "no invented API" principle for a file whose
  entire point is to validate a README that does not exist yet either (this package has no
  `README.md` with embedded code samples for `mdcode` to validate against, since the port itself
  is not yet in a donatable, documented state).

## Alternatives considered

- **Port `createSigner` alone, into a new non-test helper file.** Rejected: it has no upstream
  file of its own to map to (it lives inside `README_test.go` because it exists only to support
  that file's two tests), and creating one invents a file/location Go does not have, for a helper
  nothing in this codebase yet calls.
- **Write a stub `Appender`/`AppendOptions` so both tests could compile.** Rejected for the same
  reason `docs/decisions/0044-ct-only-partial-port.md` and
  `docs/decisions/0054-append-lifecycle-partial-port.md` reject it: a stub that compiles is a stub
  that gets built on, and this work package has no authority to guess at `Appender`'s real shape.

## Review

- **Reviewer:** Storage-Internal Reviewer
- **Verdict:** approved
- **Notes:** Read `README_test.go`: both `TestConstructStorage` and
  `TestConstructAndUseAppender` route entirely through `tessera.NewAppender` /
  `NewAppendOptions` (Wave 3) and `posix.New` (an unported, out-of-scope driver);
  `createSigner` is a test helper, not a test. There is no independently exercisable slice,
  so not creating `src/README_test.ts` is the honest call rather than an invented stand-in —
  confirmed no such file exists in the tree. This is the correct application of the ADR-0044
  partial-port precedent to a file where the portable fraction is zero.
