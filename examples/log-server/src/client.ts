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
// What any client of the log does, with webtessera/client: fetch the checkpoint and check the
// log's signature on it, prove that an entry is in the tree it commits to, and prove that the
// log only grew since a checkpoint seen earlier. None of it trusts the server.

import { fetchCheckpoint, getEntryBundle, newHTTPFetcher, newProofBuilder } from "webtessera/client";
import { parseCheckpoint } from "webtessera/formats/log";
import { verifyConsistency, verifyInclusion } from "webtessera/merkle/proof";
import { DefaultHasher } from "webtessera/merkle/rfc6962";
import { newVerifier } from "webtessera/note";

/** VerifyLogOptions says what to check about the log served at url. */
export interface VerifyLogOptions {
	readonly url: URL;
	/** vkey is the log's published verifier key. */
	readonly vkey: string;
	/** index and entry, together, ask for a proof that entry is at index. */
	readonly index?: bigint;
	readonly entry?: Uint8Array;
	/** previous is a checkpoint seen earlier, which the current one must extend. */
	readonly previous?: Uint8Array;
	/** fetch makes the HTTP requests; tests pass the server's handler. */
	readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** VerifiedLog is what verifyLog proved. */
export interface VerifiedLog {
	readonly size: bigint;
	readonly root: Uint8Array;
	/** checkpoint is the verified checkpoint, to keep as `previous` for next time. */
	readonly checkpoint: Uint8Array;
	/** entryAtIndex is the entry stored at index, when one was asked for. */
	readonly entryAtIndex?: Uint8Array;
}

/** verifyLog checks the log at options.url, and throws if anything does not verify. */
export async function verifyLog(options: VerifyLogOptions): Promise<VerifiedLog> {
	const verifier = newVerifier(options.vkey);
	const log = newHTTPFetcher(options.url, options.fetch);
	const { checkpoint, raw } = await fetchCheckpoint((s) => log.readCheckpoint(s), verifier, verifier.name());
	const proofs = await newProofBuilder(checkpoint.size, (l, i, p, s) => log.readTile(l, i, p, s));

	if (options.previous !== undefined) {
		// A log that rewrote or dropped any entry since `previous` cannot produce this proof.
		const old = parseCheckpoint(options.previous, verifier.name(), verifier).checkpoint;
		if (old.size > checkpoint.size) {
			throw new Error(`the log shrank from ${old.size} to ${checkpoint.size} entries`);
		}
		const proof = await proofs.consistencyProof(old.size, checkpoint.size);
		verifyConsistency(DefaultHasher, old.size, checkpoint.size, proof, old.hash, checkpoint.hash);
	}

	let entryAtIndex: Uint8Array | undefined;
	if (options.index !== undefined) {
		const { index } = options;
		const bundle = await getEntryBundle((i, p, s) => log.readEntryBundle(i, p, s), index / 256n, checkpoint.size);
		entryAtIndex = bundle.entries[Number(index % 256n)];
		const want = options.entry ?? entryAtIndex;
		if (want === undefined) {
			throw new Error(`the log has no entry ${index}`);
		}
		// The bundle came from the server too, so the entry is proven against the signed root.
		const proof = await proofs.inclusionProof(index);
		verifyInclusion(DefaultHasher, index, checkpoint.size, DefaultHasher.hashLeaf(want), proof, checkpoint.hash);
	}

	return {
		size: checkpoint.size,
		root: checkpoint.hash,
		checkpoint: raw,
		...(entryAtIndex === undefined ? {} : { entryAtIndex }),
	};
}
