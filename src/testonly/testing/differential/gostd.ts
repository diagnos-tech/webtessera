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

// Differential suites for the Go standard-library stand-ins in src/internal/gostd, over
// fixtures/data/differential_gostd.json and differential_unicode.json
// (fixtures/gen/differential_gostd.go). The unicode suite is the runtime-parity sweep:
// validUTF8 delegates to the platform's TextDecoder, so it also runs in Chromium and
// workerd (src/testonly/differential_browser_test.ts, differential_workers_test.ts).

import { sha256 } from "@noble/hashes/sha2.js";
import { describe, it } from "vitest";
import { len64, onesCount64, shiftLeft64, shiftRight64, trailingZeros64 } from "../../../internal/gostd/bits.ts";
import { fromBase64, fromHex } from "../../../internal/gostd/bytes.ts";
import { parseUint, quote } from "../../../internal/gostd/strconv.ts";
import { fields, trimSpace } from "../../../internal/gostd/strings.ts";
import { isSpace, validUTF8 } from "../../../internal/gostd/unicode.ts";
import { parse as parseURL } from "../../../internal/gostd/url.ts";
import { bytesToHex, hexToBytes, loadFixture, u64 } from "../../fixtures.ts";
import { attempt, canonical, DifferentialReport, messageOf, sameModuloQuoteBound } from "../differential.ts";

type PU = readonly [err: string] | readonly ["", string];

interface GoStdCorpus {
	readonly base64: readonly (readonly [input: string, err: string, hex?: string])[];
	readonly hex: readonly (readonly [input: string, err: string, hex?: string])[];
	readonly parseUint: readonly (readonly [input: string, h32: PU, h64: PU, d64: PU, d8: PU])[];
	readonly quoteEscaped: readonly (readonly [number, number])[];
	readonly quoteEscapedN: number;
	readonly quote: readonly (readonly [cp: number, quoted: string])[];
	readonly quoteStrings: readonly (readonly [input: string, quoted: string])[];
	readonly fields: readonly (readonly [input: string, fields: readonly string[], trimmed: string])[];
	readonly bits: readonly (readonly [x: string, tz: number, len: number, ones: number])[];
	readonly shifts: readonly (readonly [x: string, n: number, shl: string, shr: string])[];
	readonly url: readonly (
		| readonly [raw: string, err: string]
		| readonly [raw: string, err: "", str: string, joined: string, hostHex: string, scheme: string]
	)[];
}

interface UnicodeCorpus {
	readonly boundaries: readonly number[];
	readonly boundariesHigh: readonly number[];
	readonly continuation: readonly number[];
	readonly sweeps: readonly (readonly [
		name: string,
		positions: readonly string[],
		sha256: string,
		count: number,
		perFirst: readonly number[],
	])[];
	readonly random: readonly (readonly [hex: string, valid: number])[];
	readonly isSpace: readonly number[];
	readonly isSpaceSha256: string;
}

function decoded(f: () => Uint8Array): string {
	const got = attempt(f);
	return got.ok ? `ok:${bytesToHex(got.value)}` : `err:${messageOf(got.error)}`;
}

