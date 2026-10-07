# ADR-0246: Add `log.fetch`, `appendMany`, JSON forms of receipts and checkpoints, and `Symbol.asyncDispose` to the safe API's logs

- **Status:** accepted
- **Date:** 2026-10-07
- **Author:** Gustavo Simões (DX audit fixes)
- **Upstream reference:** n/a (the safe API, ADR-0220 and ADR-0226); tessera `append_lifecycle.go` (batching) for
  why concurrent appends share a checkpoint

## Context

Four findings of the fresh-eyes audit of the 0.1.0 tarball were the safe API falling short of what JavaScript
developers reach for first:

- **`log.handler` is not a fetch handler.** It resolves to `undefined` for requests it does not own, so
  `Bun.serve({ fetch: log.handler })` fails to type-check and every runtime needs `combineHandlers(...)`.
- **Sequential appends are slow.** Each `append` waits for the next checkpoint, about 1.2 s; a loop of ten awaited
  appends took 12 s, where a hundred concurrent ones took 1.8 s. The fast path was the ported future,
  `log.appender.add(newEntry(d))()`.
- **`bigint` breaks JSON.** `JSON.stringify(receipt)` and `Response.json({ index })` throw `Do not know how to
  serialize a BigInt`.
- **No `Symbol.asyncDispose`,** so `await using log = …` does not work.

## Decision

**`ServerLog.fetch`**: `(request) => Promise<Response>`, the log's read handler with a 404 for everything else
(`combineHandlers(handler)`), a bound property, so `Bun.serve({ fetch: log.fetch })`, `Deno.serve(log.fetch)` and
`export default { fetch: log.fetch }` work as written. It serves reads only: adding entries over HTTP stays the
application's decision (ADR-0170), and the TSDoc points at `readEntryBody`. `handler` stays, for composition.

**`appendMany(datas, { signal?, timeoutMs? })`** on every log: it checks every entry first (one that the log cannot
hold refuses the whole batch, `ENTRY_TOO_LARGE` naming its position, before anything is added), adds them in
order before its first `await`, so they reach the appender together and share one checkpoint, and resolves to
their receipts in input order, each verified as `append` verifies it. The trade-off is in its TSDoc and in
`append`'s: a batch costs one checkpoint interval instead of one per entry, but the receipts arrive together, and a
rejection (a timeout, pushback, the log closing) may leave some entries in the log, whose receipts `prove` fetches.

Chosen over `append(data, { wait: "sequenced" })`: that would make `append` return an index without a receipt
under one option and a verified receipt otherwise, which is the confusion ADR-0220 built `append` to remove, and
`log.appender` already serves code that wants the index first.

**JSON forms.** `Receipt`, `LogCheckpoint` and `VerifiedReceipt` have a `toJSON()`, so `JSON.stringify` and
`Response.json` write them:

- `ReceiptJSON` is `{ index: "<decimal>", text }`; `text`, documented as the wire format to store, send and
  verify, carries everything else, and `verifyReceipt`, `parseReceipt` and `log.verify` take a `ReceiptJSON` back.
- `LogCheckpointJSON` is `{ origin, size: "<decimal>", hash: "<base64>", signed: "<note text>" }`;
  `VerifiedReceiptJSON` adds `index`, `cosignedBy` and base64 `extraData` and `data` when present.

They are classes now (`toJSON` on the prototype), so spreading a receipt copies its data and nothing else.
`LogEntry` stays a plain object: entries stream in volume, and their bytes have no single JSON form.

**`Symbol.asyncDispose`.** `LogBase` installs `[Symbol.asyncDispose]() { return this.close() }` on its prototype
where the runtime has the symbol (Node, Deno, Bun, workerd, current browsers). Its type is
`AsyncDisposableLog`, which `TransparencyLog` extends:

```ts
type AsyncDisposeKey = SymbolConstructor extends { readonly asyncDispose: infer K extends symbol } ? K : never;
export type AsyncDisposableLog = { readonly [K in AsyncDisposeKey]: () => Promise<void> };
```

