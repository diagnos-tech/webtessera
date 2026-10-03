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

// Differential suite for Ed25519 verification over fixtures/data/differential_ed25519.json
// (fixtures/gen/differential_ed25519.go): Go's crypto/ed25519.Verify, which sumdb/note's
// verifier wraps, against verifyEd25519 and the verifier newVerifier builds.

import { describe, it } from "vitest";
import {
	errVerifierNonCanonicalKey,
	errVerifierSmallOrderKey,
	newVerifier,
	type Verifier,
	verifyEd25519,
} from "../../../vendor/note/note.ts";
import { hexToBytes, loadFixture } from "../../fixtures.ts";
import { attempt, DifferentialReport, messageOf } from "../differential.ts";

interface Ed25519Corpus {
	readonly keys: readonly (readonly [pub: string, cls: string, vkey: string, goErr: string])[];
	readonly vectors: readonly (readonly [key: number, msg: string, sig: string, category: string, verdict: number])[];
}

/** describeEd25519Differential registers the Ed25519 differential tests. */
export function describeEd25519Differential(): void {
	describe("Ed25519 differential (differential_ed25519.json)", () => {
		it("verifyEd25519 returns crypto/ed25519.Verify's verdict on every vector", async () => {
			const f = await loadFixture<Ed25519Corpus>("differential_ed25519");
			const rep = new DifferentialReport("verifyEd25519");
			const accepted = new Map<string, number>();
			for (const [key, msg, sig, category, verdict] of f.vectors) {
				rep.record();
				const pub = hexToBytes((f.keys[key] as Ed25519Corpus["keys"][number])[0]);
				const got = attempt(() => verifyEd25519(pub, hexToBytes(msg), hexToBytes(sig)));
				const ts = got.ok ? (got.value ? 1 : 0) : `throws ${messageOf(got.error)}`;
				rep.equal(`${category} pub=${f.keys[key]?.[0]} msg=${msg} sig=${sig}`, "verdict", verdict, ts);
				accepted.set(category, (accepted.get(category) ?? 0) + verdict);
			}
			// The corpus must keep probing both sides of the boundaries it exists for.
			for (const category of ["honest", "small-a-valid", "mixed-order"]) {
				if ((accepted.get(category) ?? 0) === 0) {
					rep.fail(category, "Go accepts no vector of this category; the corpus no longer probes it");
				}
			}
			rep.assertClean(2000);
		});

		it("newVerifier accepts Go's keys except the unsafe ones ADR-0206 refuses, and verifies as Go does", async () => {
			const f = await loadFixture<Ed25519Corpus>("differential_ed25519");
			const rep = new DifferentialReport("newVerifier (Ed25519 keys)");
			const verifiers = new Map<number, Verifier>();
			f.keys.forEach(([pub, cls, vkey, goErr], i) => {
				rep.record();
				const got = attempt(() => newVerifier(vkey));
				const rid = `pub=${pub} class=${cls}`;
				if (goErr !== "") {
					rep.equal(rid, "err", goErr, got.ok ? "accepted" : messageOf(got.error));
					return;
				}
				const unsafe = cls.startsWith("small-order")
					? errVerifierSmallOrderKey
					: cls.endsWith("-noncanonical")
						? errVerifierNonCanonicalKey
						: undefined;
				if (unsafe !== undefined) {
					if (!got.ok && got.error === unsafe) {
						rep.diverge("ed25519-unsafe-verifier-key");
					} else {
						rep.fail(rid, `expected ${unsafe.message}, got ${got.ok ? "acceptance" : messageOf(got.error)}`);
					}
					return;
				}
				if (!got.ok) {
					rep.fail(rid, `go accepted, ts rejected: ${messageOf(got.error)}`);
					return;
				}
				verifiers.set(i, got.value);
			});
			for (const [key, msg, sig, category, verdict] of f.vectors) {
				const v = verifiers.get(key);
				if (v === undefined) {
					continue;
				}
				rep.record();
				rep.equal(
					`${category} key=${key} msg=${msg} sig=${sig}`,
					"Verifier.verify",
					verdict === 1,
					v.verify(hexToBytes(msg), hexToBytes(sig)),
				);
			}
			rep.assertClean(2000, ["ed25519-unsafe-verifier-key"], ["ed25519-unsafe-verifier-key"]);
		});
	});
}
