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

// Differential suite for the static-ct layout over fixtures/data/differential_ct_log.json
// (fixtures/gen/differential_ctlog.go): the same CT entries, appended through
// newCertificateTransparencyAppender to the ObjectStore driver, must leave exactly the files
// Tessera's POSIX driver wrote. The tlog-tiles golden suite cannot catch a wrong index passed to
// an entry's bundle marshaller, because a tlog-tiles entry ignores it; a static-ct entry embeds
// it in its leaf_index extension and its Merkle leaf hash.

import { describe, it } from "vitest";
import { newAppender, newAppendOptions } from "../../../append_lifecycle.ts";
import { newPublicationAwaiter } from "../../../await.ts";
import { newCertificateTransparencyAppender, withCTLayout } from "../../../ct_only.ts";
import { Entry } from "../../../ctonly/ct.ts";
import { MemoryObjectStore } from "../../../storage/memory/memory.ts";
import { newObjectStoreDriver } from "../../../storage/objectstore/driver.ts";
import { newSigner } from "../../../vendor/note/note.ts";
import { bytesToHex, hexToBytes, loadFixture, u64 } from "../../fixtures.ts";
import { DifferentialReport } from "../differential.ts";

interface CTLogCorpus {
	readonly signerKey: string;
	readonly entries: readonly (readonly [
		timestamp: string,
		isPrecert: number,
		certificate: string,
		precertificate: string,
		issuerKeyHash: string,
		fingerprints: readonly string[],
	])[];
	readonly files: readonly (readonly [path: string, content: string])[];
}

/** describeCTLogDifferential registers the static-ct log differential test. */
export function describeCTLogDifferential(): void {
	describe("static-ct log differential (differential_ct_log.json)", () => {
		it("newCertificateTransparencyAppender on the ObjectStore driver writes the files Tessera's POSIX driver wrote", async () => {
			const f = await loadFixture<CTLogCorpus>("differential_ct_log");
			const rep = new DifferentialReport("static-ct log");
			const store = new MemoryObjectStore();
			const opts = withCTLayout(
				newAppendOptions()
					.withCheckpointSigner(newSigner(f.signerKey))
					.withBatching(f.entries.length, 3_600_000)
					.withCheckpointInterval(100)
					.withCheckpointRepublishInterval(0)
					.withGarbageCollectionInterval(0),
			);
			const ac = new AbortController();
			try {
				const { appender, shutdown, reader } = await newAppender(newObjectStoreDriver({ store }), opts, ac.signal);
				const add = newCertificateTransparencyAppender(appender);
				const futures = f.entries.map(([ts, pre, cert, precert, ikh, fps]) =>
					add(
						new Entry({
							timestamp: u64(ts),
							isPrecert: pre === 1,
							certificate: hexToBytes(cert),
							precertificate: hexToBytes(precert),
							issuerKeyHash: hexToBytes(ikh),
							fingerprintsChain: fps.map(hexToBytes),
						}),
					),
				);
				const indices = await Promise.all(futures.map((fut) => fut()));
				rep.equal(
					"(log)",
					"indices",
					f.entries.map((_, i) => i),
					indices.map((i) => Number(i.index)),
				);
				const last = futures.at(-1);
				if (last !== undefined) {
					await newPublicationAwaiter((s?: AbortSignal) => reader.readCheckpoint(s), 10, ac.signal).await(
						last,
						ac.signal,
					);
				}
				await shutdown(ac.signal);
			} finally {
				ac.abort();
			}
			const want = new Map(f.files.map(([p, c]) => [p, c]));
			rep.record();
			rep.equal(
				"(log)",
				"paths",
				[...want.keys()].sort(),
				store.keys().filter((k) => !k.endsWith(".lock")),
			);
			for (const [path, content] of want) {
				rep.record();
				const got = await store.get(path);
				rep.equal(path, "content", content, got === undefined ? "(missing)" : bytesToHex(got));
			}
			rep.assertClean(5);
		});
	});
}
