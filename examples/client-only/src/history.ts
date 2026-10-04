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
// Reads this device's log back: every event, with a receipt proved against the latest
// checkpoint and verified as anyone holding the vkey would. And, for one receipt, the same
// verification done by hand with the ported API underneath, to show what verifyReceipt checks.

import { type BrowserLog, type Receipt, verifyReceipt } from "webtessera/browser";
import { newProofBuilder } from "webtessera/client";
import { parseCheckpoint } from "webtessera/formats/log";
import { verifyInclusion } from "webtessera/merkle/proof";
import { DefaultHasher } from "webtessera/merkle/rfc6962";
import { type DeviceEvent, decodeEvent, encodeEvent } from "./events.ts";

/** LoggedEvent is one event of the log, and its verified receipt. */
export interface LoggedEvent {
	readonly index: bigint;
	readonly event: DeviceEvent;
	readonly receipt: Receipt;
}

/** readHistory returns the log's newest events, each with a receipt that has been verified. */
export async function readHistory(log: BrowserLog, newest = 20n): Promise<LoggedEvent[]> {
	const { size } = await log.latestCheckpoint();
	const out: LoggedEvent[] = [];
	for await (const { index, data } of log.entries(size > newest ? size - newest : 0n, size)) {
		const receipt = await log.prove(index);
		verifyReceipt(receipt, { vkey: log.vkey, data });
		out.push({ index, event: decodeEvent(data), receipt });
	}
	return out.reverse();
}

/**
 * verifyByHand checks a receipt the long way, with the ported API: the log's signature on the
 * checkpoint (formats/log), the inclusion proof rebuilt from the log's own tiles
 * (webtessera/client), and that proof against the root (merkle/proof). It returns the proof
 * hashes, which verifyReceipt also checks, from the receipt alone.
 */
export async function verifyByHand(log: BrowserLog, logged: LoggedEvent): Promise<Uint8Array[]> {
	const { checkpoint } = parseCheckpoint(logged.receipt.checkpoint.signed, log.origin, log.verifier);
	const proofs = await newProofBuilder(checkpoint.size, (l, i, p, s) => log.reader.readTile(l, i, p, s));
	const proof = await proofs.inclusionProof(logged.index);
	const leaf = DefaultHasher.hashLeaf(encodeEvent(logged.event));
	verifyInclusion(DefaultHasher, logged.index, checkpoint.size, leaf, proof, checkpoint.hash);
	return proof;
}
