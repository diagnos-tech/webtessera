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
// Ported from github.com/transparency-dev/formats/log/checkpoint_test.go
// @ v0.0.0-20251017110053-404c0d5b696c

import { describe, expect, it } from "vitest";
import { bytesEqual, concatBytes, fromUTF8, toUTF8 } from "../../../internal/gostd/bytes.ts";
import { wrapError } from "../../../internal/gostd/errors.ts";
import { parseUint } from "../../../internal/gostd/strconv.ts";
import { Checkpoint } from "./checkpoint.ts";

/** checkpointEq is the stand-in for cmp.Diff over a log.Checkpoint. */
function checkpointEq(got: Checkpoint, want: Checkpoint): void {
	expect(got.origin).toBe(want.origin);
	expect(got.size).toBe(want.size);
	expect(bytesEqual(got.hash, want.hash), `hash: got ${got.hash} want ${want.hash}`).toBe(true);
}

describe("formats/log checkpoint", () => {
	describe("TestMarshal", () => {
		const tests: Array<{ c: Checkpoint; want: string }> = [
			{
				c: new Checkpoint({ origin: "Log", size: 123n, hash: toUTF8("bananas") }),
				want: "Log\n123\nYmFuYW5hcw==\n",
			},
			{
				c: new Checkpoint({
					origin: "Banana",
					size: 9944n,
					hash: toUTF8("the view from the tree tops is great!"),
				}),
				want: "Banana\n9944\ndGhlIHZpZXcgZnJvbSB0aGUgdHJlZSB0b3BzIGlzIGdyZWF0IQ==\n",
			},
		];
		for (const test of tests) {
			it(fromUTF8(test.c.hash), () => {
				expect(fromUTF8(test.c.marshal())).toBe(test.want);
			});
		}

		// Beyond upstream: the origin is text and the size is uint64. This vector is
		// the literal output of `log.Checkpoint.Marshal` under Go 1.25.5 for a
		// non-ASCII origin at math.MaxUint64, which is where a UTF-16 conversion or a
		// `number` size would both give the wrong bytes.
		it("marshals a non-ASCII origin at MaxUint64 byte-identically to Go", () => {
			const c = new Checkpoint({
				origin: "árvore/exames",
				size: 18446744073709551615n,
				hash: toUTF8("it's a root hash"),
			});
			expect(fromUTF8(c.marshal())).toBe("árvore/exames\n18446744073709551615\naXQncyBhIHJvb3QgaGFzaA==\n");
		});

		it("round-trips that checkpoint through unmarshal", () => {
			const got = new Checkpoint();
			const rest = got.unmarshal(toUTF8("árvore/exames\n18446744073709551615\naXQncyBhIHJvb3QgaGFzaA==\n"));
			expect(rest).toBeUndefined();
			expect(got.origin).toBe("árvore/exames");
			expect(got.size).toBe(18446744073709551615n);
			expect(fromUTF8(got.hash)).toBe("it's a root hash");
		});
	});

	describe("TestUnmarshalLogState", () => {
		const tests: Array<{
			desc: string;
			m: string;
			want: Checkpoint;
			wantRest?: Uint8Array;
			wantErr?: boolean;
		}> = [
			{
				desc: "valid one",
				m: "Log\n123\nYmFuYW5hcw==\n",
				want: new Checkpoint({ origin: "Log", size: 123n, hash: toUTF8("bananas") }),
			},
			{
				desc: "valid with different origin",
				m: "Banana\n9944\ndGhlIHZpZXcgZnJvbSB0aGUgdHJlZSB0b3BzIGlzIGdyZWF0IQ==\n",
				want: new Checkpoint({
					origin: "Banana",
					size: 9944n,
					hash: toUTF8("the view from the tree tops is great!"),
				}),
			},
			{
				desc: "valid with trailing data",
				m: "Log\n9944\ndGhlIHZpZXcgZnJvbSB0aGUgdHJlZSB0b3BzIGlzIGdyZWF0IQ==\nHere's some associated data.\n",
				want: new Checkpoint({
					origin: "Log",
					size: 9944n,
					hash: toUTF8("the view from the tree tops is great!"),
				}),
				wantRest: toUTF8("Here's some associated data.\n"),
			},
			{
				desc: "valid with multiple trailing data lines",
				m: "Log\n9944\ndGhlIHZpZXcgZnJvbSB0aGUgdHJlZSB0b3BzIGlzIGdyZWF0IQ==\nlots\nof\nlines\n",
				want: new Checkpoint({
					origin: "Log",
					size: 9944n,
					hash: toUTF8("the view from the tree tops is great!"),
				}),
				wantRest: toUTF8("lots\nof\nlines\n"),
			},
			{
				desc: "valid with trailing newlines",
				m: "Log\n9944\ndGhlIHZpZXcgZnJvbSB0aGUgdHJlZSB0b3BzIGlzIGdyZWF0IQ==\n\n\n\n",
				want: new Checkpoint({
					origin: "Log",
					size: 9944n,
					hash: toUTF8("the view from the tree tops is great!"),
				}),
				wantRest: toUTF8("\n\n\n"),
			},
			{ desc: "invalid - insufficient lines", m: "Head\n9944\n", want: new Checkpoint(), wantErr: true },
			{
				desc: "invalid - empty header",
				m: "\n9944\ndGhlIHZpZXcgZnJvbSB0aGUgdHJlZSB0b3BzIGlzIGdyZWF0IQ==\n",
				want: new Checkpoint(),
				wantErr: true,
			},
			{
				desc: "invalid - missing newline on roothash",
				m: "Log\n123\nYmFuYW5hcw==",
				want: new Checkpoint(),
				wantErr: true,
			},
			{
				desc: "invalid size - not a number",
				m: "Log\nbananas\ndGhlIHZpZXcgZnJvbSB0aGUgdHJlZSB0b3BzIGlzIGdyZWF0IQ==\n",
				want: new Checkpoint(),
				wantErr: true,
			},
			{
				desc: "invalid size - negative",
				m: "Log\n-34\ndGhlIHZpZXcgZnJvbSB0aGUgdHJlZSB0b3BzIGlzIGdyZWF0IQ==\n",
				want: new Checkpoint(),
				wantErr: true,
			},
			{
				desc: "invalid size - too large",
				m: "Log\n3438945738945739845734895735\ndGhlIHZpZXcgZnJvbSB0aGUgdHJlZSB0b3BzIGlzIGdyZWF0IQ==\n",
				want: new Checkpoint(),
				wantErr: true,
			},
			{
				desc: "invalid roothash - not base64",
				m: "Log\n123\nThisIsn'tBase64\n",
				want: new Checkpoint(),
				wantErr: true,
			},
		];

		for (const test of tests) {
			it(test.desc, () => {
				const got = new Checkpoint();
				let gotRest: Uint8Array | undefined;
				let gotErr = false;
				try {
					gotRest = got.unmarshal(toUTF8(test.m));
				} catch {
					gotErr = true;
				}
				expect(gotErr, "unmarshal error").toBe(test.wantErr === true);
				checkpointEq(got, test.want);
				expect(
					bytesEqual(gotRest ?? new Uint8Array(0), test.wantRest ?? new Uint8Array(0)),
					`got rest ${JSON.stringify(fromUTF8(gotRest ?? new Uint8Array(0)))}`,
				).toBe(true);
			});
		}
	});

	////////////////////////////////////////////////////////////////////////////////
	// Below is an example of embedding the minimal checkpoint as one way to extend
	// it to include additional ecosystem-specific data.
	// Reimplementing parsing of the full extended structure would be fine too.

	it("TestExtendCheckpoint", () => {
		const raw = "Moon Log\n4027504\naXQncyBhIHJvb3QgaGFzaA==\n6086d1a9\nWaxing gibbous\n";
		const want = new moonLogCheckpoint({
			origin: "Moon Log",
			size: 4027504n,
			hash: toUTF8("it's a root hash"),
		});
		want.timestamp = 0x6086d1a9n;
		want.phase = "Waxing gibbous";

		const got = new moonLogCheckpoint();
		got.unmarshalMoon(toUTF8(raw));

		checkpointEq(got, want);
		expect(got.timestamp).toBe(want.timestamp);
		expect(got.phase).toBe(want.phase);
	});

	it("TestExtendRoundTrip", () => {
		const want = new moonLogCheckpoint({
			origin: "Moon Log",
			size: 4027504n,
			hash: toUTF8("it's a root hash"),
		});
		want.timestamp = 0x6086d1a9n;
		want.phase = "Waxing gibbous";

		const got = new moonLogCheckpoint();
		got.unmarshalMoon(want.marshal());

		checkpointEq(got, want);
		expect(got.timestamp).toBe(want.timestamp);
		expect(got.phase).toBe(want.phase);
	});
});

