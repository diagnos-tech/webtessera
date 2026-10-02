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

// Drives the Worker over HTTP, as a client of the log would, and verifies what it
// serves with webtessera's own client. Every test holds whatever earlier tests added
// to the log, so none depends on the log's exact size.

import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { tilePath } from "webtessera/api/layout";
import { fetchCheckpoint, getEntryBundle, newHTTPFetcher, newProofBuilder } from "webtessera/client";
import { verifyInclusion } from "webtessera/merkle/proof";
import { DefaultHasher } from "webtessera/merkle/rfc6962";
import { newVerifier } from "webtessera/note";

const base = "https://log.example/";
const fetchLog = (input: string, init?: RequestInit): Promise<Response> =>
	exports.default.fetch(new Request(new URL(input, base), init));
const log = newHTTPFetcher(new URL(base), fetchLog);
const verifier = newVerifier(env.TEST_LOG_PUBLIC_KEY);

let unique = 0;

/** entry returns distinct entry data of the given length. */
function entry(length = 32): Uint8Array {
	const data = new Uint8Array(length);
	new DataView(data.buffer).setUint32(0, ++unique);
	return data;
}

async function add(data: Uint8Array): Promise<bigint> {
	const res = await fetchLog("/add", { method: "POST", body: data });
	const body = await res.text();
	expect(res.status, body).toBe(200);
	expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
	// Exactly the decimal index: upstream's integration test parses the whole body.
	expect(body).toMatch(/^(0|[1-9][0-9]*)$/);
	return BigInt(body);
}

async function checkpoint() {
	return (await fetchCheckpoint((s) => log.readCheckpoint(s), verifier, verifier.name())).checkpoint;
}

describe("transparency log Worker", () => {
	it("answers POST /add once a signed checkpoint commits to the entry", async () => {
		const indices = await Promise.all([add(entry()), add(entry()), add(entry())]);
		expect(new Set(indices).size).toBe(3);
		const cp = await checkpoint();
		for (const i of indices) {
			expect(cp.size > i).toBe(true);
		}

		const res = await fetchLog("/checkpoint");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
		expect(res.headers.get("Cache-Control")).toBe("no-cache");
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("serves tiles and bundles from which a client verifies inclusion", async () => {
		// The largest entry tlog-tiles allows, which takes its bundle past the storage
		// driver's per-value limit.
		const data = entry(0xffff);
		const i = await add(data);
		const cp = await checkpoint();

		const bundle = await getEntryBundle((n, p, s) => log.readEntryBundle(n, p, s), i / 256n, cp.size);
		expect(bundle.entries[Number(i % 256n)]).toEqual(data);

		const proofs = await newProofBuilder(cp.size, (l, n, p, s) => log.readTile(l, n, p, s));
		const proof = await proofs.inclusionProof(i);
		verifyInclusion(DefaultHasher, i, cp.size, DefaultHasher.hashLeaf(data), proof, cp.hash);
	});

	it("caches full tiles indefinitely, and partial tiles and bundles briefly", async () => {
		await Promise.all(Array.from({ length: 256 }, () => add(entry())));
		const { size } = await checkpoint();

		for (const path of ["/tile/0/000", "/tile/entries/000"]) {
			const res = await fetchLog(path);
			expect(res.status, path).toBe(200);
			expect(res.headers.get("Content-Type"), path).toBe("application/octet-stream");
			expect(res.headers.get("Cache-Control"), path).toBe("public, max-age=31536000, immutable");
		}
		expect((await (await fetchLog("/tile/0/000")).arrayBuffer()).byteLength).toBe(256 * 32);

		if (size % 256n !== 0n) {
			const partial = `/${tilePath(0n, size / 256n, Number(size % 256n))}`;
			const res = await fetchLog(partial);
			expect(res.status, partial).toBe(200);
			expect(res.headers.get("Cache-Control"), partial).toBe("public, max-age=60");
		}

		const head = await fetchLog("/checkpoint", { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");
	});

	it("rejects malformed requests and reports missing resources", async () => {
		const cases: [string, RequestInit, number][] = [
			["/", {}, 404],
			["/checkpoints", {}, 404],
			["/tile/0/x999/999", {}, 404],
			["/tile/entries/x999/999.p/3", {}, 404],
			["/tile/0/abc", {}, 400],
			["/tile/64/000", {}, 400],
			["/tile/0/000.p/256", {}, 400],
			["/add", {}, 405],
			["/checkpoint", { method: "POST" }, 405],
			["/add", { method: "POST", body: new Uint8Array(0x10000) }, 413],
		];
		for (const [path, init, status] of cases) {
			const res = await fetchLog(path, init);
			expect(res.status, `${init.method ?? "GET"} ${path}`).toBe(status);
			await res.body?.cancel();
		}
		expect((await fetchLog("/add")).headers.get("Allow")).toBe("POST");
	});
});
