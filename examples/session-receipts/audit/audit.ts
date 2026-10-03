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
// The auditor's side: neither the browser nor the server. From a session's committed copy (in
// the bucket), the session log's verifier key and the server's witness key, it checks that the
// copy is the history both of them signed, entry for entry, and lists what is in it.

import { EntryBundle } from "webtessera/api";
import { getEntryBundle } from "webtessera/client";
import { parseCheckpoint } from "webtessera/formats/log";
import { newFsck } from "webtessera/fsck";
import { DefaultHasher } from "webtessera/merkle/rfc6962";
import type { Source } from "webtessera/mirror";
import { newVerifier } from "webtessera/note";
import { newVerifierForCosignatureV1 } from "webtessera/witness";
import { decodeInteraction, type Interaction } from "../shared/interaction.ts";

/** AuditOptions says which committed log to audit, and whose keys must have signed it. */
export interface AuditOptions {
	/** log reads the committed copy: newSinkTarget(sink, { prefix: "sessions/<origin hash>/" }). */
	readonly log: Source;
	readonly origin: string;
	/** vkey is the session log's verifier key: the browser's device key. */
	readonly vkey: string;
	/** witness is the server's witness verifier key. */
	readonly witness: string;
}

/** Audit is what the auditor proved. */
export interface Audit {
	readonly size: bigint;
	readonly interactions: readonly Interaction[];
}

/** auditSession checks a committed session log, and throws if any of it does not verify. */
export async function auditSession(options: AuditOptions): Promise<Audit> {
	const device = newVerifier(options.vkey);
	const server = newVerifierForCosignatureV1(options.witness);

	// 1. Both signatures on the checkpoint: the browser's (the log's own key) and the server's
	//    cosignature. Neither side could have produced this checkpoint alone.
	const raw = await options.log.readCheckpoint();
	const { checkpoint, note } = parseCheckpoint(raw, options.origin, device, server);
	if (!(note.sigs ?? []).some((s) => s.name === server.name() && s.hash === server.keyHash())) {
		throw new Error("the committed checkpoint carries no cosignature from the server's witness");
	}

	// 2. Every tile and entry bundle of the copy, re-derived from the entries and compared with
	//    the tree the checkpoint commits to.
	const fsck = newFsck(options.origin, device, options.log, leafHashes, { n: 4 });
	await fsck.check();

	// 3. What happened in the session, in order.
	const interactions: Interaction[] = [];
	for (let b = 0n; b * 256n < checkpoint.size; b++) {
		const bundle = await getEntryBundle((i, p, s) => options.log.readEntryBundle(i, p, s), b, checkpoint.size);
		interactions.push(...bundle.entries.map(decodeInteraction));
	}
	return { size: checkpoint.size, interactions };
}

/**
 * leafHashes turns an entry bundle into the RFC 6962 leaf hashes of its entries, which is what
 * fsck needs to re-derive the tree. webtessera/fsck takes it as a parameter, as Tessera's does,
 * and this is the function Tessera's own fsck command passes it.
 */
function leafHashes(bundle: Uint8Array): Uint8Array[] {
	const eb = new EntryBundle();
	eb.unmarshalText(bundle);
	return eb.entries.map((e) => DefaultHasher.hashLeaf(e));
}