// Not upstream: the port's additional Checkpoint checks.
describe("Checkpoint hardening", () => {
	// docs/decisions/0203-checkpoint-origin-must-be-utf8.md
	it("rejects an origin line that is not valid UTF-8, after upstream's own checks", () => {
		const raw = concatBytes(new Uint8Array([0x4c, 0x6f, 0x67, 0xff]), toUTF8("\n123\nYmFuYW5hcw==\n"));
		const got = new Checkpoint();
		expect(() => got.unmarshal(raw)).toThrow(new Error("invalid checkpoint - origin is not valid UTF-8"));
		checkpointEq(got, new Checkpoint());
		// Upstream's errors keep their precedence.
		const badSize = concatBytes(new Uint8Array([0xff]), toUTF8("\nbananas\nYmFuYW5hcw==\n"));
		expect(() => new Checkpoint().unmarshal(badSize)).toThrow(
			'invalid checkpoint - size invalid: strconv.ParseUint: parsing "bananas": invalid syntax',
		);
		// Valid multi-byte UTF-8 is fine.
		const ok = new Checkpoint();
		ok.unmarshal(toUTF8("Lög/日本\n1\nYmFuYW5hcw==\n"));
		expect(ok.origin).toBe("Lög/日本");
	});

	it("refuses to marshal an origin UTF-8 cannot encode", () => {
		expect(() => new Checkpoint({ origin: "Log\ud800", size: 1n }).marshal()).toThrow(
			new Error("invalid checkpoint - origin is not valid UTF-8"),
		);
	});

	// docs/decisions/0207-uint64-domain-guards.md
	it("rejects a size outside the uint64 range", () => {
		expect(() => new Checkpoint({ origin: "Log", size: -1n })).toThrow(RangeError);
		expect(() => new Checkpoint({ origin: "Log", size: 1n << 64n })).toThrow(RangeError);
		const cp = new Checkpoint({ origin: "Log", size: 1n });
		cp.size = -1n;
		expect(() => cp.marshal()).toThrow(RangeError);
		const max = new Checkpoint({ origin: "Log", size: (1n << 64n) - 1n });
		expect(fromUTF8(max.marshal())).toBe("Log\n18446744073709551615\n\n");
	});
});

