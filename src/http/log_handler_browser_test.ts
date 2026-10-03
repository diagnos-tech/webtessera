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

// A smoke test of the HTTP handlers in a real browser, where they would run inside a service
// worker: a log kept in the tab, served by newLogHandler, verified by the client through it,
// and witnessed by a WitnessServer, with nothing but the browser's own Request, Response and
// streams underneath.

import { describe, expect, it } from "vitest";
import { fetchCheckpoint, newHTTPFetcher, newProofBuilder } from "../client/index.ts";
import { defaultMerkleLeafHasher } from "../lifecycle.ts";
import { MemoryObjectStore } from "../storage/memory/memory.ts";
import { verifyInclusion } from "../vendor/merkle/proof/index.ts";
import { DefaultHasher } from "../vendor/merkle/rfc6962/rfc6962.ts";
import { generateKey } from "../vendor/note/note.ts";
import { marshalAddCheckpointRequest, newSignerForCosignatureV1, newWitnessServer } from "../witness/index.ts";
import { combineHandlers, newLogHandler } from "./index.ts";
import { entriesOf, fetchVia, newTestLog } from "./testing/testlog.ts";

describe("webtessera/http in a browser", () => {
	it("serves a log the client verifies, and a witness that cosigns it", async () => {
		const log = await newTestLog({ origin: "example.com/browser-log" });
		try {
			await log.add(entriesOf(260));
			const witness = newWitnessServer({
				signer: newSignerForCosignatureV1(generateKey(undefined, "witness.example/browser").skey),
				store: new MemoryObjectStore(),
				logs: [{ origin: log.origin, verifierKeys: [log.vkey] }],
			});
			const serve = combineHandlers(newLogHandler({ reader: log.reader, cors: true }), witness.handle);
			const remote = newHTTPFetcher(new URL("https://log.example/"), fetchVia(serve));

			const { checkpoint, raw } = await fetchCheckpoint((s) => remote.readCheckpoint(s), log.verifier, log.origin);
			const pb = await newProofBuilder(checkpoint.size, (l, i, p, s) => remote.readTile(l, i, p, s));
			const proof = await pb.inclusionProof(3n);
			const leaf = defaultMerkleLeafHasher(await remote.readEntryBundle(0n, 0))[3] as Uint8Array;
			verifyInclusion(DefaultHasher, 3n, checkpoint.size, leaf, proof, checkpoint.hash);

			const r = await serve(
				new Request("https://log.example/add-checkpoint", {
					method: "POST",
					body: marshalAddCheckpointRequest({ oldSize: 0n, proof: [], checkpoint: raw }) as BodyInit,
				}),
			);
			expect(r.status).toBe(200);
			expect(await r.text()).toMatch(/^— witness\.example\/browser /);
		} finally {
			await log.shutdown();
		}
	});
});
