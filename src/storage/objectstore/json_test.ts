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

// Tests for the treeState/gcState codec. The expected encodings and error texts are what
// Go 1.24's encoding/json produces for the same structs (`json.Marshal(treeState{...})`,
// `json.Unmarshal(raw, &treeState{})`), recorded by running a small Go program; the cases
// where this decoder is deliberately stricter than Go are listed separately, see
// docs/decisions/0102-objectstore-state-json-encoding.md.

import { describe, expect, it } from "vitest";
import { fromUTF8, toUTF8 } from "../../internal/gostd/bytes.ts";
import { DefaultHasher } from "../../vendor/merkle/rfc6962/rfc6962.ts";
import { marshalGCState, marshalTreeState, unmarshalGCState, unmarshalTreeState } from "./json.ts";

const maxUint64 = (1n << 64n) - 1n;

describe("marshalTreeState", () => {
	const tests: { name: string; size: bigint; root: Uint8Array; want: string }[] = [
		{
			name: "empty tree",
			size: 0n,
			root: DefaultHasher.emptyRoot(),
			want: '{"size":0,"root":"47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="}',
		},
		{ name: "TestPublishTree's fake root", size: 1n, root: toUTF8("root)"), want: '{"size":1,"root":"cm9vdCk="}' },
		{
			name: "MaxUint64 survives without float rounding",
			size: maxUint64,
			root: new Uint8Array([0xff, 0xfe]),
			want: '{"size":18446744073709551615,"root":"//4="}',
		},
		{ name: "empty root", size: 7n, root: new Uint8Array(0), want: '{"size":7,"root":""}' },
	];
	for (const test of tests) {
		it(test.name, () => {
			expect(fromUTF8(marshalTreeState({ size: test.size, root: test.root }))).toBe(test.want);
		});
	}
});

describe("marshalGCState", () => {
	it("encodes like Go", () => {
		expect(fromUTF8(marshalGCState({ fromSize: maxUint64 }))).toBe('{"fromSize":18446744073709551615}');
		expect(fromUTF8(marshalGCState({ fromSize: 0n }))).toBe('{"fromSize":0}');
	});
});

describe("unmarshalTreeState: inputs Go accepts", () => {
	const tests: { name: string; in: string; size: bigint; root: number[] }[] = [
		{ name: "compact", in: '{"size":1,"root":"AQ=="}', size: 1n, root: [1] },
		{ name: "Go's encoding of a nil root", in: '{"size":5000,"root":null}', size: 5000n, root: [] },
		{
			name: "unknown fields are skipped, whatever their type",
			in: '{"size":1,"root":"AQ==","extra":{"a":[1,true,null]}}',
			size: 1n,
			root: [1],
		},
		{
			name: "whitespace, and newlines inside base64",
			in: ' { "size" : 1 , "root" : "A\\nQ==" } ',
			size: 1n,
			root: [1],
		},
		{ name: "MaxUint64", in: '{"root":"","size":18446744073709551615}', size: maxUint64, root: [] },
	];
	for (const test of tests) {
		it(test.name, () => {
			const got = unmarshalTreeState(toUTF8(test.in));
			expect(got.size).toBe(test.size);
			expect([...got.root]).toEqual(test.root);
		});
	}

	it("round-trips the empty tree", () => {
		const raw = marshalTreeState({ size: 0n, root: DefaultHasher.emptyRoot() });
		expect(unmarshalTreeState(raw)).toEqual({ size: 0n, root: DefaultHasher.emptyRoot() });
	});
});