////////////////////////////////////////////////////////////////////////////////
// Below is an example of embedding the minimal checkpoint as one way to extend
// it to include additional ecosystem-specific data.
// Reimplementing parsing of the full extended structure would be fine too.

/**
 * moonLogCheckpoint is a hypothetical checkpoint for an ecosystem which requires
 * its checkpoints to commit to more data than the minimum common checkpoint does.
 *
 * Port note: Go embeds log.Checkpoint, so moonLogCheckpoint.Marshal shadows the
 * embedded method while still being able to call it. TypeScript's `extends` gives
 * the same shape via `super.marshal()`. Unmarshal cannot be overridden the same way
 * because it has a different return type from the base method, so the extended
 * parser is named unmarshalMoon.
 */
class moonLogCheckpoint extends Checkpoint {
	timestamp = 0n;
	phase = "";

	/**
	 * Marshal knows how to marshal the moon log data checkpoint.
	 * It delegates to the embedded Checkedpoint to marshal itself first, before
	 * marshalling the Moon ecosystem specific checkpoint data.
	 */
	override marshal(): Uint8Array {
		return concatBytes(super.marshal(), toUTF8(`${this.timestamp.toString(16)}\n${this.phase}\n`));
	}

	/**
	 * Unmarshal knows how to unmarshal the moon log data.
	 * It delegates to the embedded Checkpoint to unmarshal itself first, before
	 * attempting to unmarshal the Moon ecosystem specific data.
	 *
	 * Port note: named unmarshalMoon; see the class comment.
	 */
	unmarshalMoon(data: Uint8Array): void {
		const delim = "\n";
		const rest = this.unmarshal(data);
		const trimmed = fromUTF8(rest ?? new Uint8Array(0)).replace(/\n+$/, "");
		const l = trimmed.split(delim);
		if (l.length !== 2) {
			throw new Error(`want 2 lines of other data, got ${l.length}`);
		}
		let ts: bigint;
		try {
			ts = parseUint(l[0] ?? "", 16, 64);
		} catch (err) {
			throw wrapError("failed to parse timestamp", err);
		}
		this.timestamp = ts;
		this.phase = l[1] ?? "";
	}
}
