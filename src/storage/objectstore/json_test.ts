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
		// encoding/json decodes a JSON array into a []byte element by element; a null element
		// leaves its byte zero.
		{ name: "root as an array of bytes", in: '{"size":1,"root":[1,2,255]}', size: 1n, root: [1, 2, 255] },
		{ name: "root as an empty array", in: '{"size":1,"root":[]}', size: 1n, root: [] },
		{ name: "a null element of a root array", in: '{"size":1,"root":[null,7]}', size: 1n, root: [0, 7] },
		// A skipped member is skipped whatever it holds, repeated keys included, at any depth
		// (Go 1.24.7 and 1.25.5).
		{
			name: "repeated keys inside a skipped member",
			in: '{"size":1,"root":"AAAA","x":{"a":1,"a":2}}',
			size: 1n,
			root: [0, 0, 0],
		},
		{
			name: "repeated keys inside an array in a skipped member",
			in: '{"size":1,"root":"AAAA","x":[{"a":1,"a":2}]}',
			size: 1n,
			root: [0, 0, 0],
		},
		{ name: "a skipped key repeated", in: '{"size":1,"root":"AAAA","x":1,"x":2}', size: 1n, root: [0, 0, 0] },
		// A key sets the field it names exactly, else the one it names case-insensitively, as
		// encoding/json's foldName folds: U+017F (ſ) folds with s, the dotless ı with nothing.
		{ name: "keys that differ only in case", in: '{"SIZE":5,"ROOT":"AQ=="}', size: 5n, root: [1] },
		{ name: "a key with U+017F for s", in: '{"\u017fize":5,"root":"AQ=="}', size: 5n, root: [1] },
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
		// The port's syntax-error texts follow encoding/json's only loosely (docs/decisions/0102);
		// Go says "invalid character '1' after object key:value pair" here.
		{ in: '{"size":01,"root":""}', wantErr: "invalid character '1' in numeric literal" },
		{ in: '{"size":1,"root":"a\nb"}', wantErr: "invalid character '\\n' in string literal" },
		{ in: '{"size":1 "root":""}', wantErr: `invalid character '"' after object key:value pair` },
		// A root array's elements must each fit a uint8 (Go 1.24.7 and 1.25.5 give these texts).
		...[
			["256", "number 256"],
			["-1", "number -1"],
			["1.5", "number 1.5"],
			["1e2", "number 1e2"],
			['"a"', "string"],
			["[1]", "array"],
			["true", "bool"],
			["{}", "object"],
		].map(([e, what]) => ({
			in: `{"size":1,"root":[0,${e}]}`,
			wantErr: `json: cannot unmarshal ${what} into Go struct field treeState.root of type uint8`,
		})),
		// Go's errors come before the port's own refusal of a field set twice.
		{ in: '{"size":5,"size":6,"root":"cm9vdCk"}', wantErr: "illegal base64 data at input byte 4" },
		{
			in: '{"size":5,"Size":-1,"root":"AAAA"}',
			wantErr: "json: cannot unmarshal number -1 into Go struct field treeState.size of type uint64",
		},
		// Go keeps decoding after a type error and reports the earliest, in document order.
		{
			in: '{"root":5,"size":-1}',
			wantErr: "json: cannot unmarshal number into Go struct field treeState.root of type []uint8",
		},
		{
			in: '{"root":[300],"size":"x"}',
			wantErr: "json: cannot unmarshal number 300 into Go struct field treeState.root of type uint8",
		},
		// Go's error comes before the port's own refusal of a null size.
		{
			in: '{"size":null,"root":true}',
			wantErr: "json: cannot unmarshal bool into Go struct field treeState.root of type []uint8",
		},
	];
	for (const test of tests) {
		it(JSON.stringify(test.in), () => {
			expect(() => unmarshalTreeState(toUTF8(test.in))).toThrow(test.wantErr);
		});
	}
});

describe("unmarshalTreeState: inputs only this decoder rejects", () => {
	// Go accepts each of these: it treats `null` as "leave the struct zero", lets the last of
	// two members that set one field win (size 2, 3 and 1 below), and leaves a missing field
	// at its zero value. Each one means the state file was not written by either driver.
	const tests: { name: string; in: string; wantErr: string }[] = [
		{ name: "null", in: "null", wantErr: "json: cannot unmarshal null into Go value of type treeState" },
		{ name: "missing size", in: '{"root":"AQ=="}', wantErr: "json: missing field treeState.size" },
		{ name: "missing root", in: '{"size":1}', wantErr: "json: missing field treeState.root" },
		{
			name: "a key with the dotless i, which does not fold with i",
			in: '{"s\u0131ze":5,"root":"AQ=="}',
			wantErr: "json: missing field treeState.size",
		},
		{ name: "duplicate key", in: '{"size":1,"size":2,"root":"AQ=="}', wantErr: 'json: duplicate field "size"' },
		{
			name: "a case variant of a key already present",
			in: '{"size":1,"root":"AAAA","Size":3}',
			wantErr: 'json: duplicate field "Size"',
		},
		{
			name: "a key already present as a case variant",
			in: '{"Size":3,"size":1,"root":"AAAA"}',
			wantErr: 'json: duplicate field "size"',
		},
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

	it("matches keys and skips members as Go does", () => {
		expect(unmarshalGCState(toUTF8('{"FROMSIZE":7}'))).toEqual({ fromSize: 7n });
		expect(unmarshalGCState(toUTF8('{"from\u017fize":7}'))).toEqual({ fromSize: 7n });
		expect(unmarshalGCState(toUTF8('{"fromSize":1,"x":{"a":1,"a":2}}'))).toEqual({ fromSize: 1n });
		// Go gives 8, the last; the port refuses a field set twice.
		expect(() => unmarshalGCState(toUTF8('{"fromsize":7,"fromSize":8}'))).toThrow('json: duplicate field "fromSize"');
	});
});
