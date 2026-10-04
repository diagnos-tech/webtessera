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

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	coSigV1Timestamp,
	ErrInvalidProof,
	ErrMalformedRequest,
	ErrNoValidSignature,
	ErrOldSizeMismatch,
	ErrRootMismatch,
	ErrUnknownLog,
	type InconsistencyEvidence,
	marshalAddCheckpointRequest,
	newSignerForCosignatureV1,
	newVerifierForCosignatureV1,
	newWitnessServer,
	OldSizeMismatchError,
	originHash,
	vKeyToCosignatureV1,
	type WitnessServer,
	type WitnessServerOptions,
} from "webtessera/witness";
import { newProofBuilder } from "../client/index.ts";
import { entriesOf, newTestLog, type TestLog } from "../http/testing/testlog.ts";
import { concatBytes, toBase64 } from "../internal/gostd/bytes.ts";
import { errorIs } from "../internal/gostd/errors.ts";
import { MemoryObjectStore } from "../storage/memory/memory.ts";
import type { ObjectStore } from "../storage/objectstore/objectstore.ts";
import { DefaultHasher } from "../vendor/merkle/rfc6962/rfc6962.ts";
import { generateKey, newSigner, open, type Signer, sign, type Verifier, verifierList } from "../vendor/note/note.ts";

const origin = "example.com/witnessed-log";
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

// The log, at two sizes, with the consistency proof between them.
let log: TestLog;
let cp5: Uint8Array;
let cp15: Uint8Array;
let proof5to15: Uint8Array[];
// A fork: the same key and origin, a different tree of size 15.
let forkCp15: Uint8Array;

const witnessKey = generateKey(undefined, "witness.example/w1");
const witnessSigner = newSignerForCosignatureV1(witnessKey.skey);
const witnessVerifier = newVerifierForCosignatureV1(vKeyToCosignatureV1(witnessKey.vkey));

beforeAll(async () => {
	log = await newTestLog({ origin });
	await log.add(entriesOf(5));
	cp5 = await log.reader.readCheckpoint();
	await log.add(entriesOf(10, 5));
	cp15 = await log.reader.readCheckpoint();
	const pb = await newProofBuilder(15n, (l, i, p, s) => log.reader.readTile(l, i, p, s));
	proof5to15 = await pb.consistencyProof(5n, 15n);

	const fork = await newTestLog({ origin, keys: { skey: log.skey, vkey: log.vkey } });
	await fork.add(entriesOf(15, 1000));
	forkCp15 = await fork.reader.readCheckpoint();
	await fork.shutdown();
});

afterAll(async () => {
	await log.shutdown();
});

afterEach(() => {
	vi.useRealTimers();
});

function newTestWitness(overrides: Partial<WitnessServerOptions> = {}): WitnessServer {
	return newWitnessServer({
		signer: witnessSigner,
		store: new MemoryObjectStore(),
		logs: [{ origin, verifierKeys: [log.vkey] }],
		...overrides,
	});
}

async function refusalOf(p: Promise<unknown>): Promise<unknown> {
	try {
		await p;
	} catch (err) {
		return err;
	}
	throw new Error("expected a refusal");
}

function post(w: WitnessServer, body: Uint8Array | string, path = "/add-checkpoint"): Promise<Response | undefined> {
	return w.handle(new Request(`https://witness.example${path}`, { method: "POST", body: body as BodyInit }));
}

function signText(text: string, signer: Signer = log.signer): Uint8Array {
	return sign({ text }, signer);
}

