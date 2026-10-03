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

import { describe, expect, it } from "vitest";
import { errorIs } from "../internal/gostd/errors.ts";
import { ErrMalformedRequest } from "./errors.ts";
import { marshalAddCheckpointRequest, parseAddCheckpointRequest } from "./request.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

// The example request body from https://c2sp.org/tlog-witness, verbatim.
const specCheckpoint =
	"example.com/behind-the-sofa\n" +
	"20852163\n" +
	"CsUYapGGPo4dkMgIAUqom/Xajj7h2fB2MPA3j2jxq2I=\n" +
	"\n" +
	"— example.com/behind-the-sofa Az3grlgtzPICa5OS8npVmf1Myq/5IZniMp+ZJurmRDeOoRDe4URYN7u5/Zhcyv2q1gGzGku9nTo+zyWE+xeMcTOAYQ8=\n" +
	"— example.com/behind-the-sofa opLqBQsREYCgu6xQkYQwJr9fo45a62DN9EdmHXnZdXNqlcVGlCum2Wks+49/V6267UEjw6QUXTS5Rovnzv++qbSzm9Q=\n";
const specProof = [
	"PlRNCrwHpqhGrupue0L7gxbjbMiKA9temvuZZDDpkaw=",
	"jrJZDmY8Y7SyJE0MWLpLozkIVMSMZcD5kvuKxPC3swk=",
	"5+pKlUdi2LeF/BcMHBn+Ku6yhPGNCswZZD1X/6QgPd8=",
	"/6WVhPs2CwSsb5rYBH5cjHV/wSmA79abXAwhXw3Kj/0=",
];
const specBody = `old 20852014\n${specProof.join("\n")}\n\n${specCheckpoint}`;

const hash = "PlRNCrwHpqhGrupue0L7gxbjbMiKA9temvuZZDDpkaw=";
const cp = "origin\n1\nhash\n\n— sig\n";

describe("parseAddCheckpointRequest", () => {
	it("parses the spec's example request", () => {
		const r = parseAddCheckpointRequest(enc(specBody));
		expect(r.oldSize).toBe(20852014n);
		expect(r.proof.map((p) => btoa(String.fromCharCode(...p)))).toEqual(specProof);
		expect(dec(r.checkpoint)).toBe(specCheckpoint);
	});

	it("round-trips through marshalAddCheckpointRequest", () => {
		const r = parseAddCheckpointRequest(enc(specBody));
		expect(dec(marshalAddCheckpointRequest(r))).toBe(specBody);
	});

	it("accepts the extremes of the old size and no proof at all", () => {
		expect(parseAddCheckpointRequest(enc(`old 0\n\n${cp}`)).oldSize).toBe(0n);
		const max = parseAddCheckpointRequest(enc(`old 18446744073709551615\n\n${cp}`));
		expect(max.oldSize).toBe(18446744073709551615n);
		expect(max.proof).toEqual([]);
	});

	it("accepts 63 proof lines", () => {
		const body = `old 1\n${`${hash}\n`.repeat(63)}\n${cp}`;
		expect(parseAddCheckpointRequest(enc(body)).proof).toHaveLength(63);
	});

	const bad: { name: string; body: string }[] = [
		{ name: "empty body", body: "" },
		{ name: "no newline after the old size", body: "old 5" },
		{ name: "leading zero in the old size", body: `old 05\n\n${cp}` },
		{ name: "old size zero written as 00", body: `old 00\n\n${cp}` },
		{ name: "negative old size", body: `old -1\n\n${cp}` },
		{ name: "two spaces", body: `old  5\n\n${cp}` },
		{ name: "capitalised keyword", body: `Old 5\n\n${cp}` },
		{ name: "trailing space", body: `old 5 \n\n${cp}` },
		{ name: "carriage return", body: `old 5\r\n\r\n${cp}` },
		{ name: "old size beyond uint64", body: `old 18446744073709551616\n\n${cp}` },
		{ name: "proof line that is not base64", body: `old 5\nnot*base64\n\n${cp}` },
		{ name: "proof line of 16 bytes", body: `old 5\nAAAAAAAAAAAAAAAAAAAAAA==\n\n${cp}` },
		{ name: "unpadded proof line", body: `old 5\n${hash.slice(0, -1)}\n\n${cp}` },
		// The last character before the padding carries two bits that canonical base64 zeroes.
		{ name: "non-canonical proof line", body: `old 5\n${hash.slice(0, -2)}x=\n\n${cp}` },
		{ name: "64 proof lines", body: `old 1\n${`${hash}\n`.repeat(64)}\n${cp}` },
		{ name: "no empty line", body: `old 5\n${hash}\n` },
		{ name: "no checkpoint", body: `old 5\n${hash}\n\n` },
	];
	for (const { name, body } of bad) {
		it(`rejects a body with ${name}`, () => {
			let err: unknown;
			try {
				parseAddCheckpointRequest(enc(body));
			} catch (e) {
				err = e;
			}
			expect(errorIs(err, ErrMalformedRequest), String(err)).toBe(true);
		});
	}
});
