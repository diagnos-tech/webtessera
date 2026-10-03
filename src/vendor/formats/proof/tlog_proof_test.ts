// Copyright 2026 Google LLC. All Rights Reserved.
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
// Ported from github.com/transparency-dev/formats/proof/tlog_proof_test.go @ v0.1.1

import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { bytesEqual, fromUTF8, toBase64, toUTF8 } from "../../../internal/gostd/bytes.ts";
import { TLogProof } from "./tlog_proof.ts";

/** sum256 stands in for Go's `sha256.Sum256`. */
function sum256(s: string): Uint8Array {
	return sha256(toUTF8(s));
}

/** unmarshalError returns the error message unmarshalling data throws. */
function unmarshalError(data: Uint8Array): string {
	const p = new TLogProof();
	try {
		p.unmarshal(data);
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
	throw new Error("expected error but got none");
}

describe("formats/proof tlog_proof", () => {
	describe("TestMarshal", () => {
		const h1 = sum256("hash1");
		const h2 = sum256("hash2");
		const h1b64 = toBase64(h1);
		const h2b64 = toBase64(h2);
		const extra = toUTF8("extra information");
		const extraB64 = toBase64(extra);

		const tests: { name: string; proof: TLogProof; want: string }[] = [
			{
				name: "proof without extra data",
				proof: new TLogProof({
					index: 5n,
					hashes: [h1, h2],
					checkpoint: toUTF8("test checkpoint\n"),
				}),
				want: `c2sp.org/tlog-proof@v1\nindex 5\n${h1b64}\n${h2b64}\n\ntest checkpoint\n`,
			},
			{
				name: "proof with extra data",
				proof: new TLogProof({
					index: 10n,
					hashes: [h1],
					checkpoint: toUTF8("checkpoint data\n"),
					extraData: extra,
				}),
				want: `c2sp.org/tlog-proof@v1\nextra ${extraB64}\nindex 10\n${h1b64}\n\ncheckpoint data\n`,
			},
			{
				name: "proof with empty hashes",
				proof: new TLogProof({
					index: 0n,
					hashes: [],
					checkpoint: toUTF8("checkpoint\n"),
				}),
				want: "c2sp.org/tlog-proof@v1\nindex 0\n\ncheckpoint\n",
			},
		];

		for (const tt of tests) {
			it(tt.name, () => {
				expect(fromUTF8(tt.proof.marshal())).toBe(tt.want);
			});
		}
	});

	describe("TestUnmarshalErrors", () => {
		const tests: { name: string; proof: Uint8Array; wantErrSubstr: string }[] = [
			{
				name: "missing header",
				proof: toUTF8("wrong-header\nindex 0\n\ncheckpoint\n"),
				wantErrSubstr: "missing expected header",
			},
			{
				name: "invalid extra data encoding",
				proof: toUTF8("c2sp.org/tlog-proof@v1\nextra !!notbase64!!\nindex 0\n\ncheckpoint\n"),
				wantErrSubstr: "extra data not base64 encoded",
			},
			{
				name: "missing index",
				proof: toUTF8("c2sp.org/tlog-proof@v1\n\n\ncheckpoint\n"),
				wantErrSubstr: "missing required index",
			},
			{
				name: "invalid index - not a number",
				proof: toUTF8("c2sp.org/tlog-proof@v1\nindex notanumber\n\ncheckpoint\n"),
				wantErrSubstr: "not a valid uint64",
			},
			{
				name: "invalid index - negative",
				proof: toUTF8("c2sp.org/tlog-proof@v1\nindex -5\n\ncheckpoint\n"),
				wantErrSubstr: "not a valid uint64",
			},
			{
				name: "invalid hash base64",
				proof: toUTF8("c2sp.org/tlog-proof@v1\nindex 0\n!!notbase64!!\n\ncheckpoint\n"),
				wantErrSubstr: "hash not base64 encoded",
			},
			{
				name: "incorrect hash length",
				proof: toUTF8(`c2sp.org/tlog-proof@v1\nindex 0\n${toBase64(new Uint8Array(64))}\n\ncheckpoint\n`),
				wantErrSubstr: "hash length",
			},
			{
				name: "scanner error - buffer too large",
				proof: toUTF8(`c2sp.org/tlog-proof@v1\nindex 0\n${"a".repeat(65 * 1024)}\n`),
				wantErrSubstr: "scanning tlog proof",
			},
		];

		for (const tt of tests) {
			it(tt.name, () => {
				expect(unmarshalError(tt.proof)).toContain(tt.wantErrSubstr);
			});
		}
	});

	describe("TestRoundTrip", () => {
		const tests: { name: string; proof: TLogProof }[] = [
			{
				name: "simple proof",
				proof: new TLogProof({
					index: 123n,
					hashes: [sum256("a"), sum256("b")],
					checkpoint: toUTF8("some checkpoint\n"),
				}),
			},
			{
				name: "proof with extra data",
				proof: new TLogProof({
					index: 456n,
					hashes: [sum256("c")],
					checkpoint: toUTF8("another checkpoint\n"),
					extraData: toUTF8("some extra data"),
				}),
			},
			{
				name: "empty hashes",
				proof: new TLogProof({
					index: 789n,
					hashes: [],
					checkpoint: toUTF8("checkpoint\n"),
				}),
			},
		];

		for (const tt of tests) {
			it(tt.name, () => {
				const marshaled = tt.proof.marshal();

				const unmarshaled = new TLogProof();
				unmarshaled.unmarshal(marshaled);

				expect(unmarshaled.index).toBe(tt.proof.index);
				expect(bytesEqual(unmarshaled.checkpoint, tt.proof.checkpoint)).toBe(true);
				expect(unmarshaled.extraData).toEqual(tt.proof.extraData);
				expect(unmarshaled.hashes.length).toBe(tt.proof.hashes.length);
				for (let i = 0; i < unmarshaled.hashes.length; i++) {
					expect(bytesEqual(unmarshaled.hashes[i] as Uint8Array, tt.proof.hashes[i] as Uint8Array), `Hash ${i}`).toBe(
						true,
					);
				}
			});
		}
	});

	// Beyond upstream. Each "Go:" vector below is what github.com/transparency-dev/formats/proof
	// v0.1.1 returns for the same input under Go 1.25, recorded by hand; see
	// docs/decisions/0224-port-formats-proof-for-tlog-proof.md.
	describe("matches Go on its lenient edges", () => {
		const header = "c2sp.org/tlog-proof@v1";

		it("marshals a zero-length extra as an empty extra line, and the largest uint64 index", () => {
			const p = new TLogProof({
				index: 18446744073709551615n,
				hashes: [sum256("a")],
				checkpoint: toUTF8("origin\n1\nAAAA\n\n— origin abc=\n"),
				extraData: new Uint8Array(0),
			});
			// Go: "c2sp.org/tlog-proof@v1\nextra \nindex 18446744073709551615\nypeB…SLs=\n\norigin\n1\nAAAA\n\n— origin abc=\n"
			expect(fromUTF8(p.marshal())).toBe(
				`${header}\nextra \nindex 18446744073709551615\nypeBEsobvcr6wjGzmiPcTaeG7/gUfE5yuYB3ha/uSLs=\n\norigin\n1\nAAAA\n\n— origin abc=\n`,
			);
		});

		it("reads an empty extra line as present, zero-length extra data", () => {
			const p = new TLogProof();
			p.unmarshal(toUTF8(`${header}\nextra \nindex 0\n\ncp\n`));
			// Go: index=0 hashes=0 checkpoint="cp\n" extraNil=false extra=""
			expect(p.extraData).toEqual(new Uint8Array(0));
			expect(fromUTF8(p.checkpoint)).toBe("cp\n");
		});

		it("drops a CR before each newline, including the checkpoint's", () => {
			const p = new TLogProof();
			p.unmarshal(toUTF8(`${header}\r\nindex 5\r\n\r\ncp line\r\n`));
			// Go: index=5 hashes=0 checkpoint="cp line\n" extraNil=true
			expect(p.index).toBe(5n);
			expect(fromUTF8(p.checkpoint)).toBe("cp line\n");
			expect(p.extraData).toBeUndefined();
		});

		it("accepts an index with leading zeros", () => {
			const p = new TLogProof();
			p.unmarshal(toUTF8(`${header}\nindex 007\n\ncp\n`));
			// Go: index=7
			expect(p.index).toBe(7n);
		});

		it("ends the checkpoint with a newline even when the input does not", () => {
			const p = new TLogProof();
			p.unmarshal(toUTF8(`${header}\nindex 1\n\ncp a\ncp b`));
			// Go: checkpoint="cp a\ncp b\n"
			expect(fromUTF8(p.checkpoint)).toBe("cp a\ncp b\n");
		});

		it("keeps blank lines inside the checkpoint", () => {
			const p = new TLogProof();
			p.unmarshal(toUTF8(`${header}\nindex 1\n\na\n\nb\n`));
			// Go: checkpoint="a\n\nb\n"
			expect(fromUTF8(p.checkpoint)).toBe("a\n\nb\n");
		});

		it("reads a proof with no blank line and no checkpoint", () => {
			const p = new TLogProof();
			p.unmarshal(toUTF8(`${header}\nindex 1\n`));
			// Go: index=1 hashes=0 checkpoint=""
			expect(p.index).toBe(1n);
			expect(p.checkpoint).toEqual(new Uint8Array(0));
		});

		const errors: { name: string; in: string; want: string }[] = [
			{ name: "empty input", in: "", want: "tlog proof missing expected header" },
			{ name: "header only", in: `${header}\n`, want: "tlog proof missing required index" },
			{
				name: "extra without a space",
				in: `${header}\nextra\nindex 0\n\ncp\n`,
				want: "tlog proof missing required index",
			},
			{
				name: "signed index",
				in: `${header}\nindex +1\n\ncp\n`,
				want: 'tlog proof index not a valid uint64: strconv.ParseUint: parsing "+1": invalid syntax',
			},
			{
				name: "index above uint64",
				in: `${header}\nindex 18446744073709551616\n\ncp\n`,
				want: 'tlog proof index not a valid uint64: strconv.ParseUint: parsing "18446744073709551616": value out of range',
			},
			{
				name: "two spaces before the index",
				in: `${header}\nindex  1\n\ncp\n`,
				want: 'tlog proof index not a valid uint64: strconv.ParseUint: parsing " 1": invalid syntax',
			},
		];
		for (const tt of errors) {
			it(`fails like Go on ${tt.name}`, () => {
				expect(unmarshalError(toUTF8(tt.in))).toBe(tt.want);
			});
		}
	});

	// Beyond upstream: where C2SP tlog-proof requires more of a decoder than Go's does.
	describe("is stricter than Go where tlog-proof requires it", () => {
		const header = "c2sp.org/tlog-proof@v1";

		// "Encoders MUST generate canonical base64 according to RFC 4648, Section 3.5, and
		// decoders MUST reject non-canonical encodings." Go accepts all three of these.
		it("rejects a hash whose padding bits are not zero", () => {
			expect(unmarshalError(toUTF8(`${header}\nindex 0\nypeBEsobvcr6wjGzmiPcTaeG7/gUfE5yuYB3ha/uSLt=\n\ncp\n`))).toBe(
				"tlog proof hash not canonically base64 encoded",
			);
		});

		it("rejects a hash with a CR inside it", () => {
			expect(unmarshalError(toUTF8(`${header}\nindex 0\nypeBEsobvcr6wjGzmiPcTaeG7/gUfE5yuYB3ha/u\rSLs=\n\ncp\n`))).toBe(
				"tlog proof hash not canonically base64 encoded",
			);
		});

		it("rejects extra data whose padding bits are not zero", () => {
			expect(unmarshalError(toUTF8(`${header}\nextra YR==\nindex 0\n\ncp\n`))).toBe(
				"tlog proof extra data not canonically base64 encoded",
			);
		});
	});

	describe("port-specific guards", () => {
		it("refuses to marshal a hash that is not 32 bytes, which Go's [32]byte cannot hold", () => {
			const p = new TLogProof({ index: 0n, hashes: [new Uint8Array(31)], checkpoint: toUTF8("cp\n") });
			expect(() => p.marshal()).toThrow("tlog proof hash length was 31, expected 32");
		});

		it("refuses an index outside uint64", () => {
			expect(() => new TLogProof({ index: -1n })).toThrow(RangeError);
			const p = new TLogProof();
			p.index = 1n << 64n;
			expect(() => p.marshal()).toThrow(RangeError);
		});

		it("leaves the receiver untouched when unmarshalling fails", () => {
			const p = new TLogProof({ index: 3n, hashes: [sum256("a")], checkpoint: toUTF8("cp\n") });
			expect(() => p.unmarshal(toUTF8("c2sp.org/tlog-proof@v1\nindex x\n\ncp\n"))).toThrow();
			expect(p.index).toBe(3n);
			expect(p.hashes.length).toBe(1);
			expect(fromUTF8(p.checkpoint)).toBe("cp\n");
		});

		it("returns copies, not views of the input", () => {
			const data = toUTF8(`c2sp.org/tlog-proof@v1\nindex 0\n${toBase64(sum256("a"))}\n\ncp\n`);
			const p = new TLogProof();
			p.unmarshal(data);
			data.fill(0);
			expect(fromUTF8(p.checkpoint)).toBe("cp\n");
			expect(bytesEqual(p.hashes[0] as Uint8Array, sum256("a"))).toBe(true);
		});
	});
});
