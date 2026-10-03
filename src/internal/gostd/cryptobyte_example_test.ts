// Copyright 2017 The Go Authors. All rights reserved.
// Copyright 2026 MedDeck. All Rights Reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in LICENSES/BSD-3-Clause-Go.txt.
//
// Ported from golang.org/x/crypto@v0.46.0/cryptobyte/example_test.go
//
// Port note: Go's testable examples assert on what the function writes to stdout.
// There is no equivalent in vitest, so each example builds the same string the Go
// example would have printed and asserts on it, as docs/decisions/0033-go-examples-as-assertion-tests.md
// describes. The `// Output:` line of the Go example is kept above the assertion.
//
// ExampleString_aSN1 and ExampleBuilder_aSN1 are absent because the ASN.1 support they
// demonstrate is not ported. See docs/decisions/0040-cryptobyte-port-scope.md.

import { describe, expect, it } from "vitest";
import { fromUTF8, toHex, toUTF8 } from "./bytes.ts";
import * as cryptobyte from "./cryptobyte.ts";
import { quote } from "./strconv.ts";

describe("cryptobyte examples", () => {
	it("ExampleString_lengthPrefixed", () => {
		// This is an example of parsing length-prefixed data (as found in, for
		// example, TLS). Imagine a 16-bit prefixed series of 8-bit prefixed
		// strings.

		// []byte{0, 12, 5, 'h', 'e', 'l', 'l', 'o', 5, 'w', 'o', 'r', 'l', 'd'}
		const input = new cryptobyte.String(Uint8Array.of(0, 12, 5, ...toUTF8("hello"), 5, ...toUTF8("world")));
		const result: string[] = [];

		const values = input.readUint16LengthPrefixed();
		if (values === undefined || !input.empty()) {
			throw new Error("bad format");
		}

		while (!values.empty()) {
			const value = values.readUint8LengthPrefixed();
			if (value === undefined) {
				throw new Error("bad format");
			}

			result.push(fromUTF8(value.bytes()));
		}

		// Output: []string{"hello", "world"}
		// fmt.Printf("%#v\n", result)
		const printed = `[]string{${result.map(quote).join(", ")}}\n`;
		expect(printed).toBe('[]string{"hello", "world"}\n');
	});

	it("ExampleBuilder_lengthPrefixed", () => {
		// This is an example of building length-prefixed data (as found in,
		// for example, TLS). Imagine a 16-bit prefixed series of 8-bit
		// prefixed strings.
		const input = ["hello", "world"];

		const b = new cryptobyte.Builder();
		b.addUint16LengthPrefixed((b) => {
			for (const value of input) {
				b.addUint8LengthPrefixed((b) => {
					b.addBytes(toUTF8(value));
				});
			}
		});

		const result = b.bytes();

		// Output: 000c0568656c6c6f05776f726c64
		// fmt.Printf("%x\n", result)
		const printed = `${toHex(result)}\n`;
		expect(printed).toBe("000c0568656c6c6f05776f726c64\n");
	});

	it("ExampleBuilder_lengthPrefixOverflow", () => {
		// Writing more data that can be expressed by the length prefix results
		// in an error from Bytes().

		const tooLarge = new Uint8Array(256);

		const b = new cryptobyte.Builder();
		b.addUint8LengthPrefixed((b) => {
			b.addBytes(tooLarge);
		});

		// Go returns a nil result alongside the error; here bytes() throws instead.
		let result: Uint8Array = new Uint8Array(0);
		let err: unknown;
		try {
			result = b.bytes();
		} catch (e) {
			err = e;
		}

		// Output: len=0 err=cryptobyte: pending child length 256 exceeds 1-byte length prefix
		// fmt.Printf("len=%d err=%s\n", len(result), err)
		const printed = `len=${result.length} err=${(err as Error).message}\n`;
		expect(printed).toBe("len=0 err=cryptobyte: pending child length 256 exceeds 1-byte length prefix\n");
	});

	it("ExampleBuilderContinuation_errorHandling", () => {
		const b = new cryptobyte.Builder();
		// Continuations that panic with a BuildError will cause Bytes to
		// return the inner error.
		b.addUint16LengthPrefixed((b) => {
			b.addUint32(0);
			throw new cryptobyte.BuildError(new Error("example error"));
		});

		// Go returns a nil result alongside the error; here bytes() throws instead.
		let result: Uint8Array = new Uint8Array(0);
		let err: unknown;
		try {
			result = b.bytes();
		} catch (e) {
			err = e;
		}

		// Output: len=0 err=example error
		// fmt.Printf("len=%d err=%s\n", len(result), err)
		const printed = `len=${result.length} err=${(err as Error).message}\n`;
		expect(printed).toBe("len=0 err=example error\n");
	});
});
