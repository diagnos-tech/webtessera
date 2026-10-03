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
 * webtessera/witness runs a transparency log *witness*: a server that cosigns other logs'
 * checkpoints, as https://c2sp.org/tlog-witness specifies, after checking that each new
 * checkpoint is consistent with the last one it cosigned for the same log.
 *
 * # Which "witness" is this?
 *
 * Two halves of the same protocol live in two places:
 *
 *   - The package root, `webtessera`, is the *log's* side, ported from Tessera:
 *     `newWitness`, `newWitnessGroup` and `newWitnessGroupFromPolicy` describe the witnesses
 *     a log asks for cosignatures, and `AppendOptions.withWitnesses` makes the appender ask
 *     them before it publishes each checkpoint.
 *   - This module is the *witness's* side, which Tessera does not have: the server those
 *     requests arrive at. Its entry point is {@link newWitnessServer}, and its type is
 *     {@link WitnessServer}, named so as not to be mistaken for the root's `Witness`.
 *
 * # Running a witness
 *
 * ```ts
 * import { generateKey } from "webtessera/note";
 * import { newSignerForCosignatureV1, newWitnessServer, vKeyToCosignatureV1 } from "webtessera/witness";
 *
 * // Once: the witness's key. Keep skey secret; publish the cosignature/v1 vkey, which is
 * // what log operators put in their witness policies.
 * const { skey, vkey } = generateKey(undefined, "witness.example/w1");
 * const publicKey = vKeyToCosignatureV1(vkey);
 *
 * const witness = newWitnessServer({
 *   signer: newSignerForCosignatureV1(skey),
 *   store,                                     // any ObjectStore: memory, IndexedDB, SQLite...
 *   logs: [{ origin: "example.com/log", verifierKeys: [logVkey] }],
 * });
 * ```
 *
 * `witness.handle` is a `webtessera/http` Handler serving `POST <prefix>/add-checkpoint` and
 * the monitoring endpoint `GET <prefix>/<origin hash>/checkpoint`; serve it like any other
 * (see that module for Deno, Bun, Workers, Node and service workers). `witness.addCheckpoint`
 * is the same call without HTTP.
 *
 * # Many logs
 *
 * A witness need not know its logs in advance. `lookupLog(origin)` is asked about every
 * origin the static `logs` do not list, on every request, so a server can witness an
 * open-ended population of logs (one per user, per device, per browser session) by storing
 * each log's verifier key when the log is created and returning it from the lookup. Logs that
 * live in browser tabs post their checkpoints cross-origin; turn on `cors` for them.
 *
 * # Guarantees
 *
 * Every MUST of tlog-witness v1.0.0's add-checkpoint section is implemented, in the order
 * the spec states its checks, with the status codes it assigns: 400 for a malformed body,
 * 404 for an unknown origin, 403 when no trusted signature verifies, 409 with
 * `text/x.tlog.size` when the old size is stale (which is what Tessera's client retries
 * on), 409 for a same-size root mismatch, 422 for a bad proof. The latest cosigned
 * checkpoint of each log is checked and replaced under the store's lock, so concurrent
 * requests cannot roll a log back, and is durable before the cosignature is returned.
 * Cosignatures are timestamped cosignature/v1 Ed25519 signatures whose timestamps never go
 * backwards for a log. docs/decisions/0171-witness-server.md lists what is not
 * implemented (the optional sign-subtree call, ML-DSA cosignatures).
 *
 * # Keys
 *
 * The cosignature/v1 key functions are re-exported here from the port of
 * `github.com/transparency-dev/formats/note`, because a witness cannot be set up without
 * them.
 *
 * @module
 */

export {
	coSigV1Timestamp,
	newSignerForCosignatureV1,
	newVerifierForCosignatureV1,
	vKeyToCosignatureV1,
} from "../vendor/formats/note/note_cosigv1.ts";
export {
	ErrInvalidProof,
	ErrMalformedRequest,
	ErrNoValidSignature,
	ErrOldSizeMismatch,
	ErrRootMismatch,
	ErrUnknownLog,
	OldSizeMismatchError,
} from "./errors.ts";
export {
	type AddCheckpointRequest,
	MaxConsistencyProofLines,
	marshalAddCheckpointRequest,
	parseAddCheckpointRequest,
} from "./request.ts";
export {
	type InconsistencyEvidence,
	type LogKeys,
	type LogLookup,
	newWitnessServer,
	type WitnessedLog,
	WitnessServer,
	type WitnessServerOptions,
} from "./server.ts";
export { originHash, type WitnessStore } from "./state.ts";
