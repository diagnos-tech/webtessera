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

// Golden-fixture tests for merkle/rfc6962. The vectors in fixtures/data are
// emitted by the real Go implementation; see fixtures/README.md and
// docs/decisions/0006-golden-fixtures-from-go.md.
//
// rfc6962_test.ts already ports upstream's own four vectors. This file asserts
// byte-equality against the far denser table the generator produces.

import { beforeAll, describe, expect, it } from "vitest";
import { bytesToHex, type Fixture, hexToBytes, loadFixture } from "../../../testonly/fixtures.ts";
import { DefaultHasher, RFC6962LeafHashPrefix, RFC6962NodeHashPrefix } from "./rfc6962.ts";

interface RFC6962Fixture {
	readonly leafHashPrefix: number;
	readonly nodeHashPrefix: number;
	readonly hashSize: number;
	readonly emptyRoot: string;
	readonly hashLeaf: readonly { desc: string; leaf: string; want: string }[];
	readonly hashChildren: readonly { desc: string; left: string; right: string; want: string }[];
}

let f: Fixture<RFC6962Fixture>;

beforeAll(async () => {
	f = await loadFixture<RFC6962Fixture>("rfc6962");
});

describe("rfc6962 fixtures", () => {
	it("agrees on the domain separation prefixes and digest size", () => {
		expect(RFC6962LeafHashPrefix).toBe(f.leafHashPrefix);
		expect(RFC6962NodeHashPrefix).toBe(f.nodeHashPrefix);
		expect(DefaultHasher.size()).toBe(f.hashSize);
	});

	it("agrees on emptyRoot", () => {
		expect(bytesToHex(DefaultHasher.emptyRoot())).toBe(f.emptyRoot);
	});

	it("agrees on hashLeaf for every vector", () => {
		expect(f.hashLeaf.length).toBeGreaterThan(0);
		for (const tc of f.hashLeaf) {
			expect(bytesToHex(DefaultHasher.hashLeaf(hexToBytes(tc.leaf))), tc.desc).toBe(tc.want);
		}
	});

	it("agrees on hashChildren for every vector", () => {
		expect(f.hashChildren.length).toBeGreaterThan(0);
		for (const tc of f.hashChildren) {
			const got = DefaultHasher.hashChildren(hexToBytes(tc.left), hexToBytes(tc.right));
			expect(bytesToHex(got), tc.desc).toBe(tc.want);
		}
	});
});
