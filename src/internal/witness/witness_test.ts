// Copyright 2025 Google LLC. All Rights Reserved.
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
//
// Ported from tessera/internal/witness/witness_test.go @ 4a6d9f9
//
// Port note: upstream reads its test log (and, for TestWitness_UpdateRequest, a real
// tessera.NewAppender/posix.Driver reader) from the static, checked-in "../../testdata/log"
// directory -- the exact same log src/client/client_test.ts already reads back via the
// client_log fixture (docs/decisions/0065-client-log-fixture-reads-static-testdata.md).
// This file serves that fixture's tiles instead of opening the directory with a storage
// driver: the reader would serve the identical bytes for the identical 15-entry log, and
// no driver in this port reads a POSIX directory. See
// docs/decisions/0193-witness-test-reads-the-client-log-fixture.md.

import { beforeAll, describe, expect, it } from "vitest";
import { tilePath } from "../../api/layout/index.ts";
import type { TileFetcherFunc } from "../../client/index.ts";
import { type Fixture, hexToBytes, loadFixture } from "../../testonly/fixtures.ts";
import { parseCheckpoint } from "../../vendor/formats/log/index.ts";
import { newSignerForCosignatureV1 } from "../../vendor/formats/note/note_cosigv1.ts";
import { newVerifier, open, sign, type Verifier, verifierList } from "../../vendor/note/note.ts";
import { newWitness, newWitnessGroup, type Witness, WitnessGroup } from "../../witness.ts";
import { concatBytes, fromUTF8, toUTF8 } from "../gostd/bytes.ts";
import { errorIs, type JoinError } from "../gostd/errors.ts";
import { quote } from "../gostd/strconv.ts";
import {
	ErrPolicyNotSatisfied,
	newWitnessGateway,
	PolicyNotSatisfiedError,
	type WitnessGroup as witnessGroup,
} from "./witness.ts";

const wit1Vkey = "Wit1+55ee4561+AVhZSmQj9+SoL+p/nN0Hh76xXmF7QcHfytUrI1XfSClk";
const wit1Skey = "PRIVATE+KEY+Wit1+55ee4561+AeadRiG7XM4XiieCHzD8lxysXMwcViy5nYsoXURWGrlE";
const wit2Vkey = "Wit2+85ecc407+AWVbwFJte9wMQIPSnEnj4KibeO6vSIOEDUTDp3o63c2x";
const wit2Skey = "PRIVATE+KEY+Wit2+85ecc407+AfPTvxw5eUcqSgivo2vaiC7JPOMUZ/9baHPSDrWqgdGm";
const witBadVkey = "WitBad+b82b4b16+AY5FLOcqxs5lD+OpC6cVTrxsyNJktaCGYHNfnE5vKBQX";
const _witBadSkey = "PRIVATE+KEY+WitBad+b82b4b16+AYSil2PKfSN1a0LhdbzmK1uXqDFZbp+P1OyR54k3gdJY";

interface CheckpointSnapshot {
	readonly n: string;
	readonly raw: string;
}
interface ResourceFile {
	readonly path: string;
	readonly raw: string;
}
interface ClientLogFixture {
	readonly origin: string;
	readonly logVkey: string;
	readonly checkpoints: readonly CheckpointSnapshot[];
	readonly tiles: readonly ResourceFile[];
}

let logVerifier: Verifier;
let resources: Map<string, Uint8Array>;
let testLogTileFetcher: TileFetcherFunc;

beforeAll(async () => {
	const fixture: Fixture<ClientLogFixture> = await loadFixture<ClientLogFixture>("client_log");

	logVerifier = newVerifier(fixture.logVkey);

	resources = new Map<string, Uint8Array>();
	for (const t of fixture.tiles) {
		resources.set(t.path, hexToBytes(t.raw));
	}

	testLogTileFetcher = async (l, i, p): Promise<Uint8Array> => {
		const raw = resources.get(tilePath(l, i, p));
		if (raw === undefined) {
			throw new Error(`no fixture tile at ${tilePath(l, i, p)}`);
		}
		return raw;
	};
});

