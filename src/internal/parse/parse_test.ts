// Copyright 2024 The Tessera authors. All Rights Reserved.
// Copyright 2026 MedDeck. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//	http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Ported from tessera/internal/parse/parse_test.go @ 4a6d9f9

import { describe, expect, it } from "vitest";
import { bytesEqual, fromBase64, fromHex, toHex, toUTF8 } from "../gostd/bytes.ts";
import { checkpointUnsafe } from "./parse.ts";

describe("TestCheckpointUnsafe", () => {
	const testCases: {
		desc: string;
		cp: string;
		wantOrigin: string;
		wantSize: bigint;
		wantHash: Uint8Array;
		wantErr: boolean;
	}[] = [
		{
			desc: "happy checkpoint",
			cp: "original.example.com\n42\nqINS1GRFhWHwdkUeqLEoP4yEMkTBBzxBkGwGQlVlVcs=\n",
			wantOrigin: "original.example.com",
			wantSize: 42n,
			wantHash: mustDecodeB64("qINS1GRFhWHwdkUeqLEoP4yEMkTBBzxBkGwGQlVlVcs=", qINS1GRFhex),
			wantErr: false,
		},
		{
			desc: "Negative size",
			cp: "original.example.com\n-42\nqINS1GRFhWHwdkUeqLEoP4yEMkTBBzxBkGwGQlVlVcs=\n",
			wantOrigin: "",
			wantSize: 0n,
			wantHash: new Uint8Array(0),
			wantErr: true,
		},
		{
			desc: "Bad hash",
			cp: "original.example.com\n42\nthisisnotright\n",
			wantOrigin: "",
			wantSize: 0n,
			wantHash: new Uint8Array(0),
			wantErr: true,
		},
		{
			desc: "Empty origin",
			cp: "\n42\nqINS1GRFhWHwdkUeqLEoP4yEMkTBBzxBkGwGQlVlVcs=\n",
			wantOrigin: "",
			wantSize: 42n,
			wantHash: mustDecodeB64("qINS1GRFhWHwdkUeqLEoP4yEMkTBBzxBkGwGQlVlVcs=", qINS1GRFhex),
			wantErr: false,
		},
		{
			desc: "No origin",
			cp: "42\nqINS1GRFhWHwdkUeqLEoP4yEMkTBBzxBkGwGQlVlVcs=\n",
			wantOrigin: "",
			wantSize: 0n,
			wantHash: new Uint8Array(0),
			wantErr: true,
		},
	];

	for (const tC of testCases) {
		it(tC.desc, () => {
			let origin = "";
			let size = 0n;
			let hash: Uint8Array = new Uint8Array(0);
			let gotErr = false;
			try {
				const got = checkpointUnsafe(toUTF8(tC.cp));
				origin = got.origin;
				size = got.size;
				hash = got.hash;
			} catch {
				gotErr = true;
			}
			expect(gotErr).toBe(tC.wantErr);
			if (tC.wantErr) {
				return;
			}
			expect(origin).toBe(tC.wantOrigin);
			expect(size).toBe(tC.wantSize);
			expect(bytesEqual(tC.wantHash, hash)).toBe(true);
		});
	}
});

/** qINS1GRFhex is the hex encoding of the bytes "qINS1GRFhWHwdkUeqLEoP4yEMkTBBzxBkGwGQlVlVcs=" encodes. */
const qINS1GRFhex = "a88352d464458561f076451ea8b1283f8c843244c1073c41906c0642556555cb";

/**
 * mustDecodeB64 mirrors parse_test.go's helper.
 *
 * Port note: Go's helper decodes with the standard library, which is independent of the
 * code under test. Here checkpointUnsafe itself decodes with gostd's fromBase64, so a
 * want value produced by the same function could not catch a decoding bug; the decoded
 * bytes are therefore also checked against their hex literal.
 */
function mustDecodeB64(encoded: string, wantHex: string): Uint8Array {
	const res = fromBase64(encoded);
	if (toHex(res) !== wantHex) {
		throw new Error(`mustDecodeB64(${encoded}) = ${toHex(res)}, want ${wantHex}`);
	}
	return fromHex(wantHex);
}
