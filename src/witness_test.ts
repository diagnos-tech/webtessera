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
// Ported from tessera/witness_test.go @ 4a6d9f9, part of Tessera (Apache-2.0, see NOTICE).
//
// Copyright note: upstream's witness_test.go carries no copyright or licence header, so, per
// AGENTS.md §9 ("keep the upstream copyright year and holder exactly as the original file has
// it"), none is invented for it here; see
// docs/decisions/0187-witness-test-header-follows-upstream.md.
//
// Port note: BenchmarkWitnessGroupSatisfaction is not ported -- see
// docs/decisions/0034-go-benchmarks-not-ported.md.

import { describe, expect, it } from "vitest";
import { newSignerForCosignatureV1 } from "./vendor/formats/note/note_cosigv1.ts";
import { type Signer, sign } from "./vendor/note/note.ts";
import { newWitness, newWitnessGroup, WitnessGroup } from "./witness.ts";

const wit1_vkey = "Wit1+55ee4561+AVhZSmQj9+SoL+p/nN0Hh76xXmF7QcHfytUrI1XfSClk";
const wit1_skey = "PRIVATE+KEY+Wit1+55ee4561+AeadRiG7XM4XiieCHzD8lxysXMwcViy5nYsoXURWGrlE";
const wit2_vkey = "Wit2+85ecc407+AWVbwFJte9wMQIPSnEnj4KibeO6vSIOEDUTDp3o63c2x";
const wit2_skey = "PRIVATE+KEY+Wit2+85ecc407+AfPTvxw5eUcqSgivo2vaiC7JPOMUZ/9baHPSDrWqgdGm";
const wit3_vkey = "Wit3+d3ed3be7+ASb6Uz1+fxAcXkMvDd7nGa3FjDce7LxIKmbbTCT0MpVn";
const wit3_skey = "PRIVATE+KEY+Wit3+d3ed3be7+AR2Kg8k6ccBr5QXz5SHtnkOS4UGQGEQaWi6Gfr6Mm3X5";

const bastion = new URL("https://b1.example.com/");
const directURL = new URL("https://witness.example.com/");
// Port note: Go builds these roots with bastion.JoinPath("wit1prefix"). The platform URL type
// has no JoinPath, and newWitness takes one of its values, so they are built by resolving the
// relative reference against bastion instead. For a root that ends in "/" and a single
// segment the two give the same URL, https://b1.example.com/wit1prefix, as Go's do.
const wit1 = newWitness(wit1_vkey, new URL("wit1prefix", bastion));
const wit2 = newWitness(wit2_vkey, new URL("wit2prefix", bastion));
const wit3 = newWitness(wit3_vkey, directURL);
const wit1Sign: Signer = newSignerForCosignatureV1(wit1_skey);
const wit2Sign: Signer = newSignerForCosignatureV1(wit2_skey);
const wit3Sign: Signer = newSignerForCosignatureV1(wit3_skey);

describe("TestWitnessGroup_Empty", () => {
	it("empty group is satisfied and has no URLs", () => {
		const group = new WitnessGroup();
		expect(group.satisfied(new TextEncoder().encode("definitely a checkpoint\n"))).toBe(true);
		expect(group.endpoints().size).toBe(0);
	});
});

