# ADR-0222: Hold log keys in WebCrypto as non-extractable Ed25519 keys, with an explicit @noble/curves fallback

- **Status:** proposed
- **Date:** 2026-10-03
- **Author:** DX guardrails agent
- **Upstream reference:** golang.org/x/mod `sumdb/note/note.go` (`NewSigner`, `GenerateKey`,
  `NewEd25519VerifierKey`), as ported in `src/vendor/note/note.ts`

## Context

The ported note package holds an Ed25519 key as the 32 seed bytes inside a closure, decoded from a
`PRIVATE+KEY+<name>+<hash>+<key>` string (ADR-0005 explains why it signs with @noble/curves: Go's `Sign` is
synchronous). Any code with that string, or with access to the process's memory, has the key. In a browser that
is anyone who loads the page; on a server it is any dependency that logs an object carelessly.

The platform can do better almost everywhere now: WebCrypto's `crypto.subtle` supports Ed25519 in Node.js 22
and later (verified here on 22.22), Deno, Bun (verified on 1.3.14), workerd, Chrome and Edge 137, Firefox 129 and
Safari 17. A key created or imported with `extractable: false` can sign but can never be exported, by anyone,
this library included; in a browser it can be stored in IndexedDB as the CryptoKey itself (ADR-0227).

## Decision

`src/safe/keys.ts` defines **`LogKey`**: a note `AsyncSigner` (ADR-0223) whose name is the log's origin, with
`vkey` (the note verifier key), `backend` (`"webcrypto"` or `"noble"`), `extractable`, and `verifier()`.

- **Feature detection** (`webCryptoEd25519()`): imports RFC 8032 §7.1 TEST 1's private key as PKCS #8 into
  WebCrypto and signs the empty message; WebCrypto is used only if the signature is RFC 8032's, byte for byte,
  because the log's signatures must be the ones the ported signer makes. The verdict is cached per `SubtleCrypto`.
  `crypto.subtle` being absent (a browser page that is not a secure context) means no.
- **`generateLogKey(origin, { fallback, extractable })`**: a WebCrypto key pair, non-extractable unless
  `extractable: true` is passed (for an application that backs keys up itself; nothing in webtessera exports a
  key). Where WebCrypto cannot hold Ed25519, the default `fallback: "noble"` makes the key exactly as Go's
  `note.GenerateKey` does, through its port, and the key reports `backend: "noble", extractable: true`;
  `fallback: "error"` throws instead, saying what is missing.
- **`importLogKey(skey)`** (only in `webtessera/server`, ADR-0221): the string is validated by the ported
  `newSigner`, exactly as Go's `note.NewSigner` validates it. Its seed is then decoded once, its public key
  derived, and it is wrapped in a PKCS #8 PrivateKeyInfo and imported into WebCrypto as non-extractable; the
  decoded seed and the DER buffer are zero-filled once imported. Without WebCrypto Ed25519, the ported signer is
  used as it is (`fallback` as above).
- **In the browser a key enters only as a CryptoKey**: `openDeviceKey` (ADR-0227) or
  `fromCryptoKey(origin, pair)`, which checks the pair is Ed25519, signs a probe message with the private key and
  verifies it with the public one. `webtessera/browser` has no function that takes a key string, and its log
  factory names `openDeviceKey` when handed one.
- **No secret in any output**: `LogKey`'s own properties are `origin`, `vkey`, `backend` and `extractable`; the
  secret is reachable only from the signing closure. `toString`, `toJSON` and Node's `util.inspect.custom` show
  the public description only. Errors from importing a malformed key carry the note package's fixed sentinel
  text ("malformed verifier id", …) and never any part of the input.
- **Only our keys are accepted**: the log factories accept a `LogKey` that this module made (tracked in a
  `WeakSet`), so a note `Signer`, a look-alike object or a string is refused with a message that says what to
  pass instead.
- **Origins are checked** with messages that say how to fix them (non-empty, no spaces, no `+`, valid UTF-8),
  and a string starting with `PRIVATE+KEY+` passed where an origin belongs is refused as what it is.

## Consequences

- "Keep copies of secret bytes minimal" is best effort, and the guide says so. The `skey` string is immutable
  and stays in memory as long as the caller keeps it (often in `process.env`); `newSigner`'s validation decodes a
  copy of the seed into a closure that becomes garbage at once but is not wiped; and a JavaScript engine may copy
  buffers during garbage collection. The guarantee that matters, that no supported runtime can export a WebCrypto
  key once imported, holds regardless.
- A WebCrypto signature is an `await` away, which the ported synchronous `Signer` cannot express; ADR-0223 adds
  the asynchronous path the key needs.
- The fallback keeps the layer working on old browsers and insecure origins, at the cost of a key that could be
  read; it is reported on the key, and `openDeviceKey` never takes it (ADR-0227).
- Key rotation, which the ported `withCheckpointSigner` supports with additional signers, is not offered by the
  high-level log; a log that rotates keys drops down to the ported API.

## Alternatives considered

- **@noble/curves only** (the ported signer behind an async wrapper). Rejected: it cannot offer a key that cannot
  be exfiltrated, which is the point of a device key.
- **WebCrypto only.** Rejected: it would refuse to run on browsers that predate Ed25519 and on insecure origins,
  where an in-memory key is still useful; making the fallback explicit and reported serves both.
- **Parse the skey format here.** Rejected: the ported `newSigner` is the reviewed implementation of Go's
  checks; only the seed extraction after it has accepted the key is local, and it cuts the fields exactly as
  `newSigner` does.
- **Import via JWK** (`{ kty: "OKP", crv: "Ed25519", d, x }`). Rejected: it puts the seed in a base64url string,
  a second immutable copy, where the PKCS #8 buffer can be wiped.
- **An `exportLogKey` for provisioning.** Rejected: `generateKey` from `webtessera/note` already provisions a key
  string once, offline, for a secret store, and an export function would be one more way to leak one.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:** pending
