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

// This file has no upstream counterpart. It is the only way into the safe API for a private
// key string, and it exists only in webtessera/server. See docs/decisions/0222-key-custody.md.

import { importSignerKey, type LogKey } from "../safe/keys.ts";
import { assertServerRuntime } from "../safe/runtime.ts";

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
 * (`PRIVATE+KEY+<origin>+<hash>+<key>`, as `generateKey` from webtessera/note makes it),
 * into a non-extractable WebCrypto key where the runtime supports Ed25519, and otherwise
 * into a key @noble/curves holds in memory.
 *
 * Read the string from your secret store or environment, never from source code. The
 * bytes decoded from it are wiped once imported, and no error, toString or JSON ever
 * contains them. It refuses to run in a browser.
 *
 * ```ts
 * const key = await importLogKey(env.LOG_SKEY);
 * key.origin; // "example.com/log"
 * key.vkey;   // publish this
 * ```
 */
export async function importLogKey(skey: string, options?: ImportLogKeyOptions): Promise<LogKey> {
	assertServerRuntime();
	return importSignerKey(skey, options);
}
