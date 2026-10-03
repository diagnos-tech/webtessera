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

// Differential suite for api's tile and bundle parsers and for newEntry over
// fixtures/data/differential_api.json (fixtures/gen/differential_api.go).

import { describe, it } from "vitest";
import { EntryBundle, HashTile } from "../../../api/state.ts";
import { newEntry } from "../../../entry.ts";
import { bytesToHex, hexToBytes, loadFixture } from "../../fixtures.ts";
import { attempt, DifferentialReport, messageOf } from "../differential.ts";

interface APICorpus {
	readonly tiles: readonly (readonly [raw: string, err: string, hashes?: number])[];
	readonly bundles: readonly (readonly [raw: string, err: string, entries?: readonly string[]])[];
	readonly entries: readonly (readonly [
		fill: string,
		n: number,
		length: number,
		head: string,
		tail: string,
		leafHash: string,
		identity: string,
	])[];
}

/** describeAPIDifferential registers the api and newEntry differential tests. */
export function describeAPIDifferential(): void {
	describe("api differential (differential_api.json)", () => {
		it("HashTile.unmarshalText and EntryBundle.unmarshalText reach Go's verdict, up to the 256-element maximum", async () => {
			const f = await loadFixture<APICorpus>("differential_api");
			const rep = new DifferentialReport("api unmarshalText");
			for (const [raw, err, hashes] of f.tiles) {
				rep.record();
				const b = hexToBytes(raw);
				const t = new HashTile();
				const got = attempt(() => t.unmarshalText(b));
				const rid = `tile of ${b.length} bytes`;
				if (err === "" && (hashes ?? 0) > 256) {
					// ADR-0194: Go parses the oversized tile, the port refuses it.
					if (!got.ok && messageOf(got.error) === `tile of ${hashes} hashes exceeds the maximum of 256`) {
						rep.diverge("tile-bundle-size-limit");
					} else {
						rep.fail(rid, `expected the ADR-0194 rejection, got ${got.ok ? "acceptance" : messageOf(got.error)}`);
					}
					continue;
				}
				rep.equal(
					rid,
					"result",
					err === "" ? `ok:${hashes}` : `err:${err}`,
					got.ok ? `ok:${t.nodes.length}` : `err:${messageOf(got.error)}`,
				);
			}
			for (const [raw, err, entries] of f.bundles) {
				rep.record();
				const b = hexToBytes(raw);
				const e = new EntryBundle();
				const got = attempt(() => e.unmarshalText(b));
				const rid = `bundle ${raw.slice(0, 64)}… (${b.length} bytes)`;
				const ts = got.ok ? `ok:${e.entries.map(bytesToHex).join(",")}` : `err:${messageOf(got.error)}`;
				const want = err === "" ? `ok:${(entries ?? []).join(",")}` : `err:${err}`;
				if (want === ts) {
					continue;
				}
				// ADR-0194: the port stops at a 257th entry. Go either parsed more than 256 entries
				// or failed on a malformed one past the 256th.
				if (
					ts === "err:entry bundle holds more than the maximum of 256 entries" &&
					(err !== "" || (entries ?? []).length > 256)
				) {
					rep.diverge("tile-bundle-size-limit");
					continue;
				}
				rep.equal(rid, "result", want, ts);
			}
			rep.assertClean(90, ["tile-bundle-size-limit"], ["tile-bundle-size-limit"]);
		});

		it("newEntry matches tessera.NewEntry up to 65535 bytes and refuses longer data", async () => {
			const f = await loadFixture<APICorpus>("differential_api");
			const rep = new DifferentialReport("newEntry");
			for (const [fill, n, length, head, tail, leafHash, identity] of f.entries) {
				rep.record();
				const data = new Uint8Array(n).fill(Number.parseInt(fill, 16));
				const got = attempt(() => newEntry(data));
				const rid = `newEntry(${n} bytes of 0x${fill})`;
				if (n > 65535) {
					// ADR-0182: Go accepts the entry and truncates its length prefix.
					if (
						!got.ok &&
						/^entry data is \d+ bytes, more than the 65535 a tlog-tiles entry bundle can hold$/.test(
							messageOf(got.error),
						)
					) {
						rep.diverge("entry-size-limit");
					} else {
						rep.fail(rid, `expected the ADR-0182 rejection, got ${got.ok ? "acceptance" : messageOf(got.error)}`);
					}
					continue;
				}
				if (!got.ok) {
					rep.fail(rid, `go accepted, ts threw ${messageOf(got.error)}`);
					continue;
				}
				const m = got.value.marshalBundleData(7n);
				const h = m.length > 16 ? m.subarray(0, 16) : m;
				const t = m.length > 16 ? m.subarray(m.length - 16) : m;
				rep.equal(rid, "bundle data", [length, head, tail], [m.length, bytesToHex(h), bytesToHex(t)]);
				rep.equal(
					rid,
					"leafHash, identity",
					[leafHash, identity],
					[bytesToHex(got.value.leafHash()), bytesToHex(got.value.identity())],
				);
			}
			rep.assertClean(9, ["entry-size-limit"], ["entry-size-limit"]);
		});
	});
}