describe("WitnessServer.addCheckpoint", () => {
	it("cosigns the first checkpoint it sees for a log, from old size 0", async () => {
		const w = newTestWitness();
		const sigs = await w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: cp5 });

		// The response is signature lines that verify as a cosignature/v1 over the checkpoint.
		expect(dec(sigs)).toMatch(/^— witness\.example\/w1 [A-Za-z0-9+/]+=*\n$/);
		const n = open(concatBytes(cp5, sigs), verifierList(witnessVerifier));
		const sig = n.sigs?.[0];
		expect(sig?.name).toBe("witness.example/w1");
		const now = BigInt(Math.floor(Date.now() / 1000));
		const ts = coSigV1Timestamp(sig as NonNullable<typeof sig>);
		expect(ts > now - 5n && ts <= now).toBe(true);

		// The stored checkpoint carries the log's signature and the witness's.
		const stored = await w.latestCheckpoint(origin);
		expect(stored).toBeDefined();
		const both = open(stored as Uint8Array, verifierList(log.verifier, witnessVerifier));
		expect(both.sigs?.map((s) => s.name).sort()).toEqual([origin, "witness.example/w1"].sort());
	});

	it("advances with a valid consistency proof and refuses to go back", async () => {
		const w = newTestWitness();
		await w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: cp5 });
		await w.addCheckpoint({ oldSize: 5n, proof: proof5to15, checkpoint: cp15 });
		expect(dec((await w.latestCheckpoint(origin)) as Uint8Array)).toContain("\n15\n");

		// Stale old size: 409, saying where to retry from.
		const stale = await refusalOf(w.addCheckpoint({ oldSize: 5n, proof: proof5to15, checkpoint: cp15 }));
		expect(stale).toBeInstanceOf(OldSizeMismatchError);
		expect((stale as OldSizeMismatchError).latestSize).toBe(15n);
		expect(errorIs(stale, ErrOldSizeMismatch)).toBe(true);

		// Rolling back: an old size above the checkpoint's is malformed, and a matching one stale.
		expect(
			errorIs(await refusalOf(w.addCheckpoint({ oldSize: 15n, proof: [], checkpoint: cp5 })), ErrMalformedRequest),
		).toBe(true);
		const back = await refusalOf(w.addCheckpoint({ oldSize: 5n, proof: [], checkpoint: cp5 }));
		expect((back as OldSizeMismatchError).latestSize).toBe(15n);
		const fromZero = await refusalOf(w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: cp15 }));
		expect((fromZero as OldSizeMismatchError).latestSize).toBe(15n);
	});

	it("re-cosigns the latest checkpoint with an empty proof, for freshness", async () => {
		const w = newTestWitness();
		await w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: cp15 });
		await expect(w.addCheckpoint({ oldSize: 15n, proof: [], checkpoint: cp15 })).resolves.toBeDefined();
		const err = await refusalOf(w.addCheckpoint({ oldSize: 15n, proof: proof5to15, checkpoint: cp15 }));
		expect(errorIs(err, ErrInvalidProof)).toBe(true);
	});

	it("refuses a proof that does not verify, and reports it as evidence", async () => {
		const evidence: InconsistencyEvidence[] = [];
		const w = newTestWitness({ onInconsistency: (e) => void evidence.push(e) });
		await w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: cp5 });
		const tampered = proof5to15.map((p, i) => (i === 0 ? DefaultHasher.hashLeaf(p) : p));
		const err = await refusalOf(w.addCheckpoint({ oldSize: 5n, proof: tampered, checkpoint: cp15 }));
		expect(errorIs(err, ErrInvalidProof)).toBe(true);
		expect(evidence).toHaveLength(1);
		expect(evidence[0]?.reason).toBe("invalid-proof");
		expect(evidence[0]?.submitted).toEqual(cp15);
		// Nothing changed.
		expect(dec((await w.latestCheckpoint(origin)) as Uint8Array)).toContain("\n5\n");
	});

	it("refuses a different tree of the same size as a root mismatch, and reports it as evidence", async () => {
		const evidence: InconsistencyEvidence[] = [];
		const w = newTestWitness({ onInconsistency: (e) => void evidence.push(e) });
		await w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: cp15 });
		const err = await refusalOf(w.addCheckpoint({ oldSize: 15n, proof: [], checkpoint: forkCp15 }));
		expect(errorIs(err, ErrRootMismatch)).toBe(true);
		expect(evidence.map((e) => e.reason)).toEqual(["root-mismatch"]);
		expect(evidence[0]?.latest).toEqual(await w.latestCheckpoint(origin));
	});

	it("refuses a non-empty proof from old size 0", async () => {
		const w = newTestWitness();
		const err = await refusalOf(w.addCheckpoint({ oldSize: 0n, proof: proof5to15, checkpoint: cp15 }));
		expect(errorIs(err, ErrInvalidProof)).toBe(true);
	});

	it("insists that a checkpoint of size zero has the empty tree's root", async () => {
		const w = newTestWitness();
		const bogus = signText(`${origin}\n0\n${toBase64(new Uint8Array(32))}\n`);
		expect(
			errorIs(await refusalOf(w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: bogus })), ErrInvalidProof),
		).toBe(true);
		const empty = signText(`${origin}\n0\n${toBase64(DefaultHasher.emptyRoot())}\n`);
		await expect(w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: empty })).resolves.toBeDefined();
		// And it then accepts any tree from size 0, without a proof.
		await expect(w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: cp5 })).resolves.toBeDefined();
	});

	it("refuses unknown origins, untrusted signatures and malformed checkpoints", async () => {
		const w = newTestWitness();
		const other = newSigner(generateKey(undefined, origin).skey);
		const cases: [Uint8Array, unknown][] = [
			[signText("example.com/unknown\n1\nAA==\n"), ErrUnknownLog],
			// Signed by a key with the log's name but not the log's key.
			[signText(dec(cp5).split("\n\n")[0] + "\n", other), ErrNoValidSignature],
			// The log's signature, over different text.
			[enc(dec(cp5).replace("\n5\n", "\n6\n")), ErrNoValidSignature],
			[enc(`${origin}\n5\n`), ErrMalformedRequest],
			[enc("no newline at all"), ErrMalformedRequest],
			// Validly signed, but not a checkpoint.
			[signText(`${origin}\nfive\n`), ErrMalformedRequest],
		];
		for (const [checkpoint, want] of cases) {
			const err = await refusalOf(w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint }));
			expect(errorIs(err, want), `${dec(checkpoint)}: ${String(err)}`).toBe(true);
		}
	});

	it("ignores signatures from unknown keys on an otherwise valid checkpoint", async () => {
		const w = newTestWitness();
		const extra = newSigner(generateKey(undefined, "someone.else").skey);
		const n = open(cp5, verifierList(log.verifier));
		const withExtra = sign(n, extra);
		await expect(w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: withExtra })).resolves.toBeDefined();
		// The stored checkpoint keeps only the verified log signature and the witness's own.
		const stored = dec((await w.latestCheckpoint(origin)) as Uint8Array);
		expect(stored).not.toContain("someone.else");
	});

	it("asks lookupLog about origins it is not configured with, on every request", async () => {
		const lookupLog = vi.fn(async (o: string) => (o === origin ? { verifierKeys: [log.vkey] } : undefined));
		const w = newTestWitness({ logs: [], lookupLog });
		await w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: cp5 });
		await w.addCheckpoint({ oldSize: 5n, proof: proof5to15, checkpoint: cp15 });
		expect(lookupLog).toHaveBeenCalledTimes(2);
		expect(lookupLog.mock.calls[0]?.[0]).toBe(origin);
		const err = await refusalOf(
			w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: signText("other.example\n1\nAA==\n") }),
		);
		expect(errorIs(err, ErrUnknownLog)).toBe(true);
	});

	it("cosigns with every configured signer", async () => {
		const second = newSignerForCosignatureV1(generateKey(undefined, "witness.example/w2").skey);
		const w = newTestWitness({ additionalSigners: [second] });
		const sigs = dec(await w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: cp5 }));
		expect(sigs.split("\n").filter((l) => l !== "")).toHaveLength(2);
		expect(sigs).toContain("— witness.example/w2 ");
	});

	it("serialises concurrent requests, so that none can roll the log back", async () => {
		// A store whose every operation yields to the event loop, so that unserialised
		// requests would interleave between reading the latest checkpoint and writing theirs.
		const inner = new MemoryObjectStore();
		const slow: ObjectStore = {
			get: async (k) => {
				await tick();
				return inner.get(k);
			},
			stat: (k) => inner.stat(k),
			put: async (k, d) => {
				await tick();
				await inner.put(k, d);
			},
			create: (k, d) => inner.create(k, d),
			deletePrefix: (p) => inner.deletePrefix(p),
			lock: (n, fn, s) => inner.lock(n, fn, s),
		};
		const w = newTestWitness({ store: slow });
		const results = await Promise.allSettled([
			w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: cp15 }),
			w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: cp5 }),
		]);
		expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
		expect(dec((await w.latestCheckpoint(origin)) as Uint8Array)).toContain("\n15\n");
	});

	it("refuses to cosign with a timestamp older than its last cosignature for the log", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const w = newTestWitness();
		vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
		await w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: cp5 });
		const before = await w.latestCheckpoint(origin);

		vi.setSystemTime(new Date("2029-12-31T23:59:00Z"));
		await expect(w.addCheckpoint({ oldSize: 5n, proof: proof5to15, checkpoint: cp15 })).rejects.toThrow(
			/witness clock is behind its latest cosignature/,
		);
		expect(await w.latestCheckpoint(origin)).toEqual(before);

		vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
		await expect(w.addCheckpoint({ oldSize: 5n, proof: proof5to15, checkpoint: cp15 })).resolves.toBeDefined();
	});

	it("enforces its limits on programmatic callers too", async () => {
		const w = newTestWitness({ maxBodyBytes: 1024 });
		const short = proof5to15.map((p, i) => (i === 0 ? p.subarray(1) : p));
		await w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: cp5 });
		expect(
			errorIs(await refusalOf(w.addCheckpoint({ oldSize: 5n, proof: short, checkpoint: cp15 })), ErrMalformedRequest),
		).toBe(true);
		const huge = signText(`${origin}\n15\n${toBase64(new Uint8Array(32))}\n${"x".repeat(2000)}\n`);
		expect(
			errorIs(await refusalOf(w.addCheckpoint({ oldSize: 5n, proof: [], checkpoint: huge })), ErrMalformedRequest),
		).toBe(true);
	});

	it("parses the signed checkpoint strictly", async () => {
		const w = newTestWitness();
		for (const text of [
			`${origin}\n05\n${toBase64(new Uint8Array(32))}\n`,
			`${origin}\n${"9".repeat(21)}\n${toBase64(new Uint8Array(32))}\n`,
			`${origin}\n5\n${toBase64(new Uint8Array(16))}\n`,
			`${origin}\n5\n${toBase64(new Uint8Array(32)).slice(0, -2)}B=\n`,
		]) {
			const err = await refusalOf(w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: signText(text) }));
			expect(errorIs(err, ErrMalformedRequest), `${text}: ${String(err)}`).toBe(true);
		}
	});

	it("refuses to witness a log that signs with the witness's own key", async () => {
		const shared = generateKey(undefined, origin);
		const signer = newSignerForCosignatureV1(shared.skey);
		expect(() => newTestWitness({ signer, logs: [{ origin, verifierKeys: [shared.vkey] }] })).toThrow(
			/signed with one of the witness's own keys/,
		);
		expect(() =>
			newTestWitness({ additionalSigners: [signer], logs: [{ origin, verifierKeys: [shared.vkey] }] }),
		).toThrow(/witness's own keys/);
		const w = newTestWitness({ signer, logs: [], lookupLog: () => ({ verifierKeys: [shared.vkey] }) });
		const cp = sign({ text: `${origin}\n0\n${toBase64(DefaultHasher.emptyRoot())}\n` }, newSigner(shared.skey));
		const err = await refusalOf(w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: cp }));
		expect(errorIs(err, ErrUnknownLog)).toBe(true);
	});

	it("refuses to build on a stored cosignature whose timestamp is out of range", async () => {
		const store = new MemoryObjectStore();
		const w = newTestWitness({ store });
		await w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: cp5 });
		const stored = dec((await w.latestCheckpoint(origin)) as Uint8Array);
		// Replace the witness's signature with one whose timestamp field is 2^64-1, which
		// reads as -1 seconds.
		const raw = new Uint8Array(4 + 8 + 64);
		const view = new DataView(raw.buffer);
		view.setUint32(0, witnessSigner.keyHash());
		view.setBigUint64(4, 2n ** 64n - 1n);
		const forged = stored.replace(/— witness\.example\/w1 \S+\n/, `— witness.example/w1 ${toBase64(raw)}\n`);
		await store.put(`${originHash(origin)}/checkpoint`, enc(forged));
		await expect(w.addCheckpoint({ oldSize: 5n, proof: proof5to15, checkpoint: cp15 })).rejects.toThrow(
			/stored cosignature .* has invalid timestamp -1/,
		);
	});

	it("rejects configurations it cannot honour", () => {
		expect(() =>
			newTestWitness({
				logs: [
					{ origin, verifierKeys: [log.vkey] },
					{ origin, verifierKeys: [log.vkey] },
				],
			}),
		).toThrow(/configured twice/);
		expect(() => newTestWitness({ logs: [{ origin }] })).toThrow(/no verifier keys/);
		expect(() => newTestWitness({ logs: [{ origin, verifierKeys: ["garbage"] }] })).toThrow();
		for (const maxBodyBytes of [Number.NaN, Number(undefined), -1, 0, 1.5, Number.POSITIVE_INFINITY]) {
			expect(() => newTestWitness({ maxBodyBytes }), String(maxBodyBytes)).toThrow(RangeError);
		}
	});

	it("insists that every signer makes cosignature/v1 signatures", () => {
		const plain = newSigner(witnessKey.skey);
		expect(() => newTestWitness({ signer: plain })).toThrow(/does not make cosignature\/v1 signatures/);
		expect(() => newTestWitness({ additionalSigners: [plain] })).toThrow(/cosignature\/v1/);
		// The right shape is not enough when the signer's own verifier disagrees.
		const other = newSignerForCosignatureV1(generateKey(undefined, "witness.example/w1").skey);
		const mismatched: Signer & { verifier(): Verifier } = {
			name: () => witnessSigner.name(),
			keyHash: () => witnessSigner.keyHash(),
			sign: (m) => other.sign(m),
			verifier: () => witnessSigner.verifier(),
		};
		expect(() => newTestWitness({ signer: mismatched })).toThrow(/its own verifier does not accept/);
		const untimed: Signer = {
			...plainSignerShape(witnessSigner),
			sign: (m) => withTimestamp(witnessSigner.sign(m), 0n),
		};
		expect(() => newTestWitness({ signer: untimed })).toThrow(/no valid timestamp/);
		expect(() => newTestWitness({ signer: witnessSigner, additionalSigners: [other] })).not.toThrow();
	});

	it("checks each key lookupLog returns against its own keys once, however many requests use it", async () => {
		const probes = vi.fn();
		const counted: Verifier = {
			name: () => log.verifier.name(),
			keyHash: () => log.verifier.keyHash(),
			verify: (msg, sig) => {
				if (dec(msg).includes("key separation probe")) {
					probes();
				}
				return log.verifier.verify(msg, sig);
			},
		};
		const w = newTestWitness({ logs: [], lookupLog: () => ({ verifiers: [counted] }) });
		await w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: cp5 });
		const after = probes.mock.calls.length;
		expect(after).toBeGreaterThan(0);
		await w.addCheckpoint({ oldSize: 5n, proof: proof5to15, checkpoint: cp15 });
		await w.addCheckpoint({ oldSize: 15n, proof: [], checkpoint: cp15 });
		expect(probes.mock.calls.length).toBe(after);

		// A key that is the witness's own stays refused.
		const shared = generateKey(undefined, origin);
		const sharing = newTestWitness({
			signer: newSignerForCosignatureV1(shared.skey),
			logs: [],
			lookupLog: () => ({ verifierKeys: [shared.vkey] }),
		});
		const cp = sign({ text: `${origin}\n0\n${toBase64(DefaultHasher.emptyRoot())}\n` }, newSigner(shared.skey));
		for (let i = 0; i < 2; i++) {
			expect(
				errorIs(await refusalOf(sharing.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: cp })), ErrUnknownLog),
			).toBe(true);
		}
	});
});

