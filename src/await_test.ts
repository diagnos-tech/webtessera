// Copyright 2024 The Tessera authors. All Rights Reserved.
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
//
// Ported from tessera/await_test.go @ 4a6d9f9

import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import type { Index, IndexFuture } from "./append_lifecycle.ts";
import { newPublicationAwaiter } from "./await.ts";
import { bytesEqual, fromUTF8, toUTF8 } from "./internal/gostd/bytes.ts";
import { sleep } from "./internal/gostd/sync.ts";
import { Checkpoint, parseCheckpoint } from "./vendor/formats/log/index.ts";
import { newSigner, newVerifier, sign } from "./vendor/note/note.ts";

// Port note: Go's BenchmarkAwait is not ported, per docs/decisions/0034-go-benchmarks-not-ported.md.

describe("TestAwait", () => {
	const testTimeout = 100;
	const testCases: {
		desc: string;
		fIndex: bigint;
		fErr: Error | undefined;
		fDelay: number;
		cpBody: Uint8Array | undefined;
		cpErr: Error | undefined;
		cpDelay: number;
		wantErr: boolean;
	}[] = [
		{
			desc: "future error",
			fIndex: 0n,
			fErr: new Error("you have no future"),
			fDelay: 0,
			cpBody: undefined,
			cpErr: undefined,
			cpDelay: 0,
			wantErr: true,
		},
		{
			desc: "future takes too long",
			fIndex: 2n,
			fErr: undefined,
			fDelay: testTimeout,
			cpBody: undefined,
			cpErr: undefined,
			cpDelay: 0,
			wantErr: true,
		},
		{
			desc: "checkpoint is big enough",
			fIndex: 2n,
			fErr: undefined,
			fDelay: 0,
			cpBody: toUTF8("origin\n3\nqINS1GRFhWHwdkUeqLEoP4yEMkTBBzxBkGwGQlVlVcs=\n"),
			cpErr: undefined,
			cpDelay: 0,
			wantErr: false,
		},
		{
			desc: "checkpoint is too small",
			fIndex: 2n,
			fErr: undefined,
			fDelay: 0,
			cpBody: toUTF8("origin\n2\nthisisdefinitelyahash\n"),
			cpErr: undefined,
			cpDelay: 0,
			wantErr: true,
		},
		{
			desc: "checkpoint takes too long",
			fIndex: 2n,
			fErr: undefined,
			fDelay: 0,
			cpBody: toUTF8("origin\n3\nthisisdefinitelyahash\n"),
			cpErr: undefined,
			cpDelay: testTimeout,
			wantErr: true,
		},
		{
			desc: "checkpoint takes a few polls then returns",
			fIndex: 2n,
			fErr: undefined,
			fDelay: 0,
			cpBody: toUTF8("origin\n3\nqINS1GRFhWHwdkUeqLEoP4yEMkTBBzxBkGwGQlVlVcs=\n"),
			cpErr: undefined,
			cpDelay: 40,
			wantErr: false,
		},
		{
			desc: "checkpoint takes a few polls then fails",
			fIndex: 2n,
			fErr: undefined,
			fDelay: 0,
			cpBody: undefined,
			cpErr: new Error("sorry but the checkpoint is in another castle"),
			cpDelay: 40,
			wantErr: true,
		},
		{
			desc: "checkpoint is garbled - no newlines",
			fIndex: 2n,
			fErr: undefined,
			fDelay: 0,
			cpBody: toUTF8("origin22nonewlineshere"),
			cpErr: undefined,
			cpDelay: 0,
			wantErr: true,
		},
		{
			desc: "checkpoint is garbled - size not parseable",
			fIndex: 2n,
			fErr: undefined,
			fDelay: 0,
			cpBody: toUTF8("origin\ntwo\nnonewlineshere"),
			cpErr: undefined,
			cpDelay: 0,
			wantErr: true,
		},
	];
	for (const tC of testCases) {
		it(tC.desc, async () => {
			// await will time out via this signal, causing tests to fail
			// if the integration condition is never reached.
			const ctrl = new AbortController();
			const ctx = AbortSignal.any([ctrl.signal, AbortSignal.timeout(testTimeout)]);

			try {
				const readCheckpoint = async (_signal?: AbortSignal): Promise<Uint8Array> => {
					await sleep(tC.cpDelay);
					if (tC.cpErr !== undefined) {
						throw tC.cpErr;
					}
					return tC.cpBody ?? new Uint8Array(0);
				};
				const awaiter = newPublicationAwaiter(readCheckpoint, 10, ctx);

				const future: IndexFuture = async (): Promise<Index> => {
					await sleep(tC.fDelay);
					if (tC.fErr !== undefined) {
						throw tC.fErr;
					}
					return { index: tC.fIndex, isDup: false };
				};

				let i: Index | undefined;
				let cp: Uint8Array | undefined;
				let err: unknown;
				try {
					[i, cp] = await awaiter.await(future, ctx);
				} catch (e) {
					err = e;
				}
				const gotErr = err !== undefined;
				expect(gotErr, `gotErr != wantErr (${gotErr} != ${tC.wantErr}): ${String(err)}`).toBe(tC.wantErr);
				if (gotErr) {
					// Everything after here tests successful Await
					return;
				}
				expect(i?.index).toBe(tC.fIndex);
				expect(bytesEqual(cp ?? new Uint8Array(0), tC.cpBody ?? new Uint8Array(0))).toBe(true);
			} finally {
				ctrl.abort();
			}
		});
	}
});

