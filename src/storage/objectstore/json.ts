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

// This file has no upstream counterpart. It stands in for the two `encoding/json` calls
// tessera/storage/posix/files.go makes on its private state files, `.state/treeState` and
// `.state/gcState`, so that the ObjectStore driver reads and writes those files
// byte-for-byte the way the POSIX driver does. See
// docs/decisions/0102-objectstore-state-json-encoding.md.
//
// JSON.parse cannot be used: it decodes every number to a float64, and a uint64 tree size
// above 2^53 would silently lose precision. JSON.stringify cannot be used either, since it
// throws on bigint. Hence the small, strict reader below.

import { fromBase64, toBase64, toUTF8 } from "../../internal/gostd/bytes.ts";
import type { gcState, treeState } from "./driver.ts";

/**
 * marshalTreeState returns exactly what Go's `json.Marshal(treeState{Size: size, Root: root})`
 * returns: `{"size":<decimal>,"root":"<standard base64>"}`, with no whitespace and no
 * trailing newline.
 */
export function marshalTreeState(ts: treeState): Uint8Array {
	return toUTF8(`{"size":${ts.size.toString()},"root":"${toBase64(ts.root)}"}`);
}

/**
 * unmarshalTreeState parses a treeState written by marshalTreeState or by the Go POSIX
 * driver.
 *
 * It is stricter than `json.Unmarshal`: see docs/decisions/0102-objectstore-state-json-encoding.md
 * for the inputs Go would accept and this rejects.
 */
export function unmarshalTreeState(raw: Uint8Array): treeState {
	const fields = decodeObject(raw, "treeState");
	return {
		size: uint64Field(fields, "treeState", "size"),
		root: bytesField(fields, "treeState", "root"),
	};
}

/** marshalGCState returns exactly what Go's `json.Marshal(gcState{FromSize: size})` returns. */
export function marshalGCState(gs: gcState): Uint8Array {
	return toUTF8(`{"fromSize":${gs.fromSize.toString()}}`);
}

/** unmarshalGCState parses a gcState written by marshalGCState or by the Go POSIX driver. */
export function unmarshalGCState(raw: Uint8Array): gcState {
	const fields = decodeObject(raw, "gcState");
	return { fromSize: uint64Field(fields, "gcState", "fromSize") };
}

/**
 * jsonValue is a decoded JSON value. Numbers keep their source text so that integers beyond
 * 2^53 survive; values the state files never contain (booleans, arrays, objects) are
 * validated and then reduced to their kind, since they can only appear under keys the
 * decoder ignores.
 */
type jsonValue =
	| { readonly kind: "number"; readonly text: string }
	| { readonly kind: "string"; readonly value: string }
	| { readonly kind: "null" }
	| { readonly kind: "bool" | "array" | "object" };

/**
 * decodeObject parses raw as a single JSON object and returns its members.
 *
 * As in Go, keys that name no field of the target struct are skipped, so a state file
 * written by a newer driver with extra fields still loads. Unlike Go, a key that appears
 * twice is an error rather than last-one-wins, and keys are matched exactly rather than
 * case-insensitively.
 */
function decodeObject(raw: Uint8Array, structName: string): Map<string, jsonValue> {
	let text: string;
	try {
		// Strict: a byte-order mark is kept (and then rejected as a syntax error, as Go rejects
		// it) and invalid UTF-8 is an error, so a corrupt state file is never silently repaired.
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
	} catch {
		throw new Error("invalid UTF-8 in JSON input");
	}
	const d = new decoder(text);
	d.skipSpace();
	const c = d.peek();
	if (c !== "{") {
		if (c === undefined) {
			throw new Error("unexpected end of JSON input");
		}
		const v = d.value();
		throw new Error(`json: cannot unmarshal ${v.kind} into Go value of type ${structName}`);
	}
	const fields = d.object();
	d.skipSpace();
	const trailing = d.peek();
	if (trailing !== undefined) {
		throw new Error(`invalid character ${quoteChar(trailing)} after top-level value`);
	}
	return fields;
}

/** uint64Field returns the named member, which must be a JSON integer in [0, 2^64). */
function uint64Field(fields: Map<string, jsonValue>, structName: string, name: string): bigint {
	const v = requiredField(fields, structName, name);
	if (v.kind !== "number") {
		throw typeError(v.kind, structName, name, "uint64");
	}
	if (!/^(?:0|[1-9][0-9]*)$/.test(v.text) || BigInt(v.text) > maxUint64) {
		throw typeError(`number ${v.text}`, structName, name, "uint64");
	}
	return BigInt(v.text);
}

/**
 * bytesField returns the named member, which must be a standard base64 string or null, the
 * two forms Go's encoding/json produces for a `[]byte`.
 */
function bytesField(fields: Map<string, jsonValue>, structName: string, name: string): Uint8Array {
	const v = requiredField(fields, structName, name);
	if (v.kind === "null") {
		return new Uint8Array(0);
	}
	if (v.kind !== "string") {
		throw typeError(v.kind === "number" ? "number" : v.kind, structName, name, "[]uint8");
	}
	return fromBase64(v.value);
}

function requiredField(fields: Map<string, jsonValue>, structName: string, name: string): jsonValue {
	const v = fields.get(name);
	if (v === undefined) {
		throw new Error(`json: missing field ${structName}.${name}`);
	}
	return v;
}

/** typeError renders Go's `*json.UnmarshalTypeError` message. */
function typeError(value: string, structName: string, name: string, goType: string): Error {
	return new Error(`json: cannot unmarshal ${value} into Go struct field ${structName}.${name} of type ${goType}`);
}

