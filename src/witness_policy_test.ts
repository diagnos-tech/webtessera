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
import { errorAs, SentinelError } from "./internal/gostd/errors.ts";
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

// Port note: upstream's GroupN and "negative threshold" policies give w3 the same verifier key
// as w2. This port rejects that (docs/decisions/0184-witness-policy-rejects-ambiguous-quorums.md),
// so w3 carries a key of its own here; the thresholds under test are unchanged, and
// "rejects a second witness name for the same key" below keeps upstream's shape as a failure.
describe("TestNewWitnessGroupFromPolicy_GroupN", () => {
	const testCases: { desc: string; policy: string; wantN: number }[] = [
		{
			desc: "group numerical",
			policy: `
witness w1 sigsum.org+e4ade967+AZuUY6B08pW3QVHu8uvsrxWPcAv9nykap2Nb4oxCee+r https://sigsum.org/witness/
witness w2 example.com+3753d3de+AebBhMcghIUoavZpjuDofa4sW6fYHyVn7gvwDBfvkvuM https://example.com/witness/
witness w3 Wit3+d3ed3be7+ASb6Uz1+fxAcXkMvDd7nGa3FjDce7LxIKmbbTCT0MpVn https://example.com/witness/
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
witness w3 Wit3+d3ed3be7+ASb6Uz1+fxAcXkMvDd7nGa3FjDce7LxIKmbbTCT0MpVn https://example.com/witness/
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
witness w3 Wit3+d3ed3be7+ASb6Uz1+fxAcXkMvDd7nGa3FjDce7LxIKmbbTCT0MpVn https://example.com/witness/
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
					 witness w3 Wit3+d3ed3be7+ASb6Uz1+fxAcXkMvDd7nGa3FjDce7LxIKmbbTCT0MpVn https://example.com/witness/
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

// Port additions below: behaviour of NewWitnessGroupFromPolicy that upstream's tests do not
// reach, checked against Go's output for the same input where Go defines it.
const w1Key = "sigsum.org+e4ade967+AZuUY6B08pW3QVHu8uvsrxWPcAv9nykap2Nb4oxCee+r";
const w2Key = "example.com+3753d3de+AebBhMcghIUoavZpjuDofa4sW6fYHyVn7gvwDBfvkvuM";

function endpointsOf(policy: string): string[] {
	return [...newWitnessGroupFromPolicy(toUTF8(policy)).endpoints().keys()].sort();
}

function errorOf(policy: string): Error {
	try {
		newWitnessGroupFromPolicy(toUTF8(policy));
	} catch (err) {
		if (err instanceof Error) {
			return err;
		}
		throw err;
	}
	throw new Error("expected an error, got none");
}

describe("NewWitnessGroupFromPolicy white space (port additions)", () => {
	// Go splits lines with strings.TrimSpace/strings.Fields, i.e. Unicode White_Space, which is
	// not JavaScript's \s: U+FEFF is not white space, U+0085 is.
	it("does not strip a byte order mark, so the keyword is unknown, as in Go", () => {
		expect(errorOf("\ufefflog\nquorum none").message).toBe('unknown keyword: "\\ufefflog"');
	});

	it("treats U+0085 NEXT LINE as white space around and between fields", () => {
		expect(newWitnessGroupFromPolicy(toUTF8("\u0085log\u0085\nquorum\u0085none")).n).toBe(0);
	});

	it("treats U+00A0 and U+2028 as white space between fields", () => {
		const policy = `witness\u00a0w1\u2028${w1Key} https://sigsum.org/witness/\nquorum w1`;
		expect(endpointsOf(policy)).toEqual(["https://sigsum.org/witness/add-checkpoint"]);
	});
});

