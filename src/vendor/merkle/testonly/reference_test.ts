// Copyright 2022 Google LLC. All Rights Reserved.
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
// Ported from merkle/testonly/reference_test.go @ v0.0.2 (test half)
//
// The reference implementations these tests cover live in ./reference.ts; see
// the port note there.

import { describe, expect, it } from "vitest";
import { fromHex } from "../../../internal/gostd/bytes.ts";
import { DefaultHasher } from "../rfc6962/rfc6962.ts";
import { leafInputs } from "./constants.ts";
import { downToPowerOfTwo, refConsistencyProof, refInclusionProof } from "./reference.ts";

describe("TestDownToPowerOfTwo", () => {
	it("returns the largest smaller power of two", () => {
		const cases: [bigint, bigint][] = [
			[2n, 1n],
			[7n, 4n],
			[8n, 4n],
			[63n, 32n],
			[28937n, 16384n],
		];
		for (const [input, output] of cases) {
			expect(downToPowerOfTwo(input), `downToPowerOfTwo(${input})`).toBe(output);
		}
	});
});

describe("TestRefInclusionProof", () => {
	const tests: { index: bigint; size: number; want: Uint8Array[] }[] = [
		{ index: 0n, size: 1, want: [] },
		{ index: 0n, size: 2, want: [hd("96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7")] },
		{ index: 1n, size: 2, want: [hd("6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d")] },
		{ index: 2n, size: 3, want: [hd("fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125")] },
		{
			index: 1n,
			size: 5,
			want: [
				hd("6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d"),
				hd("5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e"),
				hd("bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b"),
			],
		},
		{
			index: 0n,
			size: 8,
			want: [
				hd("96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7"),
				hd("5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e"),
				hd("6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4"),
			],
		},
		{
			index: 5n,
			size: 8,
			want: [
				hd("bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b"),
				hd("ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0"),
				hd("d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7"),
			],
		},
	];

	for (const tc of tests) {
		it(`${tc.index}:${tc.size}`, () => {
			const entries = leafInputs();
			const got = refInclusionProof(entries.slice(0, tc.size), tc.index, DefaultHasher);
			expect(got).toEqual(tc.want);
		});
	}
});

describe("TestRefConsistencyProof", () => {
	const tests: { size1: bigint; size2: bigint; want: Uint8Array[] }[] = [
		{ size1: 1n, size2: 1n, want: [] },
		{
			size1: 1n,
			size2: 8n,
			want: [
				hd("96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7"),
				hd("5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e"),
				hd("6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4"),
			],
		},
		{
			size1: 2n,
			size2: 5n,
			want: [
				hd("5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e"),
				hd("bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b"),
			],
		},
		{
			size1: 6n,
			size2: 8n,
			want: [
				hd("0ebc5d3437fbe2db158b9f126a1d118e308181031d0a949f8dededebc558ef6a"),
				hd("ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0"),
				hd("d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7"),
			],
		},
	];

	for (const tc of tests) {
		it(`${tc.size1}:${tc.size2}`, () => {
			const entries = leafInputs();
			const got = refConsistencyProof(entries.slice(0, Number(tc.size2)), tc.size2, tc.size1, DefaultHasher, true);
			expect(got).toEqual(tc.want);
		});
	}
});

// hd decodes a hex string or throws. Mirrors constants.go's package-private helper.
function hd(b: string): Uint8Array {
	return fromHex(b);
}