/** describeGoStdDifferential registers the gostd differential tests. */
export function describeGoStdDifferential(): void {
	describe("gostd differential (differential_gostd.json)", () => {
		it("fromBase64 and fromHex reach encoding/base64's and encoding/hex's verdict and error text", async () => {
			const f = await loadFixture<GoStdCorpus>("differential_gostd");
			const rep = new DifferentialReport("base64/hex");
			for (const [input, err, hex] of f.base64) {
				rep.record();
				rep.equal(
					`base64 ${JSON.stringify(input)}`,
					"DecodeString",
					err === "" ? `ok:${hex}` : `err:${err}`,
					decoded(() => fromBase64(input)),
				);
			}
			for (const [input, err, hex] of f.hex) {
				rep.record();
				rep.equal(
					`hex ${JSON.stringify(input)}`,
					"DecodeString",
					err === "" ? `ok:${hex}` : `err:${err}`,
					decoded(() => fromHex(input)),
				);
			}
			rep.assertClean(11000);
		});

		it("parseUint reaches strconv.ParseUint's value or error text in every base and bit size upstream uses", async () => {
			const f = await loadFixture<GoStdCorpus>("differential_gostd");
			const rep = new DifferentialReport("parseUint");
			const pu = (s: string, base: number, bits: number): PU => {
				const got = attempt(() => parseUint(s, base, bits));
				return got.ok ? ["", got.value.toString()] : [messageOf(got.error)];
			};
			for (const [input, h32, h64, d64, d8] of f.parseUint) {
				rep.record();
				const go = [h32, h64, d64, d8];
				const ts = [pu(input, 16, 32), pu(input, 16, 64), pu(input, 10, 64), pu(input, 10, 8)];
				let bounded = false;
				const sameOrBounded = go.every((g, i) => {
					const t = ts[i] as PU;
					if (canonical(g) === canonical(t)) {
						return true;
					}
					if (g[0] !== "" && t[0] !== "" && sameModuloQuoteBound(g[0], t[0])) {
						bounded = true;
						return true;
					}
					return false;
				});
				if (sameOrBounded && bounded) {
					rep.diverge("numerror-quote-bound");
				} else if (!sameOrBounded) {
					rep.equal(`parseUint ${JSON.stringify(input)}`, "(16,32) (16,64) (10,64) (10,8)", go, ts);
				}
			}
			rep.assertClean(2500, ["numerror-quote-bound"], ["numerror-quote-bound"]);
		});

		it("quote escapes exactly the code points strconv.Quote escapes, spelled as Go spells them", async () => {
			const f = await loadFixture<GoStdCorpus>("differential_gostd");
			const rep = new DifferentialReport("quote");
			const exact = new Map(f.quote.map(([cp, q]) => [cp, q]));
			let escaped = 0;
			let ri = 0;
			for (let cp = 0; cp <= 0x10ffff; cp++) {
				if (cp >= 0xd800 && cp <= 0xdfff) {
					continue;
				}
				while (ri < f.quoteEscaped.length && (f.quoteEscaped[ri] as readonly [number, number])[1] < cp) {
					ri++;
				}
				const range = f.quoteEscaped[ri];
				const goEscapes = range !== undefined && range[0] <= cp && cp <= range[1];
				const s = String.fromCodePoint(cp);
				const q = quote(s);
				rep.record();
				if (goEscapes) {
					escaped++;
					const want = exact.get(cp);
					if (want !== undefined) {
						rep.equal(`U+${cp.toString(16)}`, "quote", want, q);
					} else if (q === `"${s}"`) {
						rep.fail(`U+${cp.toString(16)}`, "go escapes it, ts quotes it verbatim");
					}
				} else if (q !== `"${s}"`) {
					rep.fail(`U+${cp.toString(16)}`, `go quotes it verbatim, ts gives ${q}`);
				}
			}
			rep.equal("(all)", "escaped count", f.quoteEscapedN, escaped);
			for (const [input, want] of f.quoteStrings) {
				rep.record();
				rep.equal(JSON.stringify(input), "quote", want, quote(input));
			}
			rep.assertClean(1_000_000);
		});

		it("fields and trimSpace split and trim exactly where strings.Fields and strings.TrimSpace do", async () => {
			const f = await loadFixture<GoStdCorpus>("differential_gostd");
			const rep = new DifferentialReport("fields/trimSpace");
			for (const [input, want, trimmed] of f.fields) {
				rep.record();
				rep.equal(JSON.stringify(input), "fields", want, fields(input));
				rep.equal(JSON.stringify(input), "trimSpace", trimmed, trimSpace(input));
			}
			rep.assertClean(1400);
		});

		it("bits and uint64 shifts match math/bits and Go's << and >>", async () => {
			const f = await loadFixture<GoStdCorpus>("differential_gostd");
			const rep = new DifferentialReport("bits");
			for (const [x, tz, len, ones] of f.bits) {
				rep.record();
				const v = u64(x);
				rep.equal(
					x,
					"TrailingZeros64,Len64,OnesCount64",
					[tz, len, ones],
					[trailingZeros64(v), len64(v), onesCount64(v)],
				);
			}
			for (const [x, n, shl, shr] of f.shifts) {
				rep.record();
				const v = u64(x);
				rep.equal(`${x} by ${n}`, "<<,>>", [shl, shr], [shiftLeft64(v, n), shiftRight64(v, n)]);
			}
			rep.assertClean(5000);
		});

		it("url.parse, joinPath and string reach net/url's verdict, error text and output", async () => {
			const f = await loadFixture<GoStdCorpus>("differential_gostd");
			const rep = new DifferentialReport("url");
			for (const row of f.url) {
				rep.record();
				const [raw, err] = row;
				const got = attempt(() => {
					const u = parseURL(raw);
					const host = Array.from(u.host, (c) => c.charCodeAt(0));
					return [u.string(), u.joinPath("/add-checkpoint").string(), bytesToHex(Uint8Array.from(host)), u.scheme];
				});
				const want = err === "" ? `ok:${JSON.stringify(row.slice(2))}` : `err:${err}`;
				rep.equal(
					JSON.stringify(raw),
					"parse",
					want,
					got.ok ? `ok:${JSON.stringify(got.value)}` : `err:${messageOf(got.error)}`,
				);
			}
			rep.assertClean(3000);
		});
	});
}