describe("NewWitnessGroupFromPolicy line length (port additions)", () => {
	// bufio.Scanner's default limit: a line, counting a \r before its newline, must be shorter
	// than 64 KiB, or the scan stops with bufio.ErrTooLong once it reaches that line.
	const comment = (n: number): string => `#${"x".repeat(n - 1)}`;

	it("accepts a line of 65535 bytes", () => {
		expect(newWitnessGroupFromPolicy(toUTF8(`${comment(65535)}\nquorum none\n`)).n).toBe(0);
	});

	it("rejects a line of 65536 bytes with Go's bufio.ErrTooLong text", () => {
		expect(errorOf(`${comment(65536)}\nquorum none\n`).message).toBe("bufio.Scanner: token too long");
	});

	it("counts the \\r of a \\r\\n line ending towards the limit", () => {
		expect(errorOf(`${comment(65535)}\r\nquorum none\n`).message).toBe("bufio.Scanner: token too long");
	});

	it("rejects an unterminated final line of 65536 bytes too", () => {
		expect(errorOf(`quorum none\n${comment(65536)}`).message).toBe("bufio.Scanner: token too long");
	});

	it("reports an error on an earlier line first, as the scanner yields lines in order", () => {
		expect(errorOf(`foo\n${comment(70000)}\nquorum none\n`).message).toBe('unknown keyword: "foo"');
	});
});

describe("NewWitnessGroupFromPolicy wrapped errors (port additions)", () => {
	// Go wraps these three with %w, so errors.Is/errors.As reach the underlying error.
	it("wraps the verifier error of an invalid witness config", () => {
		const err = errorOf("witness w1 bad-key https://sigsum.org/witness/\nquorum w1");
		expect(err.message).toBe(
			'invalid witness config "witness w1 bad-key https://sigsum.org/witness/": malformed verifier id',
		);
		// formats/note's errVerifierID is unexported there and here, so match it by type and text.
		expect(errorAs(err, SentinelError)?.message).toBe("malformed verifier id");
	});

	it("wraps the strconv error of an invalid threshold", () => {
		const err = errorOf(`witness w1 ${w1Key} https://sigsum.org/witness/\ngroup g 256 w1\nquorum g`);
		expect(err.message).toBe(
			'invalid threshold "256" for group "g": strconv.ParseUint: parsing "256": value out of range',
		);
		expect(err.cause).toBeInstanceOf(Error);
		expect((err.cause as Error).message).toBe('strconv.ParseUint: parsing "256": value out of range');
	});

	it("wraps the parse error of an invalid witness URL", () => {
		const err = errorOf(`witness w1 ${w1Key} http://[::1\nquorum w1`);
		expect(err.message).toBe(
			'invalid witness URL "http://[::1": parse "http://[::1": not an absolute URL with a "//" authority',
		);
		expect(err.cause).toBeInstanceOf(Error);
		expect((err.cause as Error).message).toBe('parse "http://[::1": not an absolute URL with a "//" authority');
	});
});

