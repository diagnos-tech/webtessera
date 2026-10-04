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
// The whole flow, end to end, in one process: browser sessions record their exchanges with the
// server, the server witnesses and commits their logs, and an auditor checks the commits. Most
// of the file is the guardrails: neither the browser nor the server can rewrite what both
// signed, and nothing unverified is ever committed.

import { describe, expect, it } from "vitest";
import { generateLogKey, openBrowserLog, verifyReceipt } from "webtessera/browser";
import { newProofBuilder } from "webtessera/client";
import { newSinkTarget, S3Sink } from "webtessera/mirror";
import { generateKey } from "webtessera/note";
import { MemoryObjectStore } from "webtessera/storage/memory";
import { marshalAddCheckpointRequest, originHash } from "webtessera/witness";
import { auditSession } from "../audit/audit.ts";
import { pushLog } from "../client/src/push.ts";
import { recordedFetch } from "../client/src/recorder.ts";
import { openSession, type Session, witnessPolicy } from "../client/src/session.ts";
import { committedPrefix } from "../server/committer.ts";
import { chooseSink } from "../server/sink.ts";
import { encodeInteraction } from "../shared/interaction.ts";
import { Routes } from "../shared/protocol.ts";
import { type Harness, newHarness } from "./harness.ts";

const enc = new TextEncoder();

function fail(): never {
	throw new Error("unreachable");
}

/** audit audits a session's committed copy in the harness's sink. */
function audit(h: Harness, s: Session) {
	return auditSession({
		log: newSinkTarget(h.sink, {
			prefix: committedPrefix({ origin: s.origin, vkey: s.log.vkey, hash: originHash(s.origin) }),
		}),
		origin: s.origin,
		vkey: s.log.vkey,
		witness: h.witnessVkey,
	});
}