describe("TestWitnessGroup_Satisfied", () => {
	const testCases: { desc: string; group: WitnessGroup; signers: Signer[]; expectSatisfied: boolean }[] = [
		{
			desc: "One witness, required and provided",
			group: newWitnessGroup(1, wit1),
			signers: [wit1Sign],
			expectSatisfied: true,
		},
		{
			desc: "One witness, required and not provided",
			group: newWitnessGroup(1, wit1),
			signers: [],
			expectSatisfied: false,
		},
		{
			desc: "One witness, optional and provided",
			group: newWitnessGroup(0, wit1),
			signers: [wit1Sign],
			expectSatisfied: true,
		},
		{
			desc: "One witness, optional and not provided",
			group: newWitnessGroup(0, wit1),
			signers: [],
			expectSatisfied: true,
		},
		{
			desc: "One witness, required and provided, in required subgroup",
			group: newWitnessGroup(1, newWitnessGroup(1, wit1)),
			signers: [wit1Sign],
			expectSatisfied: true,
		},
		{
			desc: "One witness, required and provided, in optional subgroup",
			group: newWitnessGroup(0, newWitnessGroup(1, wit1)),
			signers: [wit1Sign],
			expectSatisfied: true,
		},
		{
			desc: "One witness, required and not provided, in required subgroup",
			group: newWitnessGroup(1, newWitnessGroup(1, wit1)),
			signers: [],
			expectSatisfied: false,
		},
		{
			desc: "One witness, required and not provided, in optional subgroup",
			group: newWitnessGroup(0, newWitnessGroup(1, wit1)),
			signers: [],
			expectSatisfied: true,
		},
		{
			desc: "One required, one of two required, all provided",
			group: newWitnessGroup(2, wit1, newWitnessGroup(1, wit2, wit3)),
			signers: [wit1Sign, wit2Sign, wit3Sign],
			expectSatisfied: true,
		},
		{
			desc: "One required, one of two required, min provided",
			group: newWitnessGroup(2, wit1, newWitnessGroup(1, wit2, wit3)),
			signers: [wit1Sign, wit2Sign],
			expectSatisfied: true,
		},
		{
			desc: "One required, one of two required, only first group satisfied",
			group: newWitnessGroup(2, wit1, newWitnessGroup(1, wit2, wit3)),
			signers: [wit1Sign],
			expectSatisfied: false,
		},
		{
			desc: "One required, one of two required, only second group satisfied",
			group: newWitnessGroup(2, wit1, newWitnessGroup(1, wit2, wit3)),
			signers: [wit2Sign, wit3Sign],
			expectSatisfied: false,
		},
	];

	for (const tC of testCases) {
		it(tC.desc, () => {
			// The body needs to be 3 lines to meet the cosigner expectations.
			const cp = sign({ text: "sign me\nI'm a\nnote\n" }, ...tC.signers);
			expect(tC.group.satisfied(cp)).toBe(tC.expectSatisfied);
		});
	}
});

describe("TestWitnessGroup_URLs", () => {
	const testCases: { desc: string; group: WitnessGroup; expectedURLs: string[] }[] = [
		{
			desc: "witness 1",
			group: newWitnessGroup(1, wit1),
			expectedURLs: ["https://b1.example.com/wit1prefix/add-checkpoint"],
		},
		{
			desc: "witness 2",
			group: newWitnessGroup(1, wit2),
			expectedURLs: ["https://b1.example.com/wit2prefix/add-checkpoint"],
		},
		{
			desc: "witness 3",
			group: newWitnessGroup(1, wit3),
			expectedURLs: ["https://witness.example.com/add-checkpoint"],
		},
		{
			desc: "all witnesses in one group",
			group: newWitnessGroup(1, wit1, wit2, wit3),
			expectedURLs: [
				"https://b1.example.com/wit1prefix/add-checkpoint",
				"https://b1.example.com/wit2prefix/add-checkpoint",
				"https://witness.example.com/add-checkpoint",
			],
		},
		{
			desc: "all witnesses with duplicates in nests",
			group: newWitnessGroup(2, newWitnessGroup(1, wit1, wit2), newWitnessGroup(1, wit1, wit3)),
			expectedURLs: [
				"https://b1.example.com/wit1prefix/add-checkpoint",
				"https://b1.example.com/wit2prefix/add-checkpoint",
				"https://witness.example.com/add-checkpoint",
			],
		},
	];

	for (const tC of testCases) {
		it(tC.desc, () => {
			const gotURLs = [...tC.group.endpoints().keys()].sort();
			const wantURLs = [...tC.expectedURLs].sort();
			expect(gotURLs).toEqual(wantURLs);
		});
	}
});

// Port additions: newWitness's handling of the root URL it is given.
describe("newWitness (port additions)", () => {
	it("keeps a fragment after the joined path, as Go's JoinPath and String do", () => {
		const w = newWitness(wit1_vkey, new URL("https://example.com/x#frag"));
		expect(w.url).toBe("https://example.com/x/add-checkpoint#frag");
	});

	// docs/decisions/0185-witness-urls-require-https.md
	const accepted = ["https://example.com/", "http://localhost/", "http://127.0.0.1:8080/", "http://[::1]/"];
	for (const u of accepted) {
		it(`accepts ${u}`, () => {
			expect(newWitness(wit1_vkey, new URL(u)).url.endsWith("/add-checkpoint")).toBe(true);
		});
	}

	const rejected = ["http://example.com/", "http://192.168.1.1/", "ws://localhost/", "file:///tmp/witness"];
	for (const u of rejected) {
		it(`rejects ${u}`, () => {
			expect(() => newWitness(wit1_vkey, new URL(u))).toThrow(
				"must use https (http is accepted only for a loopback host)",
			);
		});
	}
});