/** plainSignerShape returns s's name and key hash, as the parts of a Signer that a test keeps. */
function plainSignerShape(s: Signer): Pick<Signer, "name" | "keyHash"> {
	return { name: () => s.name(), keyHash: () => s.keyHash() };
}

/** withTimestamp returns a cosignature/v1 signature with its timestamp replaced by t. */
function withTimestamp(sig: Uint8Array, t: bigint): Uint8Array {
	const out = new Uint8Array(sig);
	new DataView(out.buffer).setBigUint64(0, t);
	return out;
}

describe("WitnessServer.handle", () => {
	it("answers add-checkpoint with 200 and signature lines", async () => {
		const w = newTestWitness();
		const r = await post(w, marshalAddCheckpointRequest({ oldSize: 0n, proof: [], checkpoint: cp5 }));
		expect(r?.status).toBe(200);
		const sigs = new Uint8Array(await (r as Response).arrayBuffer());
		expect(() => open(concatBytes(cp5, sigs), verifierList(witnessVerifier))).not.toThrow();
	});

	it("answers a stale old size with 409 and the latest size as text/x.tlog.size", async () => {
		const w = newTestWitness();
		await w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: cp5 });
		const r = await post(w, marshalAddCheckpointRequest({ oldSize: 0n, proof: [], checkpoint: cp15 }));
		expect(r?.status).toBe(409);
		expect(r?.headers.get("Content-Type")).toBe("text/x.tlog.size");
		expect(await r?.text()).toBe("5\n");
	});

	it("maps every refusal onto the status the spec assigns", async () => {
		const w = newTestWitness();
		await w.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: cp15 });
		const cases: [string | Uint8Array, number][] = [
			["old 1\n", 400],
			[marshalAddCheckpointRequest({ oldSize: 16n, proof: [], checkpoint: cp15 }), 400],
			[marshalAddCheckpointRequest({ oldSize: 0n, proof: [], checkpoint: signText("nobody.example\n1\nAA==\n") }), 404],
			[
				marshalAddCheckpointRequest({
					oldSize: 15n,
					proof: [],
					checkpoint: signText(`${origin}\n15\nAA==\n`, newSigner(generateKey(undefined, origin).skey)),
				}),
				403,
			],
			[marshalAddCheckpointRequest({ oldSize: 15n, proof: [], checkpoint: forkCp15 }), 409],
			[marshalAddCheckpointRequest({ oldSize: 15n, proof: proof5to15, checkpoint: cp15 }), 422],
		];
		for (const [body, status] of cases) {
			const r = await post(w, body);
			expect(r?.status, typeof body === "string" ? body : dec(body)).toBe(status);
			if (status === 409) {
				expect(r?.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
			}
		}
	});

	it("bounds how much of the request a refusal echoes", async () => {
		const w = newTestWitness();
		const longOrigin = "o".repeat(10000);
		const r = await post(
			w,
			marshalAddCheckpointRequest({ oldSize: 0n, proof: [], checkpoint: signText(`${longOrigin}\n1\nAA==\n`) }),
		);
		expect(r?.status).toBe(404);
		expect((await r?.text())?.length).toBeLessThan(200);
		const bad = await post(w, `old ${"1".repeat(5000)}\n\n${dec(cp5)}`);
		expect(bad?.status).toBe(400);
		expect((await bad?.text())?.length).toBeLessThan(200);
	});

	it("answers 405 to anything but POST, and 413 to an oversized body", async () => {
		const w = newTestWitness({ maxBodyBytes: 100 });
		const get = await w.handle(new Request("https://witness.example/add-checkpoint"));
		expect(get?.status).toBe(405);
		expect(get?.headers.get("Allow")).toBe("POST");
		expect((await post(w, "x".repeat(101)))?.status).toBe(413);
	});

	it("answers 500 and reports failures of the witness itself", async () => {
		const onError = vi.fn();
		const broken = new MemoryObjectStore();
		broken.put = () => Promise.reject(new Error("disk full"));
		const w = newTestWitness({ store: broken, onError });
		const r = await post(w, marshalAddCheckpointRequest({ oldSize: 0n, proof: [], checkpoint: cp5 }));
		expect(r?.status).toBe(500);
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it("serves the latest cosigned checkpoint at the monitoring endpoint", async () => {
		const w = newTestWitness({ prefix: "/w" });
		const url = `https://witness.example/w/${originHash(origin)}/checkpoint`;
		expect((await w.handle(new Request(url)))?.status).toBe(404);
		await post(w, marshalAddCheckpointRequest({ oldSize: 0n, proof: [], checkpoint: cp5 }), "/w/add-checkpoint");
		const r = await w.handle(new Request(url));
		expect(r?.status).toBe(200);
		expect(r?.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
		expect(new Uint8Array(await (r as Response).arrayBuffer())).toEqual(await w.latestCheckpoint(origin));
		const head = await w.handle(new Request(url, { method: "HEAD" }));
		expect(head?.status).toBe(200);
		expect(head?.body).toBeNull();
		expect((await w.handle(new Request(url, { method: "DELETE" })))?.status).toBe(405);
	});

	it("answers scripts on other origins only when CORS is on, refusals included", async () => {
		const off = newTestWitness();
		const plain = await post(off, marshalAddCheckpointRequest({ oldSize: 0n, proof: [], checkpoint: cp5 }));
		expect(plain?.headers.get("Access-Control-Allow-Origin")).toBeNull();
		expect(
			(await off.handle(new Request("https://witness.example/add-checkpoint", { method: "OPTIONS" })))?.status,
		).toBe(405);

		const w = newTestWitness({ cors: true });
		const ok = await post(w, marshalAddCheckpointRequest({ oldSize: 0n, proof: [], checkpoint: cp5 }));
		expect(ok?.status).toBe(200);
		expect(ok?.headers.get("Access-Control-Allow-Origin")).toBe("*");
		const conflict = await post(w, marshalAddCheckpointRequest({ oldSize: 0n, proof: [], checkpoint: cp15 }));
		expect(conflict?.status).toBe(409);
		expect(conflict?.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(conflict?.headers.get("Content-Type")).toBe("text/x.tlog.size");
		const pre = await w.handle(
			new Request("https://witness.example/add-checkpoint", {
				method: "OPTIONS",
				headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
			}),
		);
		expect(pre?.status).toBe(204);
		expect(pre?.headers.get("Access-Control-Allow-Methods")).toBe("POST");
		expect(pre?.headers.get("Access-Control-Allow-Headers")).toBe("content-type");
		const mon = await w.handle(new Request(`https://witness.example/${originHash(origin)}/checkpoint`));
		expect(mon?.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("never reads request.signal, whose first read prints a warning on Deno 2", async () => {
		const unread = (url: string, init?: RequestInit): Request => {
			const r = new Request(url, init);
			Object.defineProperty(r, "signal", {
				get: () => {
					throw new Error("the handler read request.signal");
				},
			});
			return r;
		};
		const add = (oldSize: bigint, checkpoint: Uint8Array): Request =>
			unread("https://witness.example/add-checkpoint", {
				method: "POST",
				body: marshalAddCheckpointRequest({ oldSize, proof: [], checkpoint }) as BodyInit,
			});
		const w = newTestWitness();
		expect((await w.handle(add(0n, cp5)))?.status).toBe(200);
		expect((await w.handle(add(0n, cp15)))?.status).toBe(409);
		expect(
			(await w.handle(unread("https://witness.example/add-checkpoint", { method: "POST", body: "x" })))?.status,
		).toBe(400);
		expect((await w.handle(unread(`https://witness.example/${originHash(origin)}/checkpoint`)))?.status).toBe(200);

		// A failure of the witness itself is reported whether or not the client is still there.
		const onError = vi.fn();
		const broken = new MemoryObjectStore();
		broken.put = () => Promise.reject(new Error("disk full"));
		expect((await newTestWitness({ store: broken, onError }).handle(add(0n, cp5)))?.status).toBe(500);
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it("leaves other paths to other handlers", async () => {
		const w = newTestWitness({ prefix: "/w", monitoringPrefix: "/monitor" });
		for (const p of [
			"/add-checkpoint",
			"/w/add-checkpoint/",
			"/w/checkpoint",
			`/w/${originHash(origin)}/checkpoint`,
			"/monitor/abc/checkpoint",
		]) {
			expect(await w.handle(new Request(`https://witness.example${p}`)), p).toBeUndefined();
		}
		expect(
			(await w.handle(new Request(`https://witness.example/monitor/${originHash(origin)}/checkpoint`)))?.status,
		).toBe(404);
		const off = newTestWitness({ monitoringPrefix: false });
		expect(await off.handle(new Request(`https://witness.example/${originHash(origin)}/checkpoint`))).toBeUndefined();
	});
});

function tick(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}