/** loadCheckpoint mirrors witness_test.go's loadCheckpoint(t, size), reading a fixture checkpoint. */
function loadCheckpoint(fixture: Fixture<ClientLogFixture>, size: number): { signed: Uint8Array; unsigned: string } {
	const snapshot = fixture.checkpoints.find((c) => c.n === String(size));
	if (snapshot === undefined) {
		throw new Error(`no checkpoint fixture for size ${size}`);
	}
	const signed = hexToBytes(snapshot.raw);
	const { note } = parseCheckpoint(signed, fixture.origin, logVerifier);
	return { signed, unsigned: note.text };
}

/** trimNewlines mirrors Go's `bytes.Trim(b, "\n")`. */
function trimNewlines(b: Uint8Array): Uint8Array {
	let start = 0;
	let end = b.length;
	while (start < end && b[start] === 0x0a) {
		start++;
	}
	while (end > start && b[end - 1] === 0x0a) {
		end--;
	}
	return b.subarray(start, end);
}

/** sigForSigner mirrors witness_test.go's sigForSigner: a single witness signature line, freshly signed. */
function sigForSigner(cpText: string, skey: string): Uint8Array {
	const s = newSignerForCosignatureV1(skey);
	const witSignedCheckpoint = sign({ text: cpText }, s);
	const cpBytes = toUTF8(cpText);
	const sigPart = witSignedCheckpoint.subarray(cpBytes.length);
	return concatBytes(trimNewlines(sigPart), toUTF8("\n"));
}

/** toArrayBuffer copies bytes into a freshly allocated, non-shared ArrayBuffer, which is what Response's constructor wants. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buf = new ArrayBuffer(bytes.length);
	new Uint8Array(buf).set(bytes);
	return buf;
}

/** requestBody extracts the Uint8Array body witness.ts's FetchFn calls are made with. */
function requestBody(init: RequestInit | undefined): Uint8Array {
	return (init?.body as Uint8Array | undefined) ?? new Uint8Array(0);
}

describe("TestWitnessGateway_Update", () => {
	let logSignedCheckpoint: Uint8Array;
	let cpText: string;
	let wit1: Witness;
	let wit2: Witness;
	let witBad: Witness;

	beforeAll(async () => {
		const fixture: Fixture<ClientLogFixture> = await loadFixture<ClientLogFixture>("client_log");
		({ signed: logSignedCheckpoint, unsigned: cpText } = loadCheckpoint(fixture, 9));

		const baseURL = new URL("https://witness-gateway-update.example/");
		wit1 = newWitness(wit1Vkey, new URL("wit1", baseURL));
		wit2 = newWitness(wit2Vkey, new URL("wit2", baseURL));
		witBad = newWitness(witBadVkey, baseURL);
	});

	// Set up a fake server hosting the witnesses.
	// The witnesses just sign the checkpoint with whatever key is requested, they don't check the body at all.
	async function fakeFetch(input: string): Promise<Response> {
		switch (input) {
			case wit1.url:
				return new Response(toArrayBuffer(sigForSigner(cpText, wit1Skey)), { status: 200 });
			case wit2.url:
				return new Response(toArrayBuffer(sigForSigner(cpText, wit2Skey)), { status: 200 });
			case witBad.url:
				return new Response(toArrayBuffer(toUTF8("this is not a signature\n")), { status: 200 });
			default:
				throw new Error(`Unknown case: ${input}`);
		}
	}

	const testCases: () => { desc: string; group: () => WitnessGroup; wantSigs: number; wantErr?: boolean }[] = () => [
		{ desc: "no witnesses", group: () => new WitnessGroup(), wantSigs: 0 },
		{ desc: "one optional witness", group: () => newWitnessGroup(0, wit1), wantSigs: 0 },
		{ desc: "two optional witnesses", group: () => newWitnessGroup(0, wit1, wit2), wantSigs: 0 },
		{ desc: "one required witness", group: () => newWitnessGroup(1, wit1), wantSigs: 1 },
		{ desc: "one required witness out of 2", group: () => newWitnessGroup(1, wit1, wit2), wantSigs: 1 },
		{ desc: "two required witnesses", group: () => newWitnessGroup(2, wit1, wit2), wantSigs: 2 },
		{ desc: "one required witness twice", group: () => newWitnessGroup(2, wit1, wit1), wantSigs: 1 },
		{ desc: "bad witness", group: () => newWitnessGroup(1, witBad), wantSigs: 0, wantErr: true },
	];

	for (const tC of testCases()) {
		it(tC.desc, async () => {
			const g = newWitnessGateway(tC.group(), fakeFetch, 0n, testLogTileFetcher);

			let witnessedCP: Uint8Array;
			let caught: unknown;
			try {
				witnessedCP = await g.witness(logSignedCheckpoint);
			} catch (err) {
				caught = err;
				witnessedCP = new Uint8Array(0);
			}
			expect(caught !== undefined).toBe(tC.wantErr ?? false);
			if (tC.wantErr ?? false) {
				return;
			}

			const n = open(witnessedCP, verifierList(logVerifier, wit1.key, wit2.key));
			expect((n.sigs?.length ?? 0) - 1).toBeGreaterThanOrEqual(tC.wantSigs);
		});
	}

	// Port addition: browsers and workerd throw "Illegal invocation" when the global fetch
	// is called as a method of another object, which Node tolerates. Pin that the witness
	// calls its FetchFn without a receiver (docs/decisions/0131).
	it("calls fetch without a receiver", async () => {
		const receivers: unknown[] = [];
		const recordingFetch = function (this: unknown, input: string): Promise<Response> {
			receivers.push(this);
			return fakeFetch(input);
		};
		const g = newWitnessGateway(newWitnessGroup(1, wit1), recordingFetch, 0n, testLogTileFetcher);
		await g.witness(logSignedCheckpoint);
		expect(receivers).toEqual([undefined]);
	});
});