it("TestAwait_multiClient", async () => {
	const s = newSigner("PRIVATE+KEY+example.com/log/testdata+33d7b496+AeymY/SZAX0jZcJ8enZ5FY1Dz+wTML2yWSkK+9DSF3eg");
	const v = newVerifier("example.com/log/testdata+33d7b496+AeHTu4Q3hEIMHNqc6fASMsq3rKNx280NI+oO5xCFkkSx");

	// Port note: Go bounds the whole test with a 1s context. The port raises it because each of
	// the 300 clients verifies its returned checkpoint with parseCheckpoint, i.e. 300 Ed25519
	// verifications through the pure-JS @noble/curves implementation, which is materially slower
	// than Go's native crypto/ed25519 — 1s produces false timeouts here. The correctness this test
	// asserts (every one of the 300 concurrent clients is released with a checkpoint whose size
	// covers its assigned index) is unchanged; only the safety bound is relaxed. See
	// docs/decisions/0186-await-multiclient-test-timeout-relaxed.md.
	const testTimeout = 15000;
	// await will time out via this signal, causing tests to fail
	// if the integration condition is never reached.
	const ctrl = new AbortController();
	const ctx = AbortSignal.any([ctrl.signal, AbortSignal.timeout(testTimeout)]);

	try {
		let size = 0n;
		const readCheckpoint = async (_signal?: AbortSignal): Promise<Uint8Array> => {
			await sleep(3);
			// Grow the tree every time this is called
			size += 10n;
			// This isn't generating a real log but can be changed if needed
			const hash = sha256(toUTF8(String(size)));
			const cpRaw = new Checkpoint({
				origin: "example.com/log/testdata",
				size,
				hash,
			}).marshal();
			return sign({ text: fromUTF8(cpRaw) }, s);
		};
		const awaiter = newPublicationAwaiter(readCheckpoint, 10, ctx);

		const tasks: Promise<void>[] = [];
		for (let i = 0; i < 300; i++) {
			const index = BigInt(i);
			const future: IndexFuture = async (): Promise<Index> => {
				await sleep(15);
				return { index, isDup: false };
			};
			tasks.push(
				(async (): Promise<void> => {
					const [ii, cpRaw] = await awaiter.await(future, ctx);
					expect(ii.index).toBe(index);
					const { checkpoint: cp } = parseCheckpoint(cpRaw, "example.com/log/testdata", v);
					expect(cp.size >= ii.index).toBe(true);
				})(),
			);
		}
		await Promise.all(tasks);
	} finally {
		ctrl.abort();
	}
}, 30000);
