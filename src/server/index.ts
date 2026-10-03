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

/**
 * webtessera/server is the safe API for a log that runs in your server's private
 * environment: Node.js, Deno, Bun, or an edge runtime such as Cloudflare Workers. It is a
 * layer over the faithful port of Tessera with no upstream counterpart, and it never
 * changes how the ported API behaves (docs/decisions/0220-safe-api-entry-points.md).
 *
 * # A log in three calls
 *
 * ```ts
 * import { importLogKey, openServerLog, verifyReceipt } from "webtessera/server";
 * import { fromSqliteSync } from "webtessera/storage/sqlite";
 *
 * const log = await openServerLog({
 *   key: await importLogKey(env.LOG_SKEY),
 *   storage: { sqlite: fromSqliteSync(new DatabaseSync("log.db")) },
 * });
 * const receipt = await log.append(entry);  // a C2SP tlog-proof, already verified
 * verifyReceipt(receipt.text, { vkey: log.vkey, data: entry }); // anyone, offline
 * ```
 *
 * `log.handler` serves the log over the tlog-tiles read API (see webtessera/http), and
 * `log.close()` waits for every appended entry to be published before it stops.
 *
 * # What it will not let you do
 *
 *   - Run in a browser: a browser bundle resolves this module to one that fails the build,
 *     and a browser that loads it anyway gets an error at import.
 *   - Keep a log in memory by accident: storage is a required choice, and memory must be
 *     asked for by name.
 *   - Fork a log across processes: SQLite storage uses lease locking unless told the
 *     process is the only writer.
 *   - Lose track of publication: append resolves only once a checkpoint commits to the
 *     entry, and hands back a receipt it has verified.
 *   - Change a log's key: a log refuses to open with a key that did not sign its checkpoint.
 *   - Leak the key: keys are non-extractable WebCrypto keys wherever the runtime supports
 *     Ed25519, and no error, toString or JSON ever contains key material.
 *
 * The ported API (`webtessera`, `webtessera/client`, `webtessera/storage/*`, ...) remains
 * the way to do anything this module does not: every log exposes its ported `reader` and
 * `appender`.
 *
 * @module
 */

import { assertServerRuntime } from "../safe/runtime.ts";

// The first of two runtime checks: this one fails the import in a browser that loaded the
// module anyway. package.json lists this module in "sideEffects" so that bundlers keep the
// call; one that ignores the list may skip this body when a caller imports only some of its
// names, so each function that holds a key checks again.
assertServerRuntime();

export {
	type GenerateLogKeyOptions,
	generateLogKey,
	type KeyBackend,
	type LogKey,
	webCryptoEd25519,
} from "../safe/keys.ts";
export {
	type AppendCallOptions,
	DefaultCheckpointIntervalMs,
	DefaultPublishTimeoutMs,
	type LogOptions,
	type TransparencyLog,
} from "../safe/log.ts";
export {
	type LogCheckpoint,
	parseReceipt,
	type Receipt,
	ReceiptError,
	type VerifiedReceipt,
	type VerifyReceiptOptions,
	verifyReceipt,
	type WitnessPolicy,
} from "../safe/receipt.ts";
export { detectRuntime, type RuntimeKind } from "../safe/runtime.ts";
export { type ImportLogKeyOptions, importLogKey } from "./keys.ts";
export { openServerLog, type ServerLog, type ServerLogOptions, type ServerStorage } from "./log.ts";
