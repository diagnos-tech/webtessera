# ADR-0243: Give the safe API one error class with stable codes, and never repeat a signer key in an error

- **Status:** proposed
- **Date:** 2026-10-07
- **Author:** Gustavo Simões (DX audit fixes)
- **Upstream reference:** n/a (the safe API has no upstream counterpart, ADR-0220). Go's `errors.As`
  (Go 1.25.5 `src/errors/wrap.go`) for `errorAs`, already ported in `src/internal/gostd/errors.ts`.

## Context

A fresh-eyes audit of the packed 0.1.0 tarball, by a developer installing it as a new user, found two problems
with the safe API's errors.

- **A private key printed in an error.** `verifyReceipt(text, { vkey: skey, data })` threw
  `TypeError: verifyReceipt: "PRIVATE+KEY+example.com/m+8d1b9cb7+AU8k…" is not a note verifier key…`. `LOG_SKEY` and
  `LOG_VKEY` differ by one letter, so the mix-up is likely, and the message reaches logs and error trackers. The
  safe-API guide promises that "no error message contains key material". Seven other functions that take key
  strings redacted already; this one quoted its input with `JSON.stringify`, as several other error paths of
  `src/safe`, `src/browser` and `src/witness` did with origins, names and option values.
- **Errors that code cannot tell apart.** Apart from `ReceiptError` (with a `reason`), the safe API threw plain
  `Error`, `TypeError` and `RangeError`: a wrong key, missing Web Locks, a publish timeout, a closed log and damaged
  storage were distinguishable only by their text. The ported API's errors are Go's sentinels, checked with
  `errorIs(err, ErrPushback)`, and `errorAs`, Go's `errors.As`, was not exported, so an error class carrying data
  (`ErrInconsistency`, `OldSizeMismatchError`) could not be found in a wrapped error by the documented means.

## Decision

**One class, `WebtesseraError`** (`src/safe/errors.ts`, exported from `webtessera/server` and `webtessera/browser`),
with a stable `code` and, where the error concerns an entry, its `index`. Every error the safe API raises from a
check of its own is one; the messages are unchanged. Errors from storage, the network and the ported API pass
through as they are, or as the `cause` of a `WebtesseraError` that explains them (pushback is `OVERLOADED` with
`ErrPushback` as its cause, so `errorIs(err, ErrPushback)` still holds). The codes:

| Code | Raised by |
| --- | --- |
| `INVALID_ARGUMENT` | a value of the wrong type, shape or range (what used to be `TypeError` and `RangeError`) |
| `SIGNER_KEY_MISUSE` | a signer key where a verifier key, origin, receipt, name or option belongs (below) |
| `WRONG_ENVIRONMENT` | `webtessera/server` in a browser or React Native, at import or in a key-holding function |
| `UNSUPPORTED_RUNTIME` | no WebCrypto Ed25519 where a non-extractable key was required; no IndexedDB for device keys |
| `INSECURE_CONTEXT` | a device key asked for on a page that is not a secure context (ADR-0227's update) |
| `NO_WEB_LOCKS` | `openBrowserLog` without Web Locks and without `singleWriter: true` |
| `KEY_MISMATCH` | storage holds another key's log; a key pair's halves do not belong together; a device key of another log |
| `KEY_EXISTS` | `saveDeviceKey` over a stored key |
| `WITNESS_CONFLICT` | a witness cosigned more of the log than its storage holds |
| `OPEN_FAILED` | the log could not start (the cause says why) |
| `LOG_CLOSED` | a method called after `close()` |
| `ENTRY_TOO_LARGE`, `EXTRA_DATA_TOO_LARGE` | an entry over 65535 bytes; extra data over `MaxExtraDataBytes` |
| `OVERLOADED` | the appender pushed back |
| `SEQUENCE_TIMEOUT`, `PUBLISH_TIMEOUT` | no index in time; an index (in `index`) but no covering checkpoint in time |
| `NOT_COVERED` | an index the latest checkpoint does not cover (`index` set) |
| `STORAGE_DIVERGED` | a receipt the log built did not verify against its own storage (ADR-0226's update) |
| `WRITER_CONFLICT` | another process took over a single-writer SQLite database (ADR-0210's update) |
| `STORAGE_DAMAGED` | storage holds what its tiles or checkpoint contradict (`entries`, `fsck`, a device key record) |
| `INVALID_RECEIPT` | a receipt does not prove what it was checked against |

**`ReceiptError` joins it.** It now extends `WebtesseraError`, with the code `INVALID_RECEIPT`, and keeps its
`name` (`"ReceiptError"`), its `reason` and its constructor; `instanceof ReceiptError` works as before.

**The ported API keeps Go's errors.** Its sentinels are a recorded fidelity choice (AGENTS.md §3.6, ADR-0004), and
nothing here changes them. `errorAs` is exported from the package root next to `errorIs` (an addition to the root
barrel of ADR-0133, for the same reason `errorIs` is there: Go's API is specified in terms of `errors.Is` and
`errors.As`), and the root module's documentation says how to test for a sentinel (`errorIs`, never `===` or
`instanceof`) and for an error class (`errorAs`).

**No error repeats a signer key.** `isSignerKey(v)` recognises a string in which `PRIVATE+KEY+` appears anywhere,
in any case, so that a key pasted with its variable name (`LOG_SKEY=…`), quoted, padded or lowercased counts.
Wherever the safe API takes a string that should be public, it checks first and throws `SIGNER_KEY_MISUSE` with a
message that names what was expected and never the key: "verifyReceipt: vkey is a signer (private) key; pass the
log's verifier key (vkey), as its operator publishes it. It is not repeated here; a signer key that reached this
code should be treated as exposed, …". The inputs:

- `verifyReceipt`: `vkey`, `origin`, every key of a `{ threshold, witnesses }` policy, and the receipt (text or
  bytes); `parseReceipt`; `log.verify`.
- `generateLogKey`, `generateLogKeyPair`, `openDeviceKey`, `loadDeviceKey`, `deleteDeviceKey`, `fromCryptoKey`: the
  origin (the existing message, "this looks like a private signer key", is kept, now with the code).
- `openServerLog`: `key` (a string), `storage.namespace`, `storage.locking`; `openBrowserLog`: `key`,
  `storage.indexedDB`; the device-key functions: `options.id`, `options.database`.

Every other place that quoted a caller's string now goes through `quoteInput`, which shows a placeholder for a
signer key and cuts anything else to 96 characters: index arguments, timeouts and other options, origins, device
key ids and database names. `importLogKey`, which does take a signer key, still never quotes it, and now says so
when it was given the verifier key instead ("this is a verifier (public) key, the half to publish").

**webtessera/witness** shares the rule. Its `echo` (the bounded quoting of request and configuration strings in its
errors) shows the same placeholder for a signer key, and a signer key configured as a log's verifier key, in
`logs` or returned by `lookupLog`, is refused by name before the ported `newVerifier` sees it. The witness imports
only `isSignerKey` from `src/safe/errors.ts`, a module that imports nothing; it is the one file outside the safe
API's directories that imports from them, which ADR-0220's review recorded as none until now.

## Consequences

- Code can branch on `err.code`, and on `err.index` for a timeout or an uncovered index, across every safe-API
  failure; `instanceof WebtesseraError` holds for errors from both entry points, which share the class.
- **Breaking, before 1.0:** argument errors that were `TypeError` or `RangeError` are now `WebtesseraError`s with
  the code `INVALID_ARGUMENT`. Messages are unchanged, so code matching on text keeps working; code testing
  `instanceof TypeError` does not. The CHANGELOG says so.
- The guard module that a browser build of `webtessera/server` resolves to (ADR-0221) throws a
  `WebtesseraError` too, and imports `src/safe/errors.ts` to do it.
- A check for a signer key costs an upper-casing and a substring search of the string, once per call.

## Alternatives considered

- **Node's style: keep `TypeError` and `RangeError`, add a `code` property.** It keeps `instanceof TypeError`, but
  leaves no single class to test for, and the audit asked for one; a library with two kinds of error class to
  catch is what the audit found hard to handle.
- **A class per code** (`EntryTooLargeError`, …). Twenty classes to import and keep stable, where a string union
  gives the same discrimination, with exhaustive `switch`es checked by TypeScript.
- **Redact only `verifyReceipt`'s vkey.** It closes the one leak found, but not the next: every error path that
  quotes a caller's string is one paste away from the same mistake, so the rule is enforced where strings are
  taken and where they are quoted, and a test feeds a signer key to all of them.
- **Detect a signer key by parsing it with `newSigner`.** It misses the forms a mistake produces (`LOG_SKEY=…`,
  quoted, lowercased), each of which still carries the secret.

Tests: `src/safe/secrets_test.ts` feeds a signer key, in five forms, to every input listed above in
`webtessera/server`, `webtessera/browser` and `webtessera/witness`, and to the quoted options, and checks that no
error, cause or stack contains it, and that the public-string inputs answer `SIGNER_KEY_MISUSE` (it fails against
the old `verifyReceipt`); `receipt_test.ts` (`ReceiptError` is a `WebtesseraError`; the receipt inputs; quoting cut
short); `server_test.ts` ("errors you can handle in code": a code for each refusal, `index` on `NOT_COVERED`,
`importLogKey` given a vkey); `browser_test.ts` (`SIGNER_KEY_MISUSE`, `NO_WEB_LOCKS`, `INSECURE_CONTEXT`,
`LOG_CLOSED`); `index_test.ts` (`errorAs` at the root).

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**

> An ADR without a signed review is not in force. If author and reviewer disagree, record both
> positions here and escalate to the maintainers — do not silently settle it.
