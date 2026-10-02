// Copyright 2024 The Tessera authors. All Rights Reserved.
// Copyright 2026 MedDeck LTDA. All Rights Reserved.
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
import { bytesEqual, fromBase64, toUTF8 } from "../gostd/bytes.ts";
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
			wantHash: mustDecodeB64("qINS1GRFhWHwdkUeqLEoP4yEMkTBBzxBkGwGQlVlVcs="),
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
			wantHash: mustDecodeB64("qINS1GRFhWHwdkUeqLEoP4yEMkTBBzxBkGwGQlVlVcs="),
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

function mustDecodeB64(encoded: string): Uint8Array {
	return fromBase64(encoded);
}