describe("TestWitness_UpdateRequest", () => {
	let logSignedCheckpoint: Uint8Array;

	beforeAll(async () => {
		const fixture: Fixture<ClientLogFixture> = await loadFixture<ClientLogFixture>("client_log");
		({ signed: logSignedCheckpoint } = loadCheckpoint(fixture, 9));
	});

	const testCases: { desc: string; witSize: bigint; wantBody: () => string }[] = [
		{
			desc: "size 0 no proof needed",
			witSize: 0n,
			wantBody: () => `old 0\n\n${fromUTF8(logSignedCheckpoint)}`,
		},
		{
			desc: "non zero size requires proof",
			witSize: 6n,
			wantBody: () =>
				"old 6\nycRkkNklus5eMVRUvkD1pK321vMrA+jjOiZKU8aOcY4=\nnk9gCR+floFqznAPtqjjcnnV64dge2jQB95D5t164Hg=\n" +
				`zY1lN35vrXYAPixXSd59LsU29xUJtuW4o2dNNg5Y2Co=\n91HQqaPzWlbBsUDk3JvSpOTK7Bc4ifZGxXZzfABOmuU=\n\n${fromUTF8(logSignedCheckpoint)}`,
		},
	];

	for (const tC of testCases) {
		it(tC.desc, async () => {
			let initDone = false;
			let gotBody = "";
			const fetchFn = async (_input: string, init?: RequestInit): Promise<Response> => {
				if (!initDone) {
					initDone = true;
					return new Response(toArrayBuffer(toUTF8(String(tC.witSize))), {
						status: 409,
						headers: { "Content-Type": "text/x.tlog.size" },
					});
				}
				const body = requestBody(init);
				gotBody = fromUTF8(body);
				const idx = indexOfDoubleNewline(body);
				if (idx < 0) {
					throw new Error(`expected two newlines in body, got: ${quote(fromUTF8(body))}`);
				}
				const checkpoint = body.subarray(idx + 2);
				const { note } = parseCheckpoint(checkpoint, logVerifier.name(), logVerifier);
				return new Response(toArrayBuffer(sigForSigner(note.text, wit1Skey)), { status: 200 });
			};

			const wit1 = newWitness(wit1Vkey, new URL("https://witness-update-request.example/"));
			const group = newWitnessGroup(1, wit1);
			const wg = newWitnessGateway(group, fetchFn, 0n, testLogTileFetcher);
			await wg.witness(logSignedCheckpoint);

			expect(gotBody).toBe(tC.wantBody());
		});
	}
});