describe("session receipts", () => {
	it("records each exchange in the browser's log, with receipts the server cosigned", async () => {
		const h = newHarness();
		const s = await h.newSession();
		const saved = await recordedFetch(s, `${Routes.notes}todo`, { method: "PUT", body: "buy milk" });
		const read = await recordedFetch(s, `${Routes.notes}todo`, { method: "GET" });
		expect([saved.status, read.status, read.body]).toEqual([200, 200, "buy milk\n"]);

		for (const r of [saved, read]) {
			// Anyone holding the two public keys can check it, offline: the device signed the
			// checkpoint, the server cosigned it, and the record is in the tree.
			const v = verifyReceipt(r.receipt.text, {
				vkey: s.log.vkey,
				data: encodeInteraction(r.interaction),
				witnesses: witnessPolicy(s),
			});
			expect(v.cosignedBy).toEqual(["witness.test/w1"]);
		}
		await s.log.close();
	});

	it("refuses to witness a browser log that was wiped and started over", async () => {
		const h = newHarness();
		const s = await h.newSession();
		await recordedFetch(s, `${Routes.notes}a`, { method: "PUT", body: "1" });
		await recordedFetch(s, `${Routes.notes}b`, { method: "PUT", body: "2" });
		await s.log.close();

		// Same session, same device key, empty log: it cannot even publish its first checkpoint,
		// because the server cosigned a larger tree for this origin, and the error says so.
		await expect(
			openSession(s, { server: h.url, key: s.key, storage: { memory: true }, fetch: h.fetch }),
		).rejects.toThrow(
			/this storage holds an older or different log than its witnesses cosigned: the witness at .* has cosigned this log at size 2, and the storage holds no entries/,
		);
	});

	it("refuses a rewritten history, of the same size or larger, and keeps the evidence", async () => {
		const h = newHarness();
		const s = await h.newSession();
		await recordedFetch(s, `${Routes.notes}a`, { method: "PUT", body: "the truth" });
		await recordedFetch(s, `${Routes.notes}b`, { method: "PUT", body: "more truth" });
		await s.log.close();

		// The browser holds its key, so it can sign any history it likes, just not get it cosigned.
		const forged = await openBrowserLog({ key: s.key, storage: { memory: true } });
		for (const entry of ["a different first", "a different second", "and a third"]) {
			await forged.append(enc.encode(entry));
		}
		const checkpoint = (await forged.latestCheckpoint()).signed;
		const proofs = await newProofBuilder(3n, (l, i, p, sig) => forged.reader.readTile(l, i, p, sig));
		const submit = async (oldSize: bigint, proof: Uint8Array[]) =>
			(
				await h.fetch(new URL(`${Routes.witness}add-checkpoint`, h.url).href, {
					method: "POST",
					body: marshalAddCheckpointRequest({ oldSize, proof, checkpoint }).slice(),
				})
			).status;

		// The forged tree of 3 does not contain the cosigned tree of 2: 422, and evidence.
		expect(await submit(2n, await proofs.consistencyProof(2n, 3n))).toBe(422);
		expect(h.evidence.map((e) => e.reason)).toEqual(["invalid-proof"]);
		await forged.close();
	});

	it("commits exactly what it witnessed, and an auditor verifies the commit", async () => {
		const h = newHarness();
		const s = await h.newSession();
		await recordedFetch(s, `${Routes.notes}x`, { method: "PUT", body: "one" });
		await recordedFetch(s, `${Routes.notes}x`, { method: "GET" });
		expect(await pushLog(s)).toBe(2n);

		await recordedFetch(s, `${Routes.notes}x`, { method: "DELETE" });
		expect(await pushLog(s)).toBe(3n);
		expect(await pushLog(s)).toBe(3n);

		const { size, interactions } = await audit(h, s);
		expect(size).toBe(3n);
		expect(interactions.map((i) => `${i.method} ${i.path} ${i.status}`)).toEqual([
			"PUT /api/notes/x 200",
			"GET /api/notes/x 200",
			"DELETE /api/notes/x 200",
		]);
		await s.log.close();
	});

	it("commits nothing it cannot verify", async () => {
		const h = newHarness();
		const s = await h.newSession();
		await recordedFetch(s, `${Routes.notes}x`, { method: "PUT", body: "one" });
		expect(await pushLog(s)).toBe(1n);
		await recordedFetch(s, `${Routes.notes}x`, { method: "PUT", body: "two" });

		// An upload whose entry bundle was altered on the way: the server refuses to commit it.
		const tampering: Session = {
			...s,
			fetch: (input, init) =>
				input.includes("/tile/entries/") && init?.method === "PUT"
					? h.fetch(input, { ...init, body: enc.encode("\u0000\u0005forged") })
					: h.fetch(input, init),
		};
		await expect(pushLog(tampering)).rejects.toThrow(/not committed/);
		expect((await audit(h, s)).size).toBe(1n);

		// The honest upload then commits as usual.
		expect(await pushLog(s)).toBe(2n);
		await s.log.close();
	});

	it("lets an auditor catch a committed copy the server altered or re-signed", async () => {
		const sink = new MemoryObjectStore();
		const h = newHarness(sink);
		const s = await h.newSession();
		await recordedFetch(s, `${Routes.notes}x`, { method: "PUT", body: "one" });
		await pushLog(s);
		await s.log.close();
		const prefix = committedPrefix({ origin: s.origin, vkey: s.log.vkey, hash: originHash(s.origin) });

		const bundle = (await sink.get(`${prefix}tile/entries/000.p/1`)) ?? new Uint8Array(0);
		const altered = bundle.slice();
		altered.set([(altered.at(-1) ?? 0) ^ 1], altered.length - 1);
		await sink.put(`${prefix}tile/entries/000.p/1`, altered);
		await expect(audit(h, s)).rejects.toThrow();
		await sink.put(`${prefix}tile/entries/000.p/1`, bundle);
		const committed = await audit(h, s);
		expect(committed.size).toBe(1n);

		// The server saw every entry, so it can rebuild the identical tree under a key of its own
		// with the session's origin. The checkpoint is still not the device's, and the audit says so.
		const impostor = await openBrowserLog({ key: await generateLogKey(s.origin), storage: { memory: true } });
		await impostor.append(encodeInteraction(committed.interactions[0] ?? fail()));
		await sink.put(`${prefix}checkpoint`, (await impostor.latestCheckpoint()).signed);
		await impostor.close();
		await expect(audit(h, s)).rejects.toThrow(/signature|verif/i);
	});

	it("refuses uploads, application calls and registrations it should not accept", async () => {
		const h = newHarness();
		const s = await h.newSession();
		const upload = new URL(`${s.uploads}tile/0/000.p/1`, h.url).href;
		expect((await h.fetch(upload, { method: "PUT", body: "x" })).status).toBe(401);
		expect(
			(await h.fetch(upload, { method: "PUT", body: "x", headers: { Authorization: `Bearer ${"0".repeat(64)}` } }))
				.status,
		).toBe(401);
		const notes = new URL(`${Routes.notes}x`, h.url).href;
		expect((await h.fetch(notes, { headers: { Authorization: `Bearer ${s.token}` } })).status).toBe(401);

		const register = (body: unknown) =>
			h.fetch(new URL(Routes.register, h.url).href, { method: "POST", body: JSON.stringify(body) });
		expect((await register({ origin: s.origin, vkey: s.log.vkey })).status).toBe(409);
		const other = generateKey(undefined, "elsewhere.example/session/0123456789abcdef0123456789abcdef");
		expect((await register({ origin: s.origin, vkey: other.vkey })).status).toBe(400);
		expect((await register({ origin: "not a session origin", vkey: s.log.vkey })).status).toBe(400);
		await s.log.close();
	});
});

describe("commit sink", () => {
	it("is an S3 bucket only when every S3_* variable is set, and refuses half a configuration", () => {
		const fallback = new MemoryObjectStore();
		expect(chooseSink({}, fallback).sink).toBe(fallback);
		const all = {
			S3_ENDPOINT: "http://127.0.0.1:9000",
			S3_BUCKET: "receipts",
			S3_REGION: "us-east-1",
			S3_ACCESS_KEY_ID: "id",
			S3_SECRET_ACCESS_KEY: "secret",
		};
		expect(chooseSink(all, fallback).sink).toBeInstanceOf(S3Sink);
		expect(() => chooseSink({ ...all, S3_BUCKET: "" }, fallback)).toThrow(/missing S3_BUCKET/);
	});
});
