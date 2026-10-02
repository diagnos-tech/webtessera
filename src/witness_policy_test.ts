// Copyright 2025 The Tessera authors. All Rights Reserved.
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
// Ported from tessera/witness_policy_test.go @ 4a6d9f9

import { describe, expect, it } from "vitest";
import { toUTF8 } from "./internal/gostd/bytes.ts";
import { newWitnessGroupFromPolicy } from "./witness.ts";

describe("TestNewWitnessGroupFromPolicy", () => {
	const tests: { name: string; policy: string }[] = [
		{
			name: "tidy",
			policy: `
witness w1 sigsum.org+e4ade967+AZuUY6B08pW3QVHu8uvsrxWPcAv9nykap2Nb4oxCee+r https://sigsum.org/witness/
witness w2 example.com+3753d3de+AebBhMcghIUoavZpjuDofa4sW6fYHyVn7gvwDBfvkvuM https://example.com/witness/
group g1 all w1 w2
quorum g1
`,
		},
		{
			name: "whitespace and comments",
			policy: `

# comment
witness   w1      sigsum.org+e4ade967+AZuUY6B08pW3QVHu8uvsrxWPcAv9nykap2Nb4oxCee+r     https://sigsum.org/witness/    #comment
  witness w2            example.com+3753d3de+AebBhMcghIUoavZpjuDofa4sW6fYHyVn7gvwDBfvkvuM    https://example.com/witness/


			     #comment
group      g1    all     w1  w2

		 quorum      g1
`,
		},
	];

	for (const test of tests) {
		it(test.name, () => {
			const wg = newWitnessGroupFromPolicy(toUTF8(test.policy));

			expect(wg.n).toBe(2);
			expect(wg.components).toHaveLength(2);
		});
	}
});

describe("TestNewWitnessGroupFromPolicy_GroupN", () => {
	const testCases: { desc: string; policy: string; wantN: number }[] = [
		{
			desc: "group numerical",
			policy: `
witness w1 sigsum.org+e4ade967+AZuUY6B08pW3QVHu8uvsrxWPcAv9nykap2Nb4oxCee+r https://sigsum.org/witness/
witness w2 example.com+3753d3de+AebBhMcghIUoavZpjuDofa4sW6fYHyVn7gvwDBfvkvuM https://example.com/witness/
witness w3 example.com+3753d3de+AebBhMcghIUoavZpjuDofa4sW6fYHyVn7gvwDBfvkvuM https://example.com/witness/
witness w4 remora.n621.de+da77ade7+BOvN63jn/bLvkieywe8R6UYAtVtNbZpXh34x7onlmtw2 https://example.com/remora
group g1 2 w1 w2 w3 w4
quorum g1
`,
			wantN: 2,
		},
		{
			desc: "group all",
			policy: `
witness w1 sigsum.org+e4ade967+AZuUY6B08pW3QVHu8uvsrxWPcAv9nykap2Nb4oxCee+r https://sigsum.org/witness/
witness w2 example.com+3753d3de+AebBhMcghIUoavZpjuDofa4sW6fYHyVn7gvwDBfvkvuM https://example.com/witness/
witness w3 example.com+3753d3de+AebBhMcghIUoavZpjuDofa4sW6fYHyVn7gvwDBfvkvuM https://example.com/witness/
group g1 all w1 w2 w3
quorum g1
`,
			wantN: 3,
		},
		{
			desc: "group any",
			policy: `
witness w1 sigsum.org+e4ade967+AZuUY6B08pW3QVHu8uvsrxWPcAv9nykap2Nb4oxCee+r https://sigsum.org/witness/
witness w2 example.com+3753d3de+AebBhMcghIUoavZpjuDofa4sW6fYHyVn7gvwDBfvkvuM https://example.com/witness/
witness w3 example.com+3753d3de+AebBhMcghIUoavZpjuDofa4sW6fYHyVn7gvwDBfvkvuM https://example.com/witness/
group g1 any w1
quorum g1
`,
			wantN: 1,
		},
	];

	for (const tc of testCases) {
		it(tc.desc, () => {
			const wg = newWitnessGroupFromPolicy(toUTF8(tc.policy));
			expect(wg.n).toBe(tc.wantN);
		});
	}
});

describe("TestNewWitnessGroupFromPolicy_Errors", () => {
	const testCases: { desc: string; policy: string; errStr: string }[] = [
		{
			desc: "no quorum",
			policy: "witness w1 sigsum.org+e4ade967+AZuUY6B08pW3QVHu8uvsrxWPcAv9nykap2Nb4oxCee+r https://sigsum.org/witness/",
			errStr: "policy file must define a quorum",
		},
		{
			desc: "unknown quorum component",
			policy: "quorum unknown",
			errStr: 'quorum component "unknown" not found',
		},
		{
			desc: "duplicate component name",
			policy:
				"witness w1 sigsum.org+e4ade967+AZuUY6B08pW3QVHu8uvsrxWPcAv9nykap2Nb4oxCee+r https://sigsum.org/witness/\nwitness w1 sigsum.org+e4ade967+AZuUY6B08pW3QVHu8uvsrxWPcAv9nykap2Nb4oxCee+r https://sigsum.org/witness/\nquorum w1",
			errStr: "duplicate component name",
		},
		{
			desc: "negative threshold",
			policy: `witness w1 sigsum.org+e4ade967+AZuUY6B08pW3QVHu8uvsrxWPcAv9nykap2Nb4oxCee+r https://sigsum.org/witness/
					 witness w2 example.com+3753d3de+AebBhMcghIUoavZpjuDofa4sW6fYHyVn7gvwDBfvkvuM https://example.com/witness/
					 witness w3 example.com+3753d3de+AebBhMcghIUoavZpjuDofa4sW6fYHyVn7gvwDBfvkvuM https://example.com/witness/
					 group g1 -1 w1
					 quorum g1`,
			errStr: "invalid threshold",
		},
		{
			desc: "witness name is keyword",
			policy:
				"witness all sigsum.org+e4ade967+AZuUY6B08pW3QVHu8uvsrxWPcAv9nykap2Nb4oxCee+r https://sigsum.org/witness/",
			errStr: "invalid witness name",
		},
		{
			desc: "witness name is keyword",
			policy: "group none 1 witness",
			errStr: "invalid group name",
		},
	];

	for (const tc of testCases) {
		it(tc.desc, () => {
			expect(() => newWitnessGroupFromPolicy(toUTF8(tc.policy))).toThrow(tc.errStr);
		});
	}
});
