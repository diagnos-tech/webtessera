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

// Golden-fixture tests for formats/log. Every expected value in
// fixtures/data/checkpoint.json was produced by running the real
// github.com/transparency-dev/formats/log; see AGENTS.md §5.

import { beforeAll, describe, expect, it } from "vitest";
import { bytesEqual, fromUTF8 } from "../../../internal/gostd/bytes.ts";
import { hexToBytes, loadFixture, u64 } from "../../../testonly/fixtures.ts";
import { newSigner, newVerifier, type Signer, sign } from "../../note/note.ts";
import { Checkpoint } from "./checkpoint.ts";
import { ParseCheckpointError, parseCheckpoint } from "./note.ts";

interface FixtureSig {
	readonly name: string;
	readonly hash: string;
	readonly base64: string;
}

interface CheckpointFixture {
	readonly marshal: ReadonlyArray<{
		readonly desc: string;
		readonly origin: string;
		readonly size: string;
		readonly hash: string;
		readonly want: string;
		readonly wantText: string;
	}>;
	readonly unmarshal: ReadonlyArray<{
		readonly desc: string;
		readonly raw: string;
		readonly wantOrigin: string;
		readonly wantSize: string;
		readonly wantHash: string;
		readonly wantRest: string;
		readonly wantErr: boolean;
		readonly wantErrMsg: string;
	}>;
	readonly signed: ReadonlyArray<{
		readonly desc: string;
		readonly signers: readonly string[];
		readonly origin: string;
		readonly size: string;
		readonly hash: string;
		readonly want: string;
		readonly wantText: string;
	}>;
	readonly parseCheckpoint: ReadonlyArray<{
		readonly desc: string;
		readonly raw: string;
		readonly origin: string;
		readonly logVkey: string;
		readonly otherVkeys: readonly string[];
		readonly wantOrigin: string;
		readonly wantSize: string;
		readonly wantHash: string;
		readonly wantOtherData: string;
		readonly wantSigs: readonly FixtureSig[];
		readonly wantErr: boolean;
		readonly wantErrMsg: string;
	}>;
}

interface NoteKeysFixture {
	readonly keys: ReadonlyArray<{ readonly skey: string; readonly vkey: string }>;
}

describe("formats/log golden fixtures", () => {
	let fx: CheckpointFixture;
	let signerFor: Map<string, Signer>;

	beforeAll(async () => {
		fx = await loadFixture<CheckpointFixture>("checkpoint");
		const notes = await loadFixture<NoteKeysFixture>("note");
		signerFor = new Map<string, Signer>();
		for (const k of notes.keys) {
			signerFor.set(k.vkey, newSigner(k.skey));
		}
	});

	it("marshal produces byte-identical output", () => {
		expect(fx.marshal.length).toBeGreaterThan(0);
		for (const c of fx.marshal) {
			const cp = new Checkpoint({
				origin: c.origin,
				size: u64(c.size),
				hash: hexToBytes(c.hash),
			});
			const got = cp.marshal();
			expect(bytesEqual(got, hexToBytes(c.want)), `${c.desc}:\n${fromUTF8(got)}`).toBe(true);
			expect(fromUTF8(got), c.desc).toBe(c.wantText);
		}
	});

	it("unmarshal accepts and rejects exactly what Go does", () => {
		expect(fx.unmarshal.length).toBeGreaterThan(0);
		for (const c of fx.unmarshal) {
			const got = new Checkpoint();
			if (c.wantErr) {
				let thrown: unknown;
				try {
					got.unmarshal(hexToBytes(c.raw));
				} catch (e) {
					thrown = e;
				}
				expect(thrown, `${c.desc}: expected a rejection`).toBeDefined();
				// The message is asserted in full: the fixture records Go's wrapped
				// strconv and base64 text, including the byte offset of the offending
				// character.
				expect((thrown as Error).message, c.desc).toBe(c.wantErrMsg);
				// Go's Unmarshal assigns to the receiver only once it can no longer
				// fail, so a rejected parse must leave the Checkpoint at its zero value.
				expect(got.origin, `${c.desc}: mutated on error`).toBe("");
				expect(got.size, `${c.desc}: mutated on error`).toBe(0n);
				expect(got.hash.length, `${c.desc}: mutated on error`).toBe(0);
				continue;
			}

			const rest = got.unmarshal(hexToBytes(c.raw));
			expect(got.origin, c.desc).toBe(c.wantOrigin);
			expect(got.size, c.desc).toBe(u64(c.wantSize));
			expect(bytesEqual(got.hash, hexToBytes(c.wantHash)), c.desc).toBe(true);
			expect(bytesEqual(rest ?? new Uint8Array(0), hexToBytes(c.wantRest)), c.desc).toBe(true);
			// Absent trailing data is undefined, mirroring Go's nil.
			expect(rest === undefined, `${c.desc}: rest nil-ness`).toBe(c.wantRest === "");
		}
	});

	it("signed checkpoints are byte-identical", () => {
		expect(fx.signed.length).toBeGreaterThan(0);
		for (const c of fx.signed) {
			const cp = new Checkpoint({
				origin: c.origin,
				size: u64(c.size),
				hash: hexToBytes(c.hash),
			});
			const signers = c.signers.map((vkey) => {
				const s = signerFor.get(vkey);
				expect(s, `${c.desc}: fixture references unknown signer ${vkey}`).toBeDefined();
				return s as Signer;
			});
			const got = sign({ text: fromUTF8(cp.marshal()) }, ...signers);
			expect(bytesEqual(got, hexToBytes(c.want)), `${c.desc}:\n${fromUTF8(got)}`).toBe(true);
			expect(fromUTF8(got), c.desc).toBe(c.wantText);
		}
	});

	it("parseCheckpoint accepts and rejects exactly what Go does", () => {
		expect(fx.parseCheckpoint.length).toBeGreaterThan(0);
		for (const c of fx.parseCheckpoint) {
			const logVerifier = newVerifier(c.logVkey);
			const others = c.otherVkeys.map((v) => newVerifier(v));
			const raw = hexToBytes(c.raw);

			if (c.wantErr) {
				let thrown: unknown;
				try {
					parseCheckpoint(raw, c.origin, logVerifier, ...others);
				} catch (e) {
					thrown = e;
				}
				expect(thrown, `${c.desc}: expected a rejection`).toBeInstanceOf(ParseCheckpointError);
				expect((thrown as Error).message, c.desc).toBe(c.wantErrMsg);
				continue;
			}

			const { checkpoint, otherData, note } = parseCheckpoint(raw, c.origin, logVerifier, ...others);
			expect(checkpoint.origin, c.desc).toBe(c.wantOrigin);
			expect(checkpoint.size, c.desc).toBe(u64(c.wantSize));
			expect(bytesEqual(checkpoint.hash, hexToBytes(c.wantHash)), c.desc).toBe(true);
			expect(bytesEqual(otherData ?? new Uint8Array(0), hexToBytes(c.wantOtherData)), c.desc).toBe(true);
			expect(
				(note.sigs ?? []).map((s) => ({ name: s.name, hash: String(s.hash), base64: s.base64 })),
				c.desc,
			).toEqual(c.wantSigs.map((s) => ({ name: s.name, hash: s.hash, base64: s.base64 })));
		}
	});

	it("covers every rejection path the fixture records", () => {
		expect(fx.unmarshal.filter((c) => c.wantErr).length).toBeGreaterThanOrEqual(8);
		expect(fx.parseCheckpoint.filter((c) => c.wantErr).length).toBeGreaterThanOrEqual(4);
	});
});
