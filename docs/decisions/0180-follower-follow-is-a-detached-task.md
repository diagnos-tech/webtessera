# ADR-0180: Start `Follower.follow` as a detached task, as Go starts it on a goroutine

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** root-package fidelity agent
- **Upstream reference:** `lifecycle.go` (`Follower`), `append_lifecycle.go` (`NewAppender`), `migrate_lifecycle.go` (`MigrationTarget.Migrate`)

## Context

`Follower.Follow` has no return value and is only ever called on a goroutine of its own:

```go
// append_lifecycle.go, NewAppender
for _, f := range opts.followers {
	go f.Follow(ctx, r)
	go followerStats(ctx, f, r.IntegratedSize)
}

// migrate_lifecycle.go, MigrationTarget.Migrate
for _, f := range mt.followers {
	klog.Infof("Starting %s follower", f.Name())
	go f.Follow(cctx, mt.reader)
	errG.Go(awaitFollower(cctx, f, sourceSize))
}
```

So a Go follower runs for as long as its context lives, and nothing it does can make
`NewAppender` or `Migrate` fail: it has no caller to return an error to, and a panic in it
takes down the process rather than returning through the code that started it.

The port typed the method `follow(reader, signal?): void` and called it inline,
`f.follow(r, bgSignal)`. That had two consequences Go does not have: a follower that throws
synchronously made `newAppender` (or `migrate`) reject, and nothing in the type told an
implementer that `follow` must return promptly and keep running in the background.

## Decision

- `Follower.follow` is typed `follow(reader: LogReader, signal?: AbortSignal): void | Promise<void>`.
  Its doc comment keeps Go's text and adds a port note stating the contract: `follow` must not
  block (long-running work returns a Promise and awaits between steps), it owns its own errors,
  and it must return once `signal` is aborted.
- Both callers start it as a detached task after their own synchronous work, and never await it:

  ```ts
  void Promise.resolve().then(() => f.follow(r, bgSignal));
  ```

  A synchronous throw and a rejection both end up as a rejection of that detached promise,
  which nothing handles, so the runtime reports it as an unhandled rejection. That is the
  JavaScript analogue of a panicking goroutine: loud, and not routed back through
  `newAppender`/`migrate`.

## Consequences

- `newAppender` and `MigrationTarget.migrate` no longer fail because a follower threw, matching
  Go. A follower's failure is visible only as an unhandled rejection (in Node, by default, that
  terminates the process, which is also what Go does with a panic), or through its own
  `entriesProcessed` not advancing, which `awaitFollower` already polls.
- Implementations that returned `void` still type-check; ones that return a Promise are now
  described by the interface rather than merely tolerated.
- The case of a follower that throws is not unit-tested, because the behaviour under test is an
  unhandled rejection, which the test runner itself treats as a failure. The tests pin what can
  be observed: `newAppender` and `migrate` do not wait for a `follow` that never settles, and
  `follow` receives the reader and a signal bound to the caller's.

## Alternatives considered

- **Keep calling `follow` inline and catch what it throws.** Rejected: catching means deciding
  what to do with the error (log it, which this port does not do; or rethrow, which is the
  divergence being fixed). Go has no such path.
- **Await `follow`.** Rejected: a follower runs for the lifetime of the log, so awaiting it would
  never return.
- **Type `follow` as `Promise<void>` only.** Rejected: it would reject existing `void`
  implementations for no gain; `void | Promise<void>` admits both.

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Go side: `append_lifecycle.go:275-276` (`go f.Follow(ctx, r)`) and `migrate_lifecycle.go:173-174` (`go f.Follow(cctx, mt.reader)` followed by `errG.Go(awaitFollower(...))`); `Follower.Follow` has no result (`lifecycle.go:82`). So nothing a follower does can fail `NewAppender`/`Migrate`, as the Context says.
  - TS side: `lifecycle.ts` types `follow(reader, signal?): void | Promise<void>` with the contract in a port note; `append_lifecycle.ts:227` and `migrate_lifecycle.ts:226` both run `void Promise.resolve().then(() => f.follow(...))` after their own synchronous work and never await it. A synchronous throw and a rejection both end in that unhandled detached promise. No concrete `Follower` exists in `src/` that the typing change could break.
  - Tests cited exist and assert what is claimed: `append_lifecycle_test.ts` 'starts each follower as a detached task that newAppender does not wait for' (reader identity; signal aborted when the caller's is) and `migrate_lifecycle_test.ts` 'runs only the followers configured before newMigrationTarget, each as a detached task' (a never-settling `follow` does not block `migrate`). Small gap, non-blocking: 'a signal bound to the caller's' is asserted for `newAppender` only. The throwing-follower case is untested, as the ADR itself says.
  - Full `bun run test:unit` (Vitest on Node 22.22.0), run twice during the review: 122 files, 3439 tests, all passed.
