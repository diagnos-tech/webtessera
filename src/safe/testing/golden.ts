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

// Test-only. describeWebCryptoGolden proves, in whichever runtime calls it (Node, Chromium,
// workerd), that a note or checkpoint signed by a non-extractable WebCrypto key is
// byte-for-byte the one Go signs with the same key: it replays the Go-generated note and
// log fixtures through signAsync and withCheckpointAsyncSigner. Ed25519 is deterministic,
// so anything else is a bug. See docs/decisions/0223-async-signers-for-notes-and-checkpoints.md.

import { beforeAll, describe, expect, it } from "vitest";
import { newAppendOptions } from "../../append_lifecycle.ts";
import type { FetchFn } from "../../client/fetcher.ts";
import { bytesEqual, fromUTF8 } from "../../internal/gostd/bytes.ts";
import { ErrNotExist } from "../../internal/gostd/errors.ts";
import type { LogReader } from "../../lifecycle.ts";
import { hexToBytes, loadFixture, u64 } from "../../testonly/fixtures.ts";
import { newSigner, type Signature, sign, signAsync } from "../../vendor/note/note.ts";
import { importSignerKey, type LogKey, webCryptoEd25519 } from "../keys.ts";

interface noteFixture {
	readonly keys: ReadonlyArray<{ readonly skey: string; readonly vkey: string }>;
	readonly sign: ReadonlyArray<{
		readonly desc: string;
		readonly text: string;
		readonly signers: readonly string[];
		readonly existingSigs: ReadonlyArray<{ readonly name: string; readonly hash: string; readonly base64: string }>;
		readonly want: string;
		readonly wantErr: boolean;
		readonly wantErrMsg: string;
	}>;
}

interface logFixture {
	readonly origin: string;
	readonly logVkey: string;
	readonly checkpoint: string;
	readonly checkpointSize: string;
	readonly checkpointHash: string;
}

/** emptyReader is a LogReader with no published checkpoint, which is all checkpointPublisher reads. */
const emptyReader: LogReader = {
	readCheckpoint: async (): Promise<Uint8Array> => {
		throw ErrNotExist;
	},
	readTile: async (): Promise<Uint8Array> => {
		throw ErrNotExist;
	},
	readEntryBundle: async (): Promise<Uint8Array> => {
		throw ErrNotExist;
	},
	nextIndex: async (): Promise<bigint> => 0n,
	integratedSize: async (): Promise<bigint> => 0n,
};

const noFetch: FetchFn = async (): Promise<Response> => {
	throw new Error("unexpected request");
};

/**
 * describeWebCryptoGolden registers the suite. runtime names the runtime in the suite's
 * title; every runtime the suites run in supports Ed25519 in WebCrypto, so the suite
 * insists the keys really are WebCrypto keys.
 */
export function describeWebCryptoGolden(runtime: string): void {
	describe(`WebCrypto signatures are Go's (${runtime})`, () => {
		let notes: noteFixture;
		const keys = new Map<string, LogKey>();

		beforeAll(async () => {
			expect(await webCryptoEd25519()).toBe(true);
			notes = await loadFixture<noteFixture>("note");
			for (const k of notes.keys) {
				keys.set(k.vkey, await importSignerKey(k.skey, { fallback: "error" }));
			}
		});

		it("imports every fixture key as a non-extractable WebCrypto key with Go's vkey", () => {
			for (const k of notes.keys) {
				const key = keys.get(k.vkey);
				expect(key?.backend).toBe("webcrypto");
				expect(key?.extractable).toBe(false);
				expect(key?.vkey).toBe(k.vkey);
			}
		});

		it("signs every Go note fixture byte-identically through signAsync", async () => {
			for (const c of notes.sign) {
				const signers = c.signers.map((vkey) => keys.get(vkey) as LogKey);
				const n = {
					text: c.text,
					sigs: c.existingSigs.map((s): Signature => ({ name: s.name, hash: Number(s.hash), base64: s.base64 })),
				};
				if (c.wantErr) {
					await expect(signAsync(n, ...signers), c.desc).rejects.toThrow(c.wantErrMsg);
					continue;
				}
				const got = await signAsync(n, ...signers);
				expect(bytesEqual(got, hexToBytes(c.want)), `${c.desc}:\n${fromUTF8(got)}`).toBe(true);
			}
		});

		it("signs each note exactly as the synchronous noble signer does", async () => {
			for (const c of notes.sign.filter((c) => !c.wantErr)) {
				const noble = c.signers.map((vkey) => newSigner(notes.keys.find((k) => k.vkey === vkey)?.skey ?? ""));
				const webcrypto = c.signers.map((vkey) => keys.get(vkey) as LogKey);
				const n = { text: c.text };
				expect(bytesEqual(await signAsync(n, ...webcrypto), sign(n, ...noble)), c.desc).toBe(true);
			}
		});

		for (const name of ["log_1", "log_256", "log_5000"]) {
			it(`publishes ${name}'s checkpoint byte-identically to Go's, through withCheckpointAsyncSigner`, async () => {
				const f = await loadFixture<logFixture>(name);
				const key = keys.get(f.logVkey) as LogKey;
				const publish = newAppendOptions().withCheckpointAsyncSigner(key).checkpointPublisher(emptyReader, noFetch);
				const got = await publish(u64(f.checkpointSize), hexToBytes(f.checkpointHash));
				expect(fromUTF8(got)).toBe(fromUTF8(hexToBytes(f.checkpoint)));
			});
		}
	});
}
