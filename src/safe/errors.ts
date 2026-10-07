// Copyright 2026 MedDeck LTDA. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// This file has no upstream counterpart. It is the error model of the safe API: one error
// class whose `code` code can branch on, and the rule that no error the safe API raises
// repeats a signer key it was handed by mistake. It imports nothing, so that the browser
// guard of webtessera/server and webtessera/witness can use it without pulling in anything
// else. The ported API keeps Go's errors (sentinels checked with errorIs, ADR-0004). See
// docs/decisions/0243-one-error-class-for-the-safe-api.md.

/**
 * WebtesseraErrorCode says which of the safe API's checks failed, as a stable string to
 * branch on. Messages explain and may change; codes do not.
 *
 *   - `INVALID_ARGUMENT`: a value of the wrong type or shape, or out of range.
 *   - `SIGNER_KEY_MISUSE`: a signer (private) key was passed where a verifier key, an
 *     origin or another public string belongs. The message never repeats it. A signer key
 *     that reached code that verifies or configures should be treated as exposed.
 *   - `WRONG_ENVIRONMENT`: webtessera/server loaded in a browser or React Native app.
 *   - `UNSUPPORTED_RUNTIME`: the runtime lacks what the call needs: WebCrypto Ed25519
 *     where a non-extractable key was required, or IndexedDB for device keys.
 *   - `INSECURE_CONTEXT`: a browser page served over plain HTTP, where WebCrypto is absent.
 *   - `NO_WEB_LOCKS`: the Web Locks API is missing, so tabs could not be kept from writing
 *     a browser log at once.
 *   - `KEY_MISMATCH`: storage holds a log another key created, or a key pair's halves do
 *     not belong together.
 *   - `KEY_EXISTS`: a device key is already stored under that id.
 *   - `WITNESS_CONFLICT`: a witness has cosigned more of the log than its storage holds.
 *   - `OPEN_FAILED`: the log could not start (the cause says why).
 *   - `LOG_CLOSED`: the log was closed.
 *   - `ENTRY_TOO_LARGE`: an entry over the 65535 bytes a tlog-tiles entry can hold.
 *   - `EXTRA_DATA_TOO_LARGE`: more extra data than a receipt can carry.
 *   - `OVERLOADED`: the log pushed back; retry later. The cause is ErrPushback.
 *   - `SEQUENCE_TIMEOUT`: an entry was not given an index in time; it may still be added.
 *   - `PUBLISH_TIMEOUT`: an entry has an index (see `index`) but no published checkpoint
 *     covered it in time; prove(index) fetches its receipt later.
 *   - `NOT_COVERED`: an index the latest checkpoint does not cover.
 *   - `STORAGE_DIVERGED`: a receipt the log built did not verify against the log's own
 *     storage: storage changed under this process, usually because another process writes
 *     it without shared locks.
 *   - `WRITER_CONFLICT`: another process took over a SQLite database opened with
 *     `locking: "single-writer"`; this process stopped writing before the log could fork.
 *   - `STORAGE_DAMAGED`: storage holds something its own tiles or checkpoint contradict.
 *   - `INVALID_RECEIPT`: a receipt does not prove what it was checked against; thrown as a
 *     {@link ReceiptError}, whose `reason` says which check failed.
 *
 * ```ts
 * if (err instanceof WebtesseraError && err.code === "PUBLISH_TIMEOUT") {
 *   retryLater(() => log.prove(err.index as bigint));
 * }
 * ```
 */
export type WebtesseraErrorCode =
	| "INVALID_ARGUMENT"
	| "SIGNER_KEY_MISUSE"
	| "WRONG_ENVIRONMENT"
	| "UNSUPPORTED_RUNTIME"
	| "INSECURE_CONTEXT"
	| "NO_WEB_LOCKS"
	| "KEY_MISMATCH"
	| "KEY_EXISTS"
	| "WITNESS_CONFLICT"
	| "OPEN_FAILED"
	| "LOG_CLOSED"
	| "ENTRY_TOO_LARGE"
	| "EXTRA_DATA_TOO_LARGE"
	| "OVERLOADED"
	| "SEQUENCE_TIMEOUT"
	| "PUBLISH_TIMEOUT"
	| "NOT_COVERED"
	| "STORAGE_DIVERGED"
	| "WRITER_CONFLICT"
	| "STORAGE_DAMAGED"
	| "INVALID_RECEIPT";

