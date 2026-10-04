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
// Notarizes documents through the notary's fetch handler, on an in-memory node:sqlite database,
// and verifies the receipts offline as a third party would. Most of the file is the other half:
// the ways a receipt can be forged or altered, each of which must fail, and fail for the right
// reason.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TLogProof } from "webtessera/formats/proof";
import { generateKey } from "webtessera/note";
import type { ServerLog } from "webtessera/server";
import { sha256 } from "./encoding.ts";
import { decodeRecord, encodeRecord } from "./record.ts";
import { node } from "./runtime/node.ts";
import { newNotary, openNotaryLog } from "./server.ts";
import { newSubmitter, type Submitter, sign } from "./submission.ts";
import { NotarizationError, verifyNotarization } from "./verify_notarization.ts";

const enc = new TextEncoder();
const document = enc.encode("Lease agreement, signed 3 October 2026");
const notaryKey = generateKey(undefined, "notary.test/v1");

interface notary {
	readonly log: ServerLog;
	readonly notarize: (body: unknown) => Promise<Response>;
	close(): Promise<void>;
}

/**
 * openNotary opens a notary on a private in-memory database, which the adapter locks locally:
 * nothing outside this process can reach it.
 */
async function openNotary(skey: string): Promise<notary> {
	const db = node.openSqlite(":memory:");
	const log = await openNotaryLog(db.database, { notaryKey: skey });
	const serve = newNotary(log, { now: () => Date.UTC(2026, 9, 3, 12) });
	return {
		log,
		notarize: (body) =>
			serve(new Request("http://notary.test/notarize", { method: "POST", body: JSON.stringify(body) })),
		close: async () => {
			await log.close();
			db.close();
		},
	};
}

let n: notary;
let submitter: Submitter;
let receipt: string;
beforeAll(async () => {
	n = await openNotary(notaryKey.skey);
	submitter = await newSubmitter();
	const res = await n.notarize(await sign(submitter, await sha256(document)));
	expect(res.status).toBe(200);
	receipt = await res.text();
});
afterAll(() => n.close());

/** failure returns the reason verifyNotarization gives for refusing input. */
async function failure(input: Partial<Parameters<typeof verifyNotarization>[0]>): Promise<string> {
	try {
		await verifyNotarization({ receipt, document, vkey: notaryKey.vkey, ...input });
	} catch (err) {
		if (err instanceof NotarizationError) {
			return err.reason;
		}
		throw err;
	}
	throw new Error("the notarization verified");
}

/** edit decodes the receipt, lets change alter it, and re-encodes it. */
function edit(change: (p: TLogProof) => void): string {
	const p = new TLogProof();
	p.unmarshal(enc.encode(receipt));
	change(p);
	return new TextDecoder().decode(p.marshal());
}

describe("notary", () => {
	it("returns a receipt that proves the notarization offline", async () => {
		const verified = await verifyNotarization({ receipt, document, vkey: notaryKey.vkey });
		expect(verified.index).toBe(0n);
		expect(verified.notarizedAt.toISOString()).toBe("2026-10-03T12:00:00.000Z");
		expect(verified.logSize).toBeGreaterThanOrEqual(1n);
	});

	it("refuses a submission whose signature is not the submitter's, and logs nothing", async () => {
		const before = (await n.log.latestCheckpoint()).size;
		const body = await sign(submitter, await sha256(document));
		const someoneElse = await newSubmitter();
		const res = await n.notarize({ ...body, publicKey: (await sign(someoneElse, new Uint8Array(32))).publicKey });
		expect(res.status).toBe(403);
		expect((await n.log.latestCheckpoint()).size).toBe(before);
	});

	it("refuses malformed submissions", async () => {
		const good = await sign(submitter, await sha256(document));
		for (const body of [null, "a string", {}, { ...good, sha256: "abcd" }, { ...good, signature: "not base64!" }]) {
			expect((await n.notarize(body)).status, JSON.stringify(body)).toBe(400);
		}
	});
});

describe("a receipt that does not hold", () => {
	it("fails for any other document", async () => {
		expect(await failure({ document: enc.encode("Lease agreement, signed 4 October 2026") })).toBe("document");
	});

	it("fails when its record was altered, even though the format does not protect extra data", async () => {
		const altered = edit((p) => {
			const r = decodeRecord(p.extraData ?? new Uint8Array(0));
			p.extraData = encodeRecord({ ...r, notarizedAt: r.notarizedAt - 86_400_000n });
		});
		expect(await failure({ receipt: altered })).toBe("receipt");
	});

	it("fails when its proof, index or checkpoint was altered", async () => {
		const extra = await openNotary(notaryKey.skey);
		const grown = await extra.notarize(await sign(submitter, await sha256(enc.encode("another"))));
		const otherProof = new TLogProof();
		otherProof.unmarshal(enc.encode(await grown.text()));
		await extra.close();

		expect(await failure({ receipt: edit((p) => p.hashes.push(new Uint8Array(32))) })).toBe("receipt");
		expect(await failure({ receipt: edit((p) => (p.index += 1n)) })).toBe("receipt");
		// A genuine checkpoint of the same log key, but of another tree.
		expect(await failure({ receipt: edit((p) => (p.checkpoint = otherProof.checkpoint)) })).toBe("receipt");
	});

	it("fails when forged by a notary with another key", async () => {
		const forger = await openNotary(generateKey(undefined, "notary.test/v1").skey);
		const res = await forger.notarize(await sign(submitter, await sha256(document)));
		await forger.close();
		expect(await failure({ receipt: await res.text() })).toBe("receipt");
	});

	it("fails without the record in its extra data", async () => {
		expect(await failure({ receipt: edit((p) => (p.extraData = undefined)) })).toBe("receipt");
	});

	it("fails for an unexpected signer", async () => {
		expect(await failure({ signer: (await sign(await newSubmitter(), new Uint8Array(32))).publicKey })).toBe("signer");
	});
});

describe("verify CLI", () => {
	let dir: string;
	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "notary-cli-"));
		await writeFile(join(dir, "lease.txt"), document);
		await writeFile(join(dir, "lease.txt.tlog-proof"), receipt);
		await writeFile(
			join(dir, "forged.tlog-proof"),
			edit((p) => (p.index += 1n)),
		);
	});
	afterAll(() => rm(dir, { recursive: true, force: true }));

	/** cli runs scripts/verify.ts in a child process, offline, and returns its exit code and output. */
	function cli(...args: string[]): Promise<{ code: number | null; out: string }> {
		const script = new URL("../scripts/verify.ts", import.meta.url).pathname;
		const child = spawn(execPath, [script, ...args]);
		let out = "";
		child.stdout?.on("data", (chunk) => {
			out += String(chunk);
		});
		return new Promise((resolve) => child.on("close", (code) => resolve({ code, out })));
	}

	it("prints OK and exits 0 for a genuine receipt, and FAIL with the reason and exits 1 otherwise", async () => {
		const ok = await cli(join(dir, "lease.txt.tlog-proof"), join(dir, "lease.txt"), notaryKey.vkey);
		expect(ok.code, ok.out).toBe(0);
		expect(ok.out).toMatch(/^OK: .*lease\.txt is entry 0 of the notary's log/);

		const forged = await cli(join(dir, "forged.tlog-proof"), join(dir, "lease.txt"), notaryKey.vkey);
		expect(forged.code).toBe(1);
		expect(forged.out).toMatch(/^FAIL \(receipt\): inclusion: /);
	});
});
