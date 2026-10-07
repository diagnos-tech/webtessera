# ADR-0227: Keep browser device keys in IndexedDB as non-extractable CryptoKeys

- **Status:** accepted
- **Date:** 2026-10-03
- **Author:** DX guardrails contributor
- **Upstream reference:** n/a

## Context

A log kept in a browser (ADR-0226) must be signed by the same key for as long as the log exists, across reloads
and in every tab and worker of the page's origin. The key must not be exfiltratable: a script injected into the
page may use it while it runs, but must not be able to carry it away. WebCrypto's non-extractable keys give
exactly that (ADR-0222), and IndexedDB can store a CryptoKey itself through the structured clone algorithm,
keeping it non-extractable; no other browser storage can.

## Decision

`src/browser/device_key.ts`:

- **Where:** an IndexedDB database of its own, `webtessera-keys` by default (`database` option), with one object
  store, `keys`, holding one record per key under an `id` that defaults to the log's origin. The log's own
  database (`src/storage/indexeddb/`) is untouched, so its schema and its golden suite are unaffected.
- **What:** `{ version: 1, origin, privateKey: CryptoKey, publicKey: Uint8Array }`: the private key as the
  CryptoKey, never as bytes, and the raw public key, from which the vkey is rebuilt.
- **`openDeviceKey(origin)`** returns the stored key or creates one. Creation requires WebCrypto Ed25519 and makes
  a non-extractable key; there is no fallback, and the error names `generateLogKey(origin, { fallback: "noble" })`
  for a key that lasts as long as the page. The record is written with `add`, which fails on an existing id, so
  two tabs opening the key at once cannot both write: the loser reads and returns the winner's key, and no tab
  ever signs with a key another then replaces.
- **`loadDeviceKey`** validates what it reads (record shape, origin) and checks that the private and public halves
  belong together by signing and verifying a probe message, so a damaged or swapped record is refused rather than
  used. **`saveDeviceKey`** stores a WebCrypto-backed key, refuses a @noble/curves one (its secret would be stored
  as readable bytes), and never overwrites. **`deleteDeviceKey`** reports whether there was a key, and its doc
  comment says that the key's log can never be appended to again.
- Every transaction uses `durability: "strict"` (as ADR-0111 does for logs) and its own short-lived connection,
  which closes on `versionchange`, so key access never blocks another tab's upgrade.
- Keys loaded from, or saved to, the store are marked as persistent, which `openBrowserLog` requires for a log
  kept in IndexedDB.

## Consequences

- Clearing site data deletes the key with the log; so can storage eviction, unless the origin is granted
  persistent storage. The guide tells applications whose logs matter to call `navigator.storage.persist()`.
- A key cannot be backed up or moved to another device. That is the guarantee, not a limitation to work around;
  an application that needs portability creates an extractable key with `generateLogKey(origin,
  { extractable: true })`, manages it itself, and passes it with `fromCryptoKey`.
- Verified in real Chromium (`src/browser/log_browser_test.ts`): the stored record's private key refuses
  `exportKey` in both `pkcs8` and `jwk`, a reopened key signs what the original's vkey verifies, and a module
  worker of the same origin gets the same key. Node (fake-indexeddb over Node's WebCrypto, which clones
  CryptoKeys as browsers do) covers races, ids, swapped halves and refusals (`src/browser/browser_test.ts`).

## Alternatives considered

- **Store the key in the log's own IndexedDB database.** Rejected: it would change that driver's schema, a
  backend whose byte-for-byte contents are judged against Go's, for something that is not part of a log.
- **Store an encrypted seed** (wrapped with a key derived from a passphrase). Rejected: it requires user
  interaction, and the unwrapped seed would live in JavaScript memory, readable by an injected script.
- **`put` instead of `add`.** Rejected: concurrent first opens would silently replace each other's keys.
- **Web Locks around load-or-create.** Rejected as unnecessary: `add`'s constraint gives the same exclusion in one
  transaction, without depending on Web Locks being available.

## Review

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Read `src/browser/device_key.ts` against each bullet: database `webtessera-keys`, store `keys`, record `{ version: 1, origin, privateKey: CryptoKey, publicKey }`; `openDeviceKey` loads or creates (no fallback, error names `generateLogKey(origin, { fallback: "noble" })`) and writes with `add`, with a `ConstraintError` meaning another tab won and its key is loaded and returned, so no tab signs with a key another replaces; `loadDeviceKey` checks record shape and origin and, through `restoreCryptoKey`, signs and verifies a probe so a swapped record is refused; `saveDeviceKey` refuses a noble key and never overwrites; `deleteDeviceKey` reports whether there was a key; every transaction is `durability: "strict"` on its own connection that closes on `versionchange`; loaded or saved keys are marked durable, which `openBrowserLog` requires.
  - Ran the tests the Consequences cite: Chromium (`log_browser_test.ts`) shows the stored record's private key is a non-extractable `CryptoKey` and `exportKey` rejects for both `pkcs8` and `jwk`, a reopened key's vkey verifies what the original signs, a module worker gets the same key, and five simultaneous opens return one key; `browser_test.ts` (fake-indexeddb) covers races, ids, swapped halves and refusals. 8 files / 265 tests in Chromium and the unit suite pass.
  - Not verified: persistence and eviction behaviour (`navigator.storage.persist()`) and structured clone of `CryptoKey` in Firefox and Safari; only the Playwright Chromium and fake-indexeddb over Node's WebCrypto ran. The Consequences' warning that clearing site data deletes the key is a statement about browsers, not code.

## Update (2026-10-07): an insecure page is told so first

On a page served over plain HTTP from a host other than localhost, browsers expose neither `crypto.subtle` nor
Web Locks, and `openDeviceKey` failed with the message about browser versions ("it needs Chrome or Edge 137, …"),
which sent the audit looking at the wrong thing. `openDeviceKey` and `loadDeviceKey` now check
`globalThis.isSecureContext` first, and where it is `false` throw a `WebtesseraError` with the code
`INSECURE_CONTEXT`: "this page is not a secure context (it was loaded over plain HTTP from a host other than
localhost), and browsers give WebCrypto, which holds device keys, only to secure contexts. Serve the page over
HTTPS, or from localhost while developing." Runtimes without the notion (`isSecureContext` undefined) pass. The
other errors of the device key store have codes too (ADR-0243): `UNSUPPORTED_RUNTIME`, `KEY_EXISTS`,
`KEY_MISMATCH`, `STORAGE_DAMAGED`; an `id` or `database` option that is a signer key is refused unquoted.

Tests: `browser_test.ts` ("says, before anything else, that a page that is not a secure context cannot hold a
device key").

**Review of this update:** DX reviewer (independent), 2026-10-07. Verdict: approved. `checkSecureContext` throws `INSECURE_CONTEXT` only where `globalThis.isSecureContext === false`, before anything else in `openDeviceKey` and `loadDeviceKey` (`deleteDeviceKey` needs no WebCrypto and does not check); `checkOptions` refuses a signer-key `id` or `database` unquoted; the other codes are as listed. `browser_test.ts` passes on Node with fake-indexeddb. Not verified: real Chromium on plain HTTP.
