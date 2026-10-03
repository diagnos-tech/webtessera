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

// The witness against the other half of the protocol: Tessera's appender, configured with
// withWitnesses from a witness policy, talking to the witness over (in-process) HTTP. The
// appender is the port of upstream's client, so what it accepts is what a Go Tessera log
// would accept.

import { describe, expect, it } from "vitest";
import { newWitnessGroupFromPolicy } from "webtessera";
import { combineHandlers } from "webtessera/http";
import {
	newSignerForCosignatureV1,
	newVerifierForCosignatureV1,
	newWitnessServer,
	vKeyToCosignatureV1,
	type WitnessServer,
} from "webtessera/witness";
import type { FetchFn } from "../client/fetcher.ts";
import { entriesOf, newTestLog } from "../http/testing/testlog.ts";
import { checkpointUnsafe } from "../internal/parse/parse.ts";
import { MemoryObjectStore } from "../storage/memory/memory.ts";
import { generateKey, open, verifierList } from "../vendor/note/note.ts";

const origin = "example.com/interop-log";

interface testWitness {
	readonly server: WitnessServer;
	/** vkey is the witness's cosignature/v1 verifier key, as a policy names it. */
	readonly vkey: string;
}

function newTestWitness(name: string, logVkey: string, prefix = "/"): testWitness {
	const { skey, vkey } = generateKey(undefined, name);
	return {
		server: newWitnessServer({
			signer: newSignerForCosignatureV1(skey),
			store: new MemoryObjectStore(),
			logs: [{ origin, verifierKeys: [logVkey] }],
			prefix,
		}),
		vkey: vKeyToCosignatureV1(vkey),
	};
}

/** network routes requests by host to the witness serving it, and records every exchange. */
function network(byHost: Record<string, WitnessServer>, log: { url: string; status: number; body: string }[]): FetchFn {
	return async (input, init) => {
		const request = new Request(input, init);
		const w = byHost[new URL(input).host];
		const r = w === undefined ? new Response(null, { status: 502 }) : await combineHandlers(w.handle)(request);
		log.push({ url: input, status: r.status, body: await r.clone().text() });
		return r;
	};
}

describe("a Tessera appender witnessed by WitnessServer", () => {
	it("gets every published checkpoint cosigned, as its witness policy requires", async () => {
		const logKeys = generateKey(undefined, origin);
		const w1 = newTestWitness("witness.example/w1", logKeys.vkey);
		const w2 = newTestWitness("witness.example/w2", logKeys.vkey, "/prefix");
		const policy =
			`witness w1 ${w1.vkey} https://w1.example/\n` +
			`witness w2 ${w2.vkey} https://w2.example/prefix\n` +
			"group both all w1 w2\n" +
			"quorum both\n";
		const group = newWitnessGroupFromPolicy(new TextEncoder().encode(policy));
		const exchanges: { url: string; status: number; body: string }[] = [];

		const log = await newTestLog({
			origin,
			keys: logKeys,
			fetch: network({ "w1.example": w1.server, "w2.example": w2.server }, exchanges),
			configure: (o) => o.withWitnesses(group, null),
		});
		try {
			await log.add(entriesOf(3));
			await log.add(entriesOf(300, 3));
			const cp = await log.reader.readCheckpoint();

			// The published checkpoint satisfies the policy...
			expect(group.satisfied(cp)).toBe(true);
			// ...and carries cosignatures the cosignature/v1 verifier accepts.
			const n = open(
				cp,
				verifierList(newVerifierForCosignatureV1(w1.vkey), newVerifierForCosignatureV1(w2.vkey), log.verifier),
			);
			expect(n.sigs?.map((s) => s.name).sort()).toEqual([origin, "witness.example/w1", "witness.example/w2"]);

			// Both witnesses recorded it, through consistency proofs from the previous size.
			const size = checkpointUnsafe(cp).size;
			for (const w of [w1, w2]) {
				const latest = await w.server.latestCheckpoint(origin);
				expect(checkpointUnsafe(latest as Uint8Array).size).toBe(size);
			}
			expect(exchanges.some((e) => e.url === "https://w2.example/prefix/add-checkpoint")).toBe(true);
			expect(exchanges.every((e) => e.status === 200)).toBe(true);
		} finally {
			await log.shutdown();
		}
	});

	it("recovers through 409 when the witness has not seen the log before", async () => {
		const logKeys = generateKey(undefined, origin);
		const store = new MemoryObjectStore();

		// The log runs unwitnessed for a while...
		const before = await newTestLog({ origin, keys: logKeys, store });
		await before.add(entriesOf(10));
		await before.shutdown();

		// ...and then adds a witness, which has never heard of it. The appender starts from
		// the size it last published, the witness answers 409 with size 0, and the appender
		// retries from there, as the spec intends.
		const w = newTestWitness("witness.example/w1", logKeys.vkey);
		const group = newWitnessGroupFromPolicy(
			new TextEncoder().encode(`witness w1 ${w.vkey} https://w1.example\nquorum w1\n`),
		);
		const exchanges: { url: string; status: number; body: string }[] = [];
		const log = await newTestLog({
			origin,
			keys: logKeys,
			store,
			fetch: network({ "w1.example": w.server }, exchanges),
			configure: (o) => o.withWitnesses(group, null),
		});
		try {
			await log.add(entriesOf(5, 10));
			const cp = await log.reader.readCheckpoint();
			expect(group.satisfied(cp)).toBe(true);
			expect(exchanges[0]).toMatchObject({ status: 409, body: "0\n" });
			expect(exchanges.slice(1).every((e) => e.status === 200)).toBe(true);

			// From then on, the witness follows the log by consistency proofs.
			await log.add(entriesOf(5, 15));
			const latest = await w.server.latestCheckpoint(origin);
			expect(checkpointUnsafe(latest as Uint8Array).size).toBe(20n);
		} finally {
			await log.shutdown();
		}
	});
});
