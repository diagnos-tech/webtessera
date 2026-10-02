import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { bytesEqual, fromBase64, fromHex, fromUTF8, splitN, toBase64, toHex, toUTF8 } from "./bytes.ts";

// Smoke test for the toolchain itself: @noble resolves, `*_test.ts` is picked up,
// and the hex helpers round-trip. Real coverage of this file lands with the
// modules that depend on it.
describe("gostd/bytes", () => {
	it("hex round-trips and matches a known SHA-256 vector", () => {
		const empty = sha256(new Uint8Array());
		expect(toHex(empty)).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
		expect(bytesEqual(fromHex(toHex(empty)), empty)).toBe(true);
	});

	it("fromUTF8 keeps a leading byte-order mark, like Go's string(b)", () => {
		const withBOM = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
		expect(fromUTF8(withBOM)).toBe("\ufeffa");
		expect(bytesEqual(toUTF8(fromUTF8(withBOM)), withBOM)).toBe(true);
	});

	it("fromUTF8 replaces invalid sequences with U+FFFD, like Go's string(b)", () => {
		expect(fromUTF8(new Uint8Array([0x61, 0xff, 0x62]))).toBe("a\ufffdb");
	});
});

// splitN backs `internal/parse`, which splits a checkpoint on newlines with a cap of
// four parts and relies on the remainder landing in the last element.
describe("gostd/bytes splitN", () => {
	const nl = toUTF8("\n");
	const tests: { desc: string; s: string; n: number; want: string[] }[] = [
		{ desc: "trailing separator produces a final empty part", s: "a\nb\nc\n", n: 4, want: ["a", "b", "c", ""] },
		{ desc: "fewer separators than the cap", s: "a\nb\n", n: 4, want: ["a", "b", ""] },
		{ desc: "remainder is left unsplit in the last part", s: "a\nb\nc\nd\ne", n: 4, want: ["a", "b", "c", "d\ne"] },
		{ desc: "empty input yields one empty part", s: "", n: 4, want: [""] },
		{ desc: "no separator yields the whole input", s: "abc", n: 4, want: ["abc"] },
		{ desc: "n of one yields the whole input", s: "a\nb", n: 1, want: ["a\nb"] },
		{ desc: "negative n splits everything", s: "a\nb\nc\n", n: -1, want: ["a", "b", "c", ""] },
		{ desc: "n of zero yields nothing", s: "a\nb", n: 0, want: [] },
	];

	for (const test of tests) {
		it(test.desc, () => {
			const got = splitN(toUTF8(test.s), nl, test.n);
			expect(got.map((p) => new TextDecoder().decode(p))).toEqual(test.want);
		});
	}
});

// Go's base64.StdEncoding.DecodeString is strict about padding, which is what
// `internal/parse` relies on to reject a malformed checkpoint hash. The platform's
// atob() is not: it accepts unpadded input, so fromBase64 validates first.
describe("gostd/bytes base64", () => {
	it("round-trips", () => {
		const b = sha256(toUTF8("tessera"));
		expect(bytesEqual(fromBase64(toBase64(b)), b)).toBe(true);
	});

	it("decodes a padded checkpoint hash", () => {
		const got = fromBase64("qINS1GRFhWHwdkUeqLEoP4yEMkTBBzxBkGwGQlVlVcs=");
		expect(got.length).toBe(32);
		expect(toBase64(got)).toBe("qINS1GRFhWHwdkUeqLEoP4yEMkTBBzxBkGwGQlVlVcs=");
	});

	it("decodes the empty string", () => {
		expect(fromBase64("").length).toBe(0);
	});

	const bad: string[] = [
		// Length is not a multiple of four: unpadded input Go rejects and atob accepts.
		"thisisnotright",
		"QQ",
		"QQQ",
		// Padding in the wrong place.
		"Q=QQ",
		"=QQQ",
		// Not in the standard alphabet (this is the URL-safe one).
		"a-b_cccc",
		// Whitespace, which the platform's atob() silently strips.
		"QQ ==",
	];

	for (const s of bad) {
		it(`rejects ${JSON.stringify(s)}`, () => {
			expect(() => fromBase64(s)).toThrow("illegal base64 data");
		});
	}
});

// Go's decoder ignores \r and \n anywhere in the input, and reports a rejection at the
// offset a left-to-right scan reaches — not at the end of the input. The golden
// fixtures pin that exact text, so both behaviours are asserted here against vectors
// taken from `base64.StdEncoding.DecodeString` running under Go 1.25.5.
describe("gostd/bytes base64 against Go", () => {
	const accepted: Array<[string, string]> = [
		["", ""],
		["Zg==", "f"],
		["Zm8=", "fo"],
		["Zm9v", "foo"],
		["Zm9v\nYmFy", "foobar"],
		["Zm9v\r\nYmFy\n", "foobar"],
		["\nZm9v", "foo"],
		["Zm9vYmFy\n\n", "foobar"],
	];
	for (const [encoded, plain] of accepted) {
		it(`accepts ${JSON.stringify(encoded)}`, () => {
			expect(new TextDecoder().decode(fromBase64(encoded))).toBe(plain);
		});
	}

	const rejected: Array<[string, number]> = [
		["Zm9vYmF", 4],
		["Zg", 0],
		["Zm8", 0],
		["Zm 9v", 2],
		["Zm\t9v", 2],
		["ThisIsn'tBase64", 7],
		["Zm9v=YmFy", 4],
		["====", 0],
		["Z===", 1],
		["Zm9vYmFy=", 8],
		["-m9v", 0],
		["Zm9v ", 4],
		["5dyaeacGWamtVZy3Ad7Zoqudu-Oq0klgz_Nw7", 25],
		["not base64!!", 3],
		["thisisnotright", 12],
		["QQ ==", 2],
		["a-b_cccc", 1],
		["Q=QQ", 1],
		["=QQQ", 0],
		["Zm9vYg==x", 8],
	];
	for (const [encoded, offset] of rejected) {
		it(`rejects ${JSON.stringify(encoded)} at byte ${offset}`, () => {
			expect(() => fromBase64(encoded)).toThrow(`illegal base64 data at input byte ${offset}`);
		});
	}

	it("round-trips every byte value", () => {
		const all = new Uint8Array(256);
		for (let i = 0; i < 256; i++) {
			all[i] = i;
		}
		expect(bytesEqual(fromBase64(toBase64(all)), all)).toBe(true);
	});
});