/**
 * WebtesseraError is what the safe API throws when one of its own checks fails. `code` is
 * stable, for code to branch on; the message says what happened and what to do, for people.
 * Errors from storage, the network or the ported API pass through unchanged, or as the
 * `cause` of a WebtesseraError that explains them.
 *
 * ```ts
 * try {
 *   await log.append(entry);
 * } catch (err) {
 *   if (err instanceof WebtesseraError && err.code === "ENTRY_TOO_LARGE") {
 *     return new Response("entry too large\n", { status: 413 });
 *   }
 *   throw err;
 * }
 * ```
 */
export class WebtesseraError extends Error {
	/** code says which check failed. */
	readonly code: WebtesseraErrorCode;
	/** index is the index of the entry the error is about, when it has one. */
	readonly index: bigint | undefined;

	constructor(
		code: WebtesseraErrorCode,
		message: string,
		options?: { readonly cause?: unknown; readonly index?: bigint },
	) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "WebtesseraError";
		this.code = code;
		this.index = options?.index;
	}
}

/**
 * signerKeyPrefix starts every note signer key (`PRIVATE+KEY+<name>+<hash>+<key>`), as the
 * ported note package writes and reads them.
 */
const signerKeyPrefix = "PRIVATE+KEY+";

/**
 * isSignerKey reports whether v is, or contains, a note signer key: a string in which
 * `PRIVATE+KEY+` appears anywhere, in any case. A key pasted with its variable name
 * (`LOG_SKEY=PRIVATE+KEY+…`), quoted, padded with whitespace or lowercased still holds the
 * secret, so it counts.
 *
 * @internal Shared by the safe API and webtessera/witness.
 */
export function isSignerKey(v: unknown): boolean {
	return typeof v === "string" && v.toUpperCase().includes(signerKeyPrefix);
}

/**
 * signerKeyMisuse is the error for a signer key passed where `what` belongs. It names what
 * was expected and never the key.
 *
 * @internal Shared by the safe API.
 */
export function signerKeyMisuse(where: string, what: string): WebtesseraError {
	return new WebtesseraError(
		"SIGNER_KEY_MISUSE",
		`${where}: ${what} is a signer (private) key; pass ${expected(what)}. It is not repeated here; a signer key ` +
			"that reached this code should be treated as exposed, and kept out of source code and logs.",
	);
}

function expected(what: string): string {
	switch (what) {
		case "vkey":
			return "the log's verifier key (vkey), as its operator publishes it";
		case "a witness key":
			return "each witness's verifier key (vkey), as its operator publishes it";
		case "the receipt":
			return "the receipt's text, as the log handed it out";
		case "the origin":
			return 'the log\'s origin, such as "example.com/log"';
		default:
			return "the value it names, never a signer key";
	}
}

// maxQuotedChars bounds how much of a caller's string an error message repeats.
const maxQuotedChars = 96;

/**
 * quoteInput renders a string the caller supplied for an error message: JSON-quoted and cut
 * to a bounded length, or, if it holds a signer key, a placeholder that says so instead.
 *
 * @internal Shared by the safe API.
 */
export function quoteInput(s: unknown): string {
	if (isSignerKey(s)) {
		return "<a signer (private) key, not shown>";
	}
	if (typeof s !== "string") {
		return typeof s === "symbol" ? s.toString() : String(s);
	}
	return JSON.stringify(s.length > maxQuotedChars ? `${s.slice(0, maxQuotedChars)}...` : s);
}