describe("TestWitness_UpdateResponse", () => {
	let cpText: string;
	let logSignedCheckpoint: Uint8Array;
	let sig1: Uint8Array;
	let sig2: Uint8Array;

	beforeAll(async () => {
		const fixture: Fixture<ClientLogFixture> = await loadFixture<ClientLogFixture>("client_log");
		({ signed: logSignedCheckpoint, unsigned: cpText } = loadCheckpoint(fixture, 9));
		sig1 = sigForSigner(cpText, wit1Skey);
		sig2 = sigForSigner(cpText, wit2Skey);
	});

	const testCases: () => {
		desc: string;
		statusCode: number;
		body: () => Uint8Array;
		wantErr?: boolean;
		wantResult?: () => Uint8Array;
	}[] = () => [
		{ desc: "all good", statusCode: 200, body: () => sig1, wantResult: () => sig1 },
		{ desc: "all good, two sigs", statusCode: 200, body: () => concatBytes(sig1, sig2), wantResult: () => sig1 },
		{ desc: "404 is an error", statusCode: 404, body: () => new Uint8Array(0), wantErr: true },
		{ desc: "403 is an error", statusCode: 403, body: () => new Uint8Array(0), wantErr: true },
		{ desc: "422 is an error", statusCode: 422, body: () => new Uint8Array(0), wantErr: true },
		{ desc: "409 with no headers is error", statusCode: 409, body: () => new Uint8Array(0), wantErr: true },
	];

	for (const tC of testCases()) {
		it(tC.desc, async () => {
			const fetchFn = async (): Promise<Response> => new Response(toArrayBuffer(tC.body()), { status: tC.statusCode });

			const wit1 = newWitness(wit1Vkey, new URL("https://witness-update-response.example/"));
			const g = newWitnessGateway(newWitnessGroup(1, wit1), fetchFn, 0n, testLogTileFetcher);

			let witnessed: Uint8Array | undefined;
			let caught: unknown;
			try {
				witnessed = await g.witness(logSignedCheckpoint);
			} catch (err) {
				caught = err;
			}
			expect(caught !== undefined).toBe(tC.wantErr ?? false);
			if (tC.wantErr ?? false) {
				return;
			}

			const sigs = (witnessed as Uint8Array).subarray(logSignedCheckpoint.length);
			expect(sigs).toEqual(tC.wantResult?.());
		});
	}
});

describe("TestWitnessConflict", () => {
	let logSignedCheckpoint: Uint8Array;
	let cpText: string;

	beforeAll(async () => {
		const fixture: Fixture<ClientLogFixture> = await loadFixture<ClientLogFixture>("client_log");
		({ signed: logSignedCheckpoint, unsigned: cpText } = loadCheckpoint(fixture, 9));
	});

	const testCases: () => { name: string; witnessSeen: bigint; oldSizeHint: bigint; wantErr?: boolean }[] = () => [
		{ name: "nothing seen before", witnessSeen: 0n, oldSizeHint: 0n },
		{ name: "correct hint", witnessSeen: 8n, oldSizeHint: 8n },
		{ name: "hint stale - witness missed an update", witnessSeen: 4n, oldSizeHint: 8n },
		{ name: "log rolled back - witness is ahead of log", witnessSeen: 20n, oldSizeHint: 0n, wantErr: true },
	];

	for (const test of testCases()) {
		it(test.name, async () => {
			let witnessSeen = test.witnessSeen;
			const wit1 = newWitness(wit1Vkey, new URL("https://witness-conflict.example/"));

			const fetchFn = async (_input: string, init?: RequestInit): Promise<Response> => {
				const body = fromUTF8(requestBody(init));
				const lines = body.split("\n");
				const firstLineParts = (lines[0] ?? "").split(" ");
				if (firstLineParts.length !== 2 || firstLineParts[0] !== "old") {
					throw new Error("invalid old line");
				}
				const oldSize = BigInt(firstLineParts[1] as string);

				if (oldSize !== witnessSeen) {
					return new Response(toArrayBuffer(toUTF8(`${witnessSeen}\n`)), {
						status: 409,
						headers: { "Content-Type": "text/x.tlog.size" },
					});
				}

				const resp = new Response(toArrayBuffer(sigForSigner(cpText, wit1Skey)), { status: 200 });
				witnessSeen = oldSize;
				return resp;
			};

			const group = newWitnessGroup(1, wit1);
			const g = newWitnessGateway(group, fetchFn, test.oldSizeHint, testLogTileFetcher);

			let caught: unknown;
			try {
				await g.witness(logSignedCheckpoint);
			} catch (err) {
				caught = err;
			}
			expect(caught !== undefined).toBe(test.wantErr ?? false);
		});
	}
});