Where the consumer's TypeScript lib declares `Symbol.asyncDispose` (TypeScript 5.2+, `esnext.disposable`), this is
`AsyncDisposable`, and `await using` type-checks; where it does not, it is `{}`, and no shipped declaration names
a symbol the lib lacks, so the declarations still type-check under `lib: ["es2022", "dom"]` with `skipLibCheck: false`,
which the audit confirmed and this keeps. The factories type their result with a one-line assertion
(`disposable()`), since the method is installed dynamically for the same reason. `tsconfig.json` adds
`ESNext.Disposable` to `lib` for the repository's own type check only. `close()` is unchanged.

## Consequences

- Serving a log is one line on every fetch-style runtime; Node still wraps it in `toNodeListener`.
- Batches are fast without dropping to the ported API, and the cost of awaiting appends one by one is stated
  where a developer reads it.
- Receipts survive `JSON.stringify` and come back through `verifyReceipt`.
- `await using` works on TypeScript 5.2+ with a disposable lib, on runtimes with the symbol; elsewhere nothing
  changes.

## Alternatives considered

- **Make `handler` answer 404 itself.** It would stop composing with other handlers, which is its purpose.
- **`append(data, { wait: "sequenced" })`.** See above.
- **Strings instead of bigints in `Receipt`.** Indices are uint64 (ADR-0003); `toJSON` gives JSON its own form
  without weakening the type.
- **Declare `[Symbol.asyncDispose]` on the interfaces directly.** Every consumer whose lib lacks
  `esnext.disposable` would then get a type error inside webtessera's declarations under `skipLibCheck: false`.

Tests: `src/server/server_test.ts` ("openServerLog, the developer experience": `fetch` unbound, 200 for the
checkpoint and 404 for `POST /add` without appending; receipts and checkpoints through `JSON.stringify` and
`Response.json` and back through `verifyReceipt` and `log.verify`, and spread copies only data; 50 entries through
`appendMany` in order, sharing one checkpoint, within a few intervals, a batch with one oversized entry refused
whole, an empty batch; `await using` through `Symbol.asyncDispose`, and
`expectTypeOf<ServerLog>().toExtend<AsyncDisposable>()`); `src/safe/receipt_test.ts` (the JSON forms);
`src/browser/browser_test.ts` (a browser log through `Symbol.asyncDispose`).

## Review

- **Reviewer:** DX review agent (independent), 2026-10-07
- **Verdict:** approved
- **Notes:**
  - Checked: `log.fetch` is `combineHandlers(handler)` held in a property, so it is bound. `appendMany` validates every entry before adding any, and `#append` adds its entry synchronously before its first `await`; `Promise.all` keeps the order. Also checked the receipt, checkpoint and verified-receipt classes with `toJSON`, `ReceiptJSON` accepted by `verifyReceipt`, `parseReceipt` and `log.verify`, `Symbol.asyncDispose` on `LogBase.prototype`, and `AsyncDisposableLog`. `server_test.ts`, `receipt_test.ts` and `browser_test.ts` pass.
  - Type-checked a consumer against the packed tarball with `skipLibCheck: false`. `lib: [es2022, dom]` compiles `verifyReceipt(receipt.toJSON(), …)` and rejects `verifyReceipt(t, { vkey })`. Adding `esnext.disposable` compiles `await using`; without it, only the consumer's own `await using` fails. The ADR's `lib: ["es2022"]` alone fails on `AbortSignal` (pre-existing): say es2022 with DOM.
  - `verifyReceipt` ignores `ReceiptJSON.index`: `{ index: "<anything>", text }` verifies and returns the text's index (probe). Check it against `proof.index` when present, or document that it is informational.
  - `docs/guides/safe-api.md`'s member table lists `fetch` and `handler` among the members of the log both factories return. `BrowserLog` has neither: mark the row as server-only.
  - Re-review of a2bd7a2. A receipt object whose `index` disagrees with its text is now refused as `malformed` (`withIndexOf`; probe and `receipt_test.ts`). `safe-api.md` marks `fetch` and `handler` as server only, and the lib text says es2022 with DOM. Nit: a numeric `index` that matches is refused with "its index field, 0, is not the index its text proves, 0", which reads as a contradiction. Saying that the field must be a decimal string would be clearer.

> An ADR without a signed review is not in force. If author and reviewer disagree, record both
> positions here and escalate to the maintainers — do not silently settle it.
