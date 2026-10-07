// Copyright 2026 MedDeck. All Rights Reserved.
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

// This file has no upstream counterpart. It is the only way into, and out of, the safe API
// for a private key string, and it exists only in webtessera/server. See
// docs/decisions/0222-key-custody.md and docs/decisions/0245-key-generation-for-secret-stores.md.

import { checkOrigin, importSignerKey, type LogKey } from "../safe/keys.ts";
import { assertServerRuntime } from "../safe/runtime.ts";
import { generateKey } from "../vendor/note/note.ts";

/**
 * ImportLogKeyOptions configures importLogKey.
 *
 * ```ts
 * await importLogKey(env.LOG_SKEY, { fallback: "error" }); // WebCrypto or nothing
 * ```
 */
export interface ImportLogKeyOptions {
	/**
	 * fallback chooses what happens where WebCrypto cannot hold an Ed25519 key: `"noble"`,
	 * the default, signs with @noble/curves; `"error"` throws instead.
	 */
	readonly fallback?: "noble" | "error";
}

/**
 * importLogKey imports a log's signer key, in the note format
 * (`PRIVATE+KEY+<origin>+<hash>+<key>`, as generateLogKeyPair makes it),
 * into a non-extractable WebCrypto key where the runtime supports Ed25519, and otherwise
 * into a key @noble/curves holds in memory.
 *
 * Read the string from your secret store or environment, never from source code. The
 * bytes decoded from it are wiped once imported, and no error, toString or JSON ever
 * contains them. It refuses to run in a browser.
 *
 * `skey` may be `undefined`, so that an environment variable can be passed as it is: an
 * unset or empty key is refused with the code `INVALID_ARGUMENT`, at startup rather than at
 * the first append.
 *
 * ```ts
 * const key = await importLogKey(process.env.LOG_SKEY);
 * key.origin; // "example.com/log"
 * key.vkey;   // publish this
 * ```
 */
export async function importLogKey(skey: string | undefined, options?: ImportLogKeyOptions): Promise<LogKey> {
	assertServerRuntime();
	return importSignerKey(skey, options);
}

/**
 * LogKeyPair is a new log key as the two note-format strings a deployment keeps: `skey`,
 * the signer key, for a secret store, and `vkey`, the verifier key, to publish.
 *
 * ```ts
 * const { skey, vkey } = generateLogKeyPair("example.com/log");
 * ```
 */
export interface LogKeyPair {
	/** skey is the signer key, `PRIVATE+KEY+<origin>+<hash>+<key>`: keep it secret, and pass it to importLogKey. */
	readonly skey: string;
	/** vkey is the verifier key, `<origin>+<hash>+<key>`: publish it, for whoever verifies the log. */
	readonly vkey: string;
}

/**
 * generateLogKeyPair generates a new Ed25519 key for the log with the given origin, as the
 * note-format strings to keep: the signer key for your secret store (open the log with
 * `importLogKey(skey)`), and the verifier key to publish. The key is made exactly as Go's
 * note.GenerateKey makes one, by its port, from the runtime's cryptographic random source.
 *
 * Run it once per log, where the secret store is: a deploy script, a one-off command
 * (`npx webtessera keygen <origin>` does it from a terminal), never in request handling, and
 * never in a browser, which it refuses. For a key that never leaves the process, use
 * generateLogKey instead.
 *
 * ```ts
 * const { skey, vkey } = generateLogKeyPair("example.com/log");
 * await secrets.put("LOG_SKEY", skey);
 * await publish("LOG_VKEY", vkey);
 * ```
 */
export function generateLogKeyPair(origin: string): LogKeyPair {
	assertServerRuntime();
	checkOrigin(origin, "generateLogKeyPair");
	const { skey, vkey } = generateKey(undefined, origin);
	return { skey, vkey };
}