describe("TestWitnessStateEvolution", () => {
	it("recovers from a stale size hint across two calls, using the log's real size on the second", async () => {
		const fixture: Fixture<ClientLogFixture> = await loadFixture<ClientLogFixture>("client_log");
		const { signed: logSignedCheckpoint, unsigned: cpText } = loadCheckpoint(fixture, 9);

		// Set up a fake server hosting the witnesses.
		// The witnesses just sign the checkpoint with whatever key is requested, they don't check the body at all.
		// An improvement on this would be to make the fake witnesses more realistic, but it's a non-trivial
		// amount of code to add to this already long test!
		//
		// Port note: Go's handler fails the test from inside the server with t.Fatalf. A
		// throw from this FetchFn would only become a failed witness update, which the
		// second call below is expected to produce anyway, so the handler records each
		// request body and the test asserts on them afterwards.
		let count = 0;
		const bodies: string[] = [];
		const wit1 = newWitness(wit1Vkey, new URL("https://witness-state-evolution.example/"));
		const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
			if (input !== wit1.url) {
				throw new Error(`got request to URL ${quote(input)} but expected ${quote(wit1.url)}`);
			}
			bodies.push(fromUTF8(requestBody(init)));
			let resp: Response;
			switch (count) {
				case 0:
					resp = new Response(toArrayBuffer(toUTF8("8")), {
						status: 409,
						headers: { "Content-Type": "text/x.tlog.size" },
					});
					break;
				case 1:
					resp = new Response(toArrayBuffer(sigForSigner(cpText, wit1Skey)), { status: 200 });
					break;
				default:
					// End of test; we don't even bother constructing a valid response here
					resp = new Response(toArrayBuffer(new Uint8Array(0)), { status: 200 });
			}
			count++;
			return resp;
		};

		const group = newWitnessGroup(1, wit1);
		const g = newWitnessGateway(group, fetchFn, 0n, testLogTileFetcher);
		// This call will trigger case 0 and then case 1 in the witness handler above.
		// case 0 will return a response that notifies the log that its view of the witness size is wrong.
		// This method will then update its size and make a second request with a consistency proof, triggering case 1.
		await g.witness(logSignedCheckpoint);
		expect(bodies[1]?.startsWith("old 8"), `expected body to start with old 8 but got\n${bodies[1]}`).toBe(true);

		// This triggers case 2 in the witness, which isn't implemented so we don't care about any error,
		// we just invoke this to cause the validation in that witness body to trigger.
		await g.witness(logSignedCheckpoint).then(
			() => undefined,
			() => undefined,
		);
		expect(count).toBe(3);
		expect(bodies[2]?.startsWith("old 9"), `expected body to start with old 9 but got\n${bodies[2]}`).toBe(true);
	});
});

