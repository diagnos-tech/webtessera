// Copyright 2021 Google LLC. All Rights Reserved.
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
// Ported from github.com/transparency-dev/formats/log/identifier_test.go
// @ v0.0.0-20251017110053-404c0d5b696c

import { describe, expect, it } from "vitest";
import { id } from "./identifier.ts";

describe("formats/log identifier", () => {
	describe("TestID", () => {
		const tests: Array<{ desc: string; origin: string; want: string }> = [
			{
				desc: "sumdb",
				origin: "go.sum database tree",
				want: "a32d071739c062f4973f1db8cc1069f517428d77105962b285bbf918c4062591",
			},
			{
				desc: "usbarmory",
				origin: "Armory Drive Prod 2",
				want: "48d31bf4bc3c95c7daddf7f8d33bb9ef1bff7500a40566eb56c97ff30eb6d44b",
			},
			{
				desc: "rekor 1",
				origin: "rekor.sigstore.dev - 2605736670972794746",
				want: "254283943e39c2a88e4d9185d4d7aa9f21afe369749872358204e8c25a00a80a",
			},
			{
				desc: "rekor 2",
				origin: "rekor.sigstore.dev - 3904496407287907110",
				want: "c43a5887c927e0594e0a5feb87c2311ec86c3367613001b40dec552473aaa5dc",
			},
			{
				desc: "rekor 3",
				origin: "rekor.sigstore.dev - 3904496407287907110",
				want: "c43a5887c927e0594e0a5feb87c2311ec86c3367613001b40dec552473aaa5dc",
			},
			{
				desc: "sigsum",
				origin: "sigsum.org/v1/tree/44ad38f8226ff9bd27629a41e55df727308d0a1cd8a2c31d3170048ac1dd22a1",
				want: "e5a19e2a99bc3fe4968b64bedaf64e43a9888e485320746cc46ade52ea33a328",
			},
		];

		for (const test of tests) {
			it(test.desc, () => {
				expect(id(test.origin)).toBe(test.want);
			});
		}
	});

	// Beyond upstream: the origin is hashed as UTF-8, so a non-ASCII origin must not
	// go through a code-unit-at-a-time conversion.
	it("hashes a non-ASCII origin as UTF-8", () => {
		// `printf 'o:árvore' | sha256sum` — 9 bytes in, not 8.
		expect(id("árvore")).toBe("35cf17c3078118ccb8dc24a6d0ad6288cd3c4e349160eea171b83ec7c3f50f09");
		// The literal output of `log.ID` under Go 1.25.5 for the same origin.
		expect(id("árvore/exames")).toBe("1450a531ff803743add12971d32e7a3c6397fbe98b85252d8cec9daa1935e081");
	});

	// Beyond upstream (ADR-0203): an origin UTF-8 cannot encode is refused, rather than
	// hashed as U+FFFD and given the ID of the origin that really holds U+FFFD.
	it("refuses an origin with an unpaired surrogate", () => {
		for (const origin of ["\ud800", "log\udfff", "a\ud800b"]) {
			expect(() => id(origin)).toThrow("origin is not valid UTF-8");
		}
		expect(id("\ufffd")).toMatch(/^[0-9a-f]{64}$/);
		expect(id("\u{1f332}")).toBe(id("\ud83c\udf32"));
	});
});