describe("unmarshalTreeState: inputs Go rejects", () => {
	const tests: { in: string; wantErr: string }[] = [
		{
			in: '{"size":-1,"root":"AQ=="}',
			wantErr: "json: cannot unmarshal number -1 into Go struct field treeState.size of type uint64",
		},
		{
			in: '{"size":1.0,"root":"AQ=="}',
			wantErr: "json: cannot unmarshal number 1.0 into Go struct field treeState.size of type uint64",
		},
		{
			in: '{"size":18446744073709551616,"root":"AQ=="}',
			wantErr: "json: cannot unmarshal number 18446744073709551616 into Go struct field treeState.size of type uint64",
		},
		{
			in: '{"size":"1","root":"AQ=="}',
			wantErr: "json: cannot unmarshal string into Go struct field treeState.size of type uint64",
		},
		{
			in: '{"size":1,"root":1}',
			wantErr: "json: cannot unmarshal number into Go struct field treeState.root of type []uint8",
		},
		{ in: '{"size":1,"root":"AQ="}', wantErr: "illegal base64 data at input byte 3" },
		{ in: '{"size":1,"root":"AQ=="} x', wantErr: "invalid character 'x' after top-level value" },
		{ in: "[1]", wantErr: "json: cannot unmarshal array into Go value of type treeState" },
		{ in: '{"size":1', wantErr: "unexpected end of JSON input" },
		{ in: "", wantErr: "unexpected end of JSON input" },
		{ in: '{"size":01,"root":""}', wantErr: "invalid character '1' in numeric literal" },
		{ in: '{"size":1,"root":"a\nb"}', wantErr: "invalid character '\\n' in string literal" },
		{ in: '{"size":1 "root":""}', wantErr: `invalid character '"' after object key:value pair` },
	];
	for (const test of tests) {
		it(JSON.stringify(test.in), () => {
			expect(() => unmarshalTreeState(toUTF8(test.in))).toThrow(test.wantErr);
		});
	}
});

describe("unmarshalTreeState: inputs only this decoder rejects", () => {
	// Go accepts each of these: it treats `null` as "leave the struct zero", matches keys
	// case-insensitively, lets the last of two duplicate keys win, and leaves a missing field
	// at its zero value. Each one means the state file was not written by either driver.
	const tests: { name: string; in: string; wantErr: string }[] = [
		{ name: "null", in: "null", wantErr: "json: cannot unmarshal null into Go value of type treeState" },
		{ name: "missing size", in: '{"root":"AQ=="}', wantErr: "json: missing field treeState.size" },
		{ name: "missing root", in: '{"size":1}', wantErr: "json: missing field treeState.root" },
		{
			name: "key differs only in case",
			in: '{"SIZE":1,"root":"AQ=="}',
			wantErr: "json: missing field treeState.size",
		},
		{ name: "duplicate key", in: '{"size":1,"size":2,"root":"AQ=="}', wantErr: 'json: duplicate field "size"' },
		{
			name: "null size",
			in: '{"size":null,"root":"AQ=="}',
			wantErr: "json: cannot unmarshal null into Go struct field treeState.size of type uint64",
		},
	];
	for (const test of tests) {
		it(test.name, () => {
			expect(() => unmarshalTreeState(toUTF8(test.in))).toThrow(test.wantErr);
		});
	}

	it("invalid UTF-8, even inside a string Go would repair", () => {
		const raw = new Uint8Array([...toUTF8('{"size":1,"root":"'), 0xff, ...toUTF8('"}')]);
		expect(() => unmarshalTreeState(raw)).toThrow("invalid UTF-8 in JSON input");
	});
});

describe("unmarshalTreeState: byte-order mark", () => {
	it("is rejected as Go rejects it, not stripped", () => {
		const raw = new Uint8Array([0xef, 0xbb, 0xbf, ...toUTF8('{"size":1,"root":"AQ=="}')]);
		expect(() => unmarshalTreeState(raw)).toThrow("looking for beginning of value");
	});
});

describe("unmarshalGCState", () => {
	it("decodes Go's encoding", () => {
		expect(unmarshalGCState(toUTF8('{"fromSize":18446744073709551615}'))).toEqual({ fromSize: maxUint64 });
	});

	it("requires fromSize", () => {
		expect(() => unmarshalGCState(toUTF8("{}"))).toThrow("json: missing field gcState.fromSize");
	});
});