describe("TestWitnessReusesProofs", () => {
	it("fetches the same number of tiles whether one witness or two share a consistency proof", async () => {
		const fixture: Fixture<ClientLogFixture> = await loadFixture<ClientLogFixture>("client_log");

		const wit1 = newWitness(wit1Vkey, new URL("wit1", "https://witness-reuses-proofs.example/"));
		const wit2 = newWitness(wit2Vkey, new URL("wit2", "https://witness-reuses-proofs.example/"));

		const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
			const body = requestBody(init);
			const idx = indexOfDoubleNewline(body);
			if (idx < 0) {
				throw new Error(`expected two newlines in body, got: ${fromUTF8(body)}`);
			}
			const checkpoint = body.subarray(idx + 2);
			const { note } = parseCheckpoint(checkpoint, fixture.origin, logVerifier);

			switch (input) {
				case wit1.url:
					return new Response(toArrayBuffer(sigForSigner(note.text, wit1Skey)), { status: 200 });
				case wit2.url:
					return new Response(toArrayBuffer(sigForSigner(note.text, wit2Skey)), { status: 200 });
				default:
					throw new Error(`Unknown case: ${input}`);
			}
		};

		let tf1 = 0;
		let tf2 = 0;
		const cf1: TileFetcherFunc = async (level, index, p, signal): Promise<Uint8Array> => {
			tf1++;
			return testLogTileFetcher(level, index, p, signal);
		};
		const cf2: TileFetcherFunc = async (level, index, p, signal): Promise<Uint8Array> => {
			tf2++;
			return testLogTileFetcher(level, index, p, signal);
		};
		const g1 = newWitnessGateway(newWitnessGroup(1, wit1), fetchFn, 0n, cf1);
		const g2 = newWitnessGateway(newWitnessGroup(2, wit1, wit2), fetchFn, 0n, cf2);

		for (let i = 0; i < 10; i++) {
			const { signed } = loadCheckpoint(fixture, i);
			await g1.witness(signed);
			await g2.witness(signed);
		}

		expect(tf1).toBe(tf2);
	});
});

/** indexOfDoubleNewline mirrors Go's `bytes.Cut(body, []byte("\n\n"))`'s search. */
function indexOfDoubleNewline(b: Uint8Array): number {
	for (let i = 0; i + 1 < b.length; i++) {
		if (b[i] === 0x0a && b[i + 1] === 0x0a) {
			return i;
		}
	}
	return -1;
}

