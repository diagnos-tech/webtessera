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

// The receipt in the hero: a log opened with the safe API (webtessera/server) while the page
// builds, an entry appended to it, and the receipt that append() returned, checked again
// with verifyReceipt as any client would check it, offline. The key is the page's
// demonstration key, imported the way a server imports its key from a secret store; the
// entries are the package's entry points, as in the sample log, so the two logs are the same
// tree under the same key.

import { importLogKey, openServerLog, verifyReceipt } from "webtessera/server";
import { readTiles } from "../shared/inspect.ts";
import type { TileView } from "../shared/tiles.ts";
import { sampleKey } from "./sample-log.ts";

/** BuiltReceipt is the receipt the hero shows, and what the build learnt about it. */
export interface BuiltReceipt {
	/** text is the receipt as append() returned it: a C2SP tlog-proof. */
	readonly text: string;
	readonly index: bigint;
	readonly size: bigint;
	/** entry is the appended entry the receipt proves. */
	readonly entry: string;
	readonly vkey: string;
	/** from says which call produced the receipt: append, or prove for a receipt against the final tree. */
	readonly from: "append" | "prove";
	/** custody describes the key that signed it: its backend and whether it could be exported. */
	readonly custody: { readonly backend: string; readonly extractable: boolean };
	/** tile is the log's first level-0 tile, to draw beside the receipt. */
	readonly tile: TileView | undefined;
}

const enc = new TextEncoder();

/** buildReceipt opens a server log in memory, appends entries and returns entry `target`'s receipt. */
export async function buildReceipt(origin: string, entries: readonly string[], target: number): Promise<BuiltReceipt> {
	const key = await importLogKey(sampleKey(origin).skey);
	const log = await openServerLog({ key, storage: { memory: true }, checkpointIntervalMs: 100 });
	try {
		const receipts = await Promise.all(entries.map((e) => log.append(enc.encode(e))));
		const index = BigInt(Math.min(target, entries.length - 1));
		const i = receipts.findIndex((r) => r.index === index);
		const appended = receipts[i];
		const total = BigInt(entries.length);
		// The receipt append() returned is relative to the first checkpoint that covered the
		// entry. If the entries were published in more than one checkpoint, ask for a receipt
		// against the final tree instead, so that the page draws one tree.
		const receipt = appended !== undefined && appended.checkpoint.size === total ? appended : await log.prove(index);
		const entry = entries[i] ?? "";
		const verified = verifyReceipt(receipt.text, { vkey: log.vkey, data: enc.encode(entry) });
		if (verified.index !== index) {
			throw new Error(`the hero receipt verified for entry ${verified.index}, not ${index}`);
		}
		const tiles = await readTiles(log.reader, receipt.checkpoint.size);
		return {
			text: receipt.text,
			index,
			size: receipt.checkpoint.size,
			entry,
			vkey: log.vkey,
			from: receipt === appended ? "append" : "prove",
			custody: { backend: key.backend, extractable: key.extractable },
			tile: tiles.find((t) => t.level === 0),
		};
	} finally {
		await log.close();
	}
}