const maxUint64 = (1n << 64n) - 1n;

/** quoteChar renders a character the way Go's encoding/json does in a SyntaxError message. */
function quoteChar(c: string): string {
	if (c === "'") {
		return "'\\''";
	}
	if (c === '"') {
		return "'\"'";
	}
	const code = c.charCodeAt(0);
	if (code < 0x20 || code === 0x7f) {
		return JSON.stringify(c).replace(/^"|"$/g, "'");
	}
	return `'${c}'`;
}

/**
 * decoder is a recursive-descent reader for RFC 8259 JSON. Its error messages follow
 * encoding/json's SyntaxError texts closely enough to be recognisable, without
 * reproducing its byte offsets.
 */
class decoder {
	readonly #s: string;
	#i = 0;

	constructor(s: string) {
		this.#s = s;
	}

	peek(): string | undefined {
		return this.#i < this.#s.length ? this.#s.charAt(this.#i) : undefined;
	}

	skipSpace(): void {
		while (this.#i < this.#s.length) {
			const c = this.#s.charAt(this.#i);
			if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") {
				return;
			}
			this.#i++;
		}
	}

	value(): jsonValue {
		this.skipSpace();
		const c = this.#next();
		switch (c) {
			case "{":
				this.#i--;
				this.object();
				return { kind: "object" };
			case "[":
				this.#array();
				return { kind: "array" };
			case '"':
				return { kind: "string", value: this.#stringBody() };
			case "t":
				this.#literal("rue");
				return { kind: "bool" };
			case "f":
				this.#literal("alse");
				return { kind: "bool" };
			case "n":
				this.#literal("ull");
				return { kind: "null" };
			default:
				if (c === "-" || (c >= "0" && c <= "9")) {
					this.#i--;
					return { kind: "number", text: this.#number() };
				}
				throw new Error(`invalid character ${quoteChar(c)} looking for beginning of value`);
		}
	}

	object(): Map<string, jsonValue> {
		const fields = new Map<string, jsonValue>();
		this.#expect("{", "looking for beginning of value");
		this.skipSpace();
		if (this.peek() === "}") {
			this.#i++;
			return fields;
		}
		for (;;) {
			this.skipSpace();
			this.#expect('"', "looking for beginning of object key string");
			const key = this.#stringBody();
			this.skipSpace();
			this.#expect(":", "after object key");
			const v = this.value();
			if (fields.has(key)) {
				throw new Error(`json: duplicate field ${JSON.stringify(key)}`);
			}
			fields.set(key, v);
			this.skipSpace();
			const c = this.#next();
			if (c === "}") {
				return fields;
			}
			if (c !== ",") {
				throw new Error(`invalid character ${quoteChar(c)} after object key:value pair`);
			}
		}
	}

	#array(): void {
		this.skipSpace();
		if (this.peek() === "]") {
			this.#i++;
			return;
		}
		for (;;) {
			this.value();
			this.skipSpace();
			const c = this.#next();
			if (c === "]") {
				return;
			}
			if (c !== ",") {
				throw new Error(`invalid character ${quoteChar(c)} after array element`);
			}
		}
	}

	/** stringBody reads the remainder of a string whose opening quote has been consumed. */
	#stringBody(): string {
		let out = "";
		for (;;) {
			const c = this.#next();
			if (c === '"') {
				return out;
			}
			if (c < " ") {
				throw new Error(`invalid character ${quoteChar(c)} in string literal`);
			}
			if (c !== "\\") {
				out += c;
				continue;
			}
			const e = this.#next();
			switch (e) {
				case '"':
				case "\\":
				case "/":
					out += e;
					break;
				case "b":
					out += "\b";
					break;
				case "f":
					out += "\f";
					break;
				case "n":
					out += "\n";
					break;
				case "r":
					out += "\r";
					break;
				case "t":
					out += "\t";
					break;
				case "u": {
					const hex = this.#s.slice(this.#i, this.#i + 4);
					if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
						if (hex.length < 4) {
							throw new Error("unexpected end of JSON input");
						}
						throw new Error("invalid character in \\u hexadecimal character escape");
					}
					this.#i += 4;
					// Lone surrogates are kept as-is; Go would substitute U+FFFD, but no key or
					// value the decoder interprets can contain one.
					out += String.fromCharCode(Number.parseInt(hex, 16));
					break;
				}
				default:
					throw new Error(`invalid character ${quoteChar(e)} in string escape code`);
			}
		}
	}

	/** number reads an RFC 8259 number and returns its source text. */
	#number(): string {
		const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.#s.slice(this.#i));
		if (m === null) {
			const c = this.#s.charAt(this.#i + 1);
			if (c === "") {
				throw new Error("unexpected end of JSON input");
			}
			throw new Error(`invalid character ${quoteChar(c)} in numeric literal`);
		}
		this.#i += m[0].length;
		const after = this.peek();
		if (after !== undefined && /[0-9.eE+-]/.test(after)) {
			throw new Error(`invalid character ${quoteChar(after)} in numeric literal`);
		}
		return m[0];
	}

	#literal(rest: string): void {
		for (const want of rest) {
			const c = this.#next();
			if (c !== want) {
				throw new Error(`invalid character ${quoteChar(c)} in literal`);
			}
		}
	}

	#expect(want: string, context: string): void {
		const c = this.#next();
		if (c !== want) {
			throw new Error(`invalid character ${quoteChar(c)} ${context}`);
		}
	}

	#next(): string {
		if (this.#i >= this.#s.length) {
			throw new Error("unexpected end of JSON input");
		}
		const c = this.#s.charAt(this.#i);
		this.#i++;
		return c;
	}
}
