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

// Tests for the bufio.Scanner stand-in. The expected values are what Go's
// `bufio.NewScanner(bytes.NewReader(p))` produces for the same input under Go 1.25.

import { describe, expect, it } from "vitest";
import { ErrTooLong, MaxScanTokenSize, Scanner } from "./bufio.ts";
import { toUTF8 } from "./bytes.ts";

/** lines scans s to the end and returns every line and the final error. */
function lines(s: string | Uint8Array): { lines: string[]; err: Error | undefined } {
	const sc = new Scanner(typeof s === "string" ? toUTF8(s) : s);
	const out: string[] = [];
	while (sc.scan()) {
		out.push(sc.text());
	}
	return { lines: out, err: sc.err() };
}

describe("gostd/bufio Scanner", () => {
	const tests: { name: string; in: string; want: string[] }[] = [
		{ name: "empty input", in: "", want: [] },
		{ name: "one terminated line", in: "a\n", want: ["a"] },
		{ name: "final line without newline", in: "a\nb", want: ["a", "b"] },
		{ name: "empty lines are lines", in: "\n\na\n\n", want: ["", "", "a", ""] },
		{ name: "CR before LF is dropped", in: "a\r\nb\r\n", want: ["a", "b"] },
		{ name: "CR on an unterminated final line is dropped", in: "a\r", want: ["a"] },
		{ name: "only one CR is dropped", in: "a\r\r\n", want: ["a\r"] },
		{ name: "CR elsewhere is kept", in: "a\rb\n", want: ["a\rb"] },
		{ name: "a lone CR line is empty", in: "\r\n", want: [""] },
	];
	for (const tt of tests) {
		it(tt.name, () => {
			expect(lines(tt.in)).toEqual({ lines: tt.want, err: undefined });
		});
	}

	it("accepts a line one byte shorter than MaxScanTokenSize", () => {
		const long = "a".repeat(MaxScanTokenSize - 1);
		expect(lines(`${long}\nb\n`)).toEqual({ lines: [long, "b"], err: undefined });
		expect(lines(long)).toEqual({ lines: [long], err: undefined });
	});

	it("stops with ErrTooLong at a line of MaxScanTokenSize bytes, after the lines before it", () => {
		expect(lines(`x\n${"a".repeat(MaxScanTokenSize)}\ny\n`)).toEqual({ lines: ["x"], err: ErrTooLong });
		expect(lines(`x\n${"a".repeat(MaxScanTokenSize)}`)).toEqual({ lines: ["x"], err: ErrTooLong });
	});

	it("counts a CR before the newline towards the limit", () => {
		expect(lines(`${"a".repeat(MaxScanTokenSize - 1)}\r\n`)).toEqual({ lines: [], err: ErrTooLong });
	});

	it("returns the empty token once the scan has stopped, and stays stopped", () => {
		const sc = new Scanner(toUTF8("a\n"));
		expect(sc.scan()).toBe(true);
		expect(sc.text()).toBe("a");
		expect(sc.scan()).toBe(false);
		expect(sc.text()).toBe("");
		expect(sc.bytes()).toEqual(new Uint8Array(0));
		expect(sc.scan()).toBe(false);
		expect(sc.err()).toBeUndefined();
	});

	it("returns views of the input from bytes(), without decoding them", () => {
		const input = new Uint8Array([0xff, 0x0a, 0x61]);
		const sc = new Scanner(input);
		expect(sc.scan()).toBe(true);
		expect(sc.bytes()).toEqual(new Uint8Array([0xff]));
		expect(sc.bytes().buffer).toBe(input.buffer);
		expect(sc.text()).toBe("�");
	});
});
