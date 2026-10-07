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

/**
 * webtessera/browser is the safe API for code that runs in the browser's public
 * environment: a window, a worker, or a service worker, where everything the code holds
 * is readable by whoever loads the page. It is a layer over the faithful port of Tessera
 * with no upstream counterpart, and it never changes how the ported API behaves
 * (docs/decisions/0220-safe-api-entry-points.md). Nothing in it handles a private key
 * string, so it is safe to import anywhere.
 *
 * # A device's own log
 *
 * ```ts
 * import { openBrowserLog, openDeviceKey, verifyReceipt } from "webtessera/browser";
 *
 * const key = await openDeviceKey("device.example/7f3a"); // generated here, cannot be exported
 * const log = await openBrowserLog({ key });              // kept in IndexedDB
 * const receipt = await log.append(new TextEncoder().encode("signed the form"));
 * ```
 *
 * The log is tamper-evident: once a checkpoint is published, the device cannot rewrite
 * what came before without every holder of a receipt noticing. Witnessing makes that
 * visible to others: pass `witnesses` (a `WitnessGroup` from `webtessera`) and every
 * checkpoint is cosigned, for example by your server's `webtessera/witness`, before the
 * log publishes it.
 *
 * # Verifying receipts
 *
 * `verifyReceipt` checks a receipt from any log, offline, against the log's vkey and the
 * entry: the browser is where most receipts are verified.
 *
 * # What it will not let you do
 *
 *   - Hand it a private key string: a browser log's key is generated on the device with
 *     `openDeviceKey`, or imported as a `CryptoKey` with `fromCryptoKey`.
 *   - Keep a persistent log with a key that does not persist with it.
 *   - Change a log's key, or open a log another key created.
 *   - Lose track of publication: `append` resolves with a receipt it has verified.
 *
 * @module
 */

export { WebtesseraError, type WebtesseraErrorCode } from "../safe/errors.ts";
export {
	type GenerateLogKeyOptions,
	generateLogKey,
	type KeyBackend,
	type LogKey,
	webCryptoEd25519,
} from "../safe/keys.ts";
export {
	type AppendCallOptions,
	type AppendManyOptions,
	type AsyncDisposableLog,
	DefaultCheckpointIntervalMs,
	DefaultFsckWorkers,
	DefaultPublishTimeoutMs,
	type FsckOptions,
	type FsckResult,
	type LogEntry,
	type LogOptions,
	MaxExtraDataBytes,
	type ProveOptions,
	type TransparencyLog,
} from "../safe/log.ts";
export {
	type LogCheckpoint,
	type LogCheckpointJSON,
	parseReceipt,
	type Receipt,
	ReceiptError,
	type ReceiptJSON,
	type VerifiedReceipt,
	type VerifiedReceiptJSON,
	type VerifyReceiptEntry,
	type VerifyReceiptKey,
	type VerifyReceiptOptions,
	verifyReceipt,
	type WitnessPolicy,
} from "../safe/receipt.ts";
export { detectRuntime, type RuntimeKind } from "../safe/runtime.ts";
export {
	DefaultDeviceKeyDatabase,
	type DeviceKeyOptions,
	deleteDeviceKey,
	loadDeviceKey,
	openDeviceKey,
	saveDeviceKey,
} from "./device_key.ts";
export { fromCryptoKey } from "./keys.ts";
export { type BrowserLog, type BrowserLogOptions, type BrowserStorage, openBrowserLog } from "./log.ts";