describe("NewWitnessGroupFromPolicy witness URLs (port additions)", () => {
	// Expected values are what Go's url.Parse(s).JoinPath("/add-checkpoint").String() returns. (A
	// fragment cannot be written in a policy, where "#" starts a comment; witness_test.ts covers
	// it through newWitness.)
	const tests: { desc: string; url: string; want: string }[] = [
		{
			desc: "keeps a default port",
			url: "https://example.com:443/x",
			want: "https://example.com:443/x/add-checkpoint",
		},
		{ desc: "keeps the host's case", url: "https://EXAMPLE.com/x", want: "https://EXAMPLE.com/x/add-checkpoint" },
		{ desc: "lower-cases the scheme", url: "HTTPS://example.com/x", want: "https://example.com/x/add-checkpoint" },
		{ desc: "adds a path to a bare host", url: "https://example.com", want: "https://example.com/add-checkpoint" },
		{ desc: "cleans the path", url: "https://example.com/a/../b//c/", want: "https://example.com/b/c/add-checkpoint" },
		{
			desc: "keeps escapes in the path",
			url: "https://example.com/%7Efoo",
			want: "https://example.com/%7Efoo/add-checkpoint",
		},
		{ desc: "keeps a query", url: "https://example.com/x?a=b", want: "https://example.com/x/add-checkpoint?a=b" },
		{
			desc: "keeps userinfo",
			url: "https://user:pw@example.com/x",
			want: "https://user:pw@example.com/x/add-checkpoint",
		},
		{ desc: "keeps an IPv6 host", url: "https://[::1]:8080/x", want: "https://[::1]:8080/x/add-checkpoint" },
	];
	for (const tc of tests) {
		it(tc.desc, () => {
			expect(endpointsOf(`witness w1 ${w1Key} ${tc.url}\nquorum w1`)).toEqual([tc.want]);
		});
	}

	// Go's url.Parse accepts a relative reference; this port requires an absolute URL.
	it("rejects a relative witness URL", () => {
		expect(errorOf(`witness w1 ${w1Key} not-a-url\nquorum w1`).message).toBe(
			'invalid witness URL "not-a-url": parse "not-a-url": not an absolute URL with a "//" authority',
		);
	});

	it("rejects a control character with Go's url.Parse error text", () => {
		expect(errorOf(`witness w1 ${w1Key} https://example.com/\u0001\nquorum w1`).message).toBe(
			'invalid witness URL "https://example.com/\\x01": parse "https://example.com/\\x01": net/url: invalid control character in URL',
		);
	});
});

// docs/decisions/0184-witness-policy-rejects-ambiguous-quorums.md
describe("NewWitnessGroupFromPolicy hardening (port additions)", () => {
	it("rejects a group that names the same child twice", () => {
		expect(errorOf(`witness w1 ${w1Key} https://sigsum.org/witness/\ngroup g 1 w1 w1\nquorum g`).message).toBe(
			'repeated component "w1" in group definition',
		);
	});

	it("rejects a second witness name for the same key", () => {
		const policy = `witness w2 ${w2Key} https://example.com/witness/\nwitness w3 ${w2Key} https://example.com/witness/\nquorum w2`;
		expect(errorOf(policy).message).toBe('witness "w3" has the same verifier key as witness "w2"');
	});

	it("rejects the same key under a different key name", () => {
		// The same Ed25519 public key as w1Key, published under another name (and so another key hash).
		const renamed = "other.example+1ba3a5f2+AZuUY6B08pW3QVHu8uvsrxWPcAv9nykap2Nb4oxCee+r";
		const policy = `witness w1 ${w1Key} https://sigsum.org/witness/\nwitness w2 ${renamed} https://other.example/\nquorum w1`;
		expect(errorOf(policy).message).toBe('witness "w2" has the same verifier key as witness "w1"');
	});

	it("rejects an explicit threshold of 0", () => {
		expect(errorOf(`witness w1 ${w1Key} https://sigsum.org/witness/\ngroup g 0 w1\nquorum g`).message).toBe(
			'invalid threshold "0" for group "g": must be at least 1',
		);
	});

	it("still accepts quorum none", () => {
		expect(newWitnessGroupFromPolicy(toUTF8("quorum none")).n).toBe(0);
	});
});

// docs/decisions/0185-witness-urls-require-https.md
describe("NewWitnessGroupFromPolicy witness URL schemes (port additions)", () => {
	const accepted = [
		"https://example.com/",
		"http://localhost:8080/",
		"http://127.0.0.1/",
		"http://127.9.8.7/",
		"http://[::1]/",
	];
	for (const u of accepted) {
		it(`accepts ${u}`, () => {
			expect(endpointsOf(`witness w1 ${w1Key} ${u}\nquorum w1`)).toHaveLength(1);
		});
	}

	const rejected = ["http://example.com/", "http://10.0.0.1/", "http://localhost.example.com/", "ftp://example.com/"];
	for (const u of rejected) {
		it(`rejects ${u}`, () => {
			const err = errorOf(`witness w1 ${w1Key} ${u}\nquorum w1`);
			expect(err.message).toContain("must use https (http is accepted only for a loopback host)");
		});
	}
});