// Port additions: request policy and limits with no Go counterpart (docs/decisions/0195,
// 0197, 0198), and Go's handling of an already-cancelled context.
describe("port additions: witness requests", () => {
	let logSignedCheckpoint: Uint8Array;
	let cpText: string;

	beforeAll(async () => {
		const fixture: Fixture<ClientLogFixture> = await loadFixture<ClientLogFixture>("client_log");
		({ signed: logSignedCheckpoint, unsigned: cpText } = loadCheckpoint(fixture, 9));
	});

	const wit = (): Witness => newWitness(wit1Vkey, new URL("https://witness-requests.example/"));

	it("omits credentials and does not follow redirects", async () => {
		let init: RequestInit | undefined;
		const fetchFn = async (_input: string, i?: RequestInit): Promise<Response> => {
			init = i;
			return new Response(toArrayBuffer(sigForSigner(cpText, wit1Skey)), { status: 200 });
		};
		await newWitnessGateway(newWitnessGroup(1, wit()), fetchFn, 0n, testLogTileFetcher).witness(logSignedCheckpoint);
		expect(init?.credentials).toBe("omit");
		expect(init?.redirect).toBe("manual");
	});

	it("rejects a redirect, whether returned as a 3xx or as a browser's opaque redirect", async () => {
		const opaque = new Response(null, { status: 200 });
		Object.defineProperty(opaque, "type", { value: "opaqueredirect" });
		Object.defineProperty(opaque, "status", { value: 0 });
		for (const [resp, status] of [
			[new Response(null, { status: 307, headers: { Location: "https://elsewhere.example/" } }), 307],
			[opaque, 0],
		] as const) {
			const g = newWitnessGateway(newWitnessGroup(1, wit()), async () => resp, 0n, testLogTileFetcher);
			const err = await g.witness(logSignedCheckpoint).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(PolicyNotSatisfiedError);
			expect((err as Error).message).toContain(
				`witness at "https://witness-requests.example/add-checkpoint" replied with a redirect, which is not followed: ${status}`,
			);
		}
	});

	it("refuses a response body larger than 16 KiB", async () => {
		const fetchFn = async (): Promise<Response> => new Response(new Uint8Array((16 << 10) + 1), { status: 200 });
		const err = await newWitnessGateway(newWitnessGroup(1, wit()), fetchFn, 0n, testLogTileFetcher)
			.witness(logSignedCheckpoint)
			.catch((e: unknown) => e);
		expect((err as Error).message).toContain(
			'failed to read body from witness at "https://witness-requests.example/add-checkpoint": response body exceeds the limit of 16384 bytes',
		);
	});

	it("gives up after three stale-size retries", async () => {
		let requests = 0;
		const fetchFn = async (): Promise<Response> => {
			requests++;
			return new Response(toArrayBuffer(toUTF8(`${requests}\n`)), {
				status: 409,
				headers: { "Content-Type": "text/x.tlog.size" },
			});
		};
		const err = await newWitnessGateway(newWitnessGroup(1, wit()), fetchFn, 0n, testLogTileFetcher)
			.witness(logSignedCheckpoint)
			.catch((e: unknown) => e);
		expect(requests).toBe(4);
		expect((err as Error).message).toContain(
			'witness at "https://witness-requests.example/add-checkpoint" replied with a stale x.tlog.size after 3 retries, the last 4',
		);
	});

	it("reports a URL that does not parse as Go's NewRequest failure", async () => {
		const group: witnessGroup = {
			satisfied: () => false,
			endpoints: () => new Map([["::not a url", newVerifier(wit1Vkey)]]),
		};
		const err = await newWitnessGateway(group, async () => new Response(null), 0n, testLogTileFetcher)
			.witness(logSignedCheckpoint)
			.catch((e: unknown) => e);
		expect((err as Error).message).toMatch(/\nfailed to construct request to "::not a url": /);
	});

	it("posts even when the signal is already aborted, as Go does, and reports the failure from fetch", async () => {
		// Go has no early check of ctx: the request is attempted, and client.Do fails.
		let posts = 0;
		const fetchFn = async (_input: string, init?: RequestInit): Promise<Response> => {
			posts++;
			init?.signal?.throwIfAborted();
			return new Response(toArrayBuffer(sigForSigner(cpText, wit1Skey)), { status: 200 });
		};
		const ctrl = new AbortController();
		ctrl.abort(new Error("cancelled"));
		const err = await newWitnessGateway(newWitnessGroup(1, wit()), fetchFn, 0n, testLogTileFetcher)
			.witness(logSignedCheckpoint, ctrl.signal)
			.catch((e: unknown) => e);
		expect(posts).toBe(1);
		expect(err).toBeInstanceOf(PolicyNotSatisfiedError);
		expect((err as Error).message).toContain(
			'failed to post to witness at "https://witness-requests.example/add-checkpoint": cancelled',
		);
	});
});

// Port addition: Go returns errors.Join(ErrPolicyNotSatisfied, err), which errors.Is walks;
// errorIs walks PolicyNotSatisfiedError the same way (ADR-0075).
it("port addition: a policy failure is ErrPolicyNotSatisfied and each witness error, as errors.Join makes it", async () => {
	const fixture: Fixture<ClientLogFixture> = await loadFixture<ClientLogFixture>("client_log");
	const { signed } = loadCheckpoint(fixture, 9);
	const boom = new Error("boom");
	const g = newWitnessGateway(
		newWitnessGroup(1, newWitness(wit1Vkey, new URL("https://witness-join.example/"))),
		async () => {
			throw boom;
		},
		0n,
		testLogTileFetcher,
	);
	const err = await g.witness(signed).catch((e: unknown) => e);
	expect(errorIs(err, ErrPolicyNotSatisfied)).toBe(true);
	expect(errorIs((err as JoinError).errors[1], ErrPolicyNotSatisfied)).toBe(false);
	expect((err as Error).message).toBe(
		'witness policy was not satisfied\nfailed to post to witness at "https://witness-join.example/add-checkpoint": boom',
	);
	expect((err as PolicyNotSatisfiedError).checkpoint).toEqual(signed);
});