/**
 * describeUnicodeDifferential registers the utf8.Valid and unicode.IsSpace sweeps. They
 * run in every runtime the port supports, because validUTF8 is only as Go-exact as the
 * TextDecoder of the runtime it runs in.
 */
export function describeUnicodeDifferential(runtime: string): void {
	describe(`unicode runtime parity in ${runtime} (differential_unicode.json)`, () => {
		it("validUTF8 agrees with utf8.Valid on every structured sweep and every random string", async () => {
			const f = await loadFixture<UnicodeCorpus>("differential_unicode");
			const rep = new DifferentialReport(`validUTF8 (${runtime})`);
			const all = Array.from({ length: 256 }, (_, i) => i);
			const sets: Record<string, readonly number[]> = {
				all,
				boundaries: f.boundaries,
				boundariesHigh: f.boundariesHigh,
				continuation: f.continuation,
			};
			for (const [name, positions, digest, count, perFirst] of f.sweeps) {
				const ps = positions.map((p) => sets[p] as readonly number[]);
				const total = ps.reduce((n, s) => n * s.length, 1);
				const verdicts = new Uint8Array(total);
				const buf = new Uint8Array(ps.length);
				const first = new Map<number, number>();
				let valid = 0;
				for (let i = 0; i < total; i++) {
					let x = i;
					for (let k = ps.length - 1; k >= 0; k--) {
						const s = ps[k] as readonly number[];
						buf[k] = s[x % s.length] as number;
						x = Math.floor(x / s.length);
					}
					if (validUTF8(buf)) {
						verdicts[i] = 1;
						valid++;
						first.set(buf[0] as number, (first.get(buf[0] as number) ?? 0) + 1);
					}
				}
				rep.record();
				rep.equal(name, "valid count", count, valid);
				rep.equal(
					name,
					"valid count per first byte",
					perFirst,
					(ps[0] as readonly number[]).map((b) => first.get(b) ?? 0),
				);
				rep.equal(name, "sha256 of verdicts", digest, sha256(verdicts));
			}
			for (const [hex, valid] of f.random) {
				rep.record();
				rep.equal(hex, "valid", valid === 1, validUTF8(hexToBytes(hex)));
			}
			rep.assertClean(4000);
		});

		it("isSpace agrees with unicode.IsSpace on every code point", async () => {
			const f = await loadFixture<UnicodeCorpus>("differential_unicode");
			const rep = new DifferentialReport(`isSpace (${runtime})`);
			const verdicts = new Uint8Array(0x110000);
			const spaces: number[] = [];
			for (let cp = 0; cp <= 0x10ffff; cp++) {
				if (isSpace(cp)) {
					verdicts[cp] = 1;
					spaces.push(cp);
				}
			}
			rep.record();
			rep.equal("(all)", "spaces", f.isSpace, spaces);
			rep.equal("(all)", "sha256 of verdicts", f.isSpaceSha256, sha256(verdicts));
			rep.assertClean(1);
		});
	});
}
