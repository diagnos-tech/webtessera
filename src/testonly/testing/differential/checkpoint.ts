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

// Differential suite for formats/log over fixtures/data/differential_checkpoint.json
// (fixtures/gen/differential_checkpoint.go).

import { describe, it } from "vitest";
import { toUTF8 } from "../../../internal/gostd/bytes.ts";
import { validUTF8 } from "../../../internal/gostd/unicode.ts";
import { Checkpoint } from "../../../vendor/formats/log/checkpoint.ts";
import { id } from "../../../vendor/formats/log/identifier.ts";
import { ParseCheckpointError, parseCheckpoint } from "../../../vendor/formats/log/note.ts";
import { newVerifier, type Verifier } from "../../../vendor/note/note.ts";
import { hexToBytes, loadFixture, u64 } from "../../fixtures.ts";
import {
	attempt,
	DifferentialReport,
	messageOf,
	sameModuloInvalidUTF8,
	sameModuloQuoteBound,
} from "../differential.ts";

type UnmarshalRow =
	| readonly [raw: string, rawIsUTF8: number, err: string]
	| readonly [raw: string, rawIsUTF8: number, err: "", origin: string, size: string, hash: string, rest: string];

type ParseRow =
	| readonly [msg: string, expected: string, others: string, err: string, sigs: number]
	| readonly [
			msg: string,
			expected: string,
			others: string,
			err: "",
			sigs: number,
			origin: string,
			size: string,
			hash: string,
			other: string,
	  ];

interface CheckpointCorpus {
	readonly keys: { readonly log: string; readonly alt: string; readonly witness: string };
	readonly unmarshal: readonly UnmarshalRow[];
	readonly marshal: readonly (readonly [origin: string, size: string, hash: string, out: string])[];
	readonly id: readonly (readonly [origin: string, id: string])[];
	readonly parse: readonly ParseRow[];
}

const corpus = () => loadFixture<CheckpointCorpus>("differential_checkpoint");

/** describeCheckpointDifferential registers the formats/log differential tests. */
export function describeCheckpointDifferential(): void {
	describe("formats/log differential (differential_checkpoint.json)", () => {
		it("Checkpoint.unmarshal reaches Go's verdict, error text, fields and trailing data", async () => {
			const f = await corpus();
			const rep = new DifferentialReport("Checkpoint.unmarshal");
			for (const row of f.unmarshal) {
				rep.record();
				const raw = hexToBytes(row[0]);
				const isUTF8 = row[1] === 1;
				const cp = new Checkpoint();
				const got = attempt(() => cp.unmarshal(raw));
				const rid = `raw=${row[0]}`;
				if (row[2] !== "") {
					// Go rejected it.
					if (got.ok) {
						rep.fail(rid, `go rejected (${row[2]}), ts accepted`);
					} else if (isUTF8) {
						if (row[2] !== messageOf(got.error) && sameModuloQuoteBound(row[2], messageOf(got.error))) {
							rep.diverge("numerror-quote-bound");
						} else {
							rep.equal(rid, "err", row[2], messageOf(got.error));
						}
					} else if (sameModuloInvalidUTF8(row[2], messageOf(got.error))) {
						if (row[2] !== messageOf(got.error)) {
							rep.diverge("invalid-utf8-text");
						}
					} else {
						rep.fail(rid, `err: go=${JSON.stringify(row[2])} ts=${JSON.stringify(messageOf(got.error))}`);
					}
					continue;
				}
				const [, , , origin, size, hash, rest] = row as Extract<UnmarshalRow, { length: 7 }>;
				const originBytes = hexToBytes(origin);
				if (!validUTF8(originBytes)) {
					// Go accepts an origin a JavaScript string cannot hold; the port refuses it.
					if (!got.ok && messageOf(got.error) === "invalid checkpoint - origin is not valid UTF-8") {
						rep.diverge("checkpoint-origin-utf8");
					} else {
						rep.fail(
							rid,
							`invalid-UTF-8 origin: expected the port's documented rejection, got ${got.ok ? "acceptance" : messageOf(got.error)}`,
						);
					}
					continue;
				}
				if (!got.ok) {
					rep.fail(rid, `go accepted, ts rejected: ${messageOf(got.error)}`);
					continue;
				}
				rep.equal(rid, "origin", origin, toUTF8(cp.origin));
				rep.equal(rid, "size", u64(size), cp.size);
				rep.equal(rid, "hash", hash, cp.hash);
				rep.equal(rid, "rest", rest, got.value ?? new Uint8Array(0));
				if (rest === "" && got.value !== undefined) {
					rep.fail(rid, "rest: go returned nil, ts returned an empty array");
				}
			}
			rep.assertClean(
				7000,
				["invalid-utf8-text", "checkpoint-origin-utf8", "numerror-quote-bound"],
				["invalid-utf8-text", "checkpoint-origin-utf8", "numerror-quote-bound"],
			);
		});

		it("Checkpoint.marshal and id produce Go's bytes", async () => {
			const f = await corpus();
			const rep = new DifferentialReport("Checkpoint.marshal/id");
			for (const [origin, size, hash, out] of f.marshal) {
				rep.record();
				const cp = new Checkpoint({ origin, size: u64(size), hash: hexToBytes(hash) });
				rep.equal(`origin=${JSON.stringify(origin)} size=${size} hash=${hash}`, "marshal", out, cp.marshal());
			}
			for (const [origin, want] of f.id) {
				rep.record();
				rep.equal(`origin=${JSON.stringify(origin)}`, "id", want, id(origin));
			}
			rep.assertClean(400);
		});

		it("parseCheckpoint reaches Go's verdict over signed, mutated checkpoints", async () => {
			const f = await corpus();
			const rep = new DifferentialReport("parseCheckpoint");
			const logV = newVerifier(f.keys.log);
			const others: Record<string, Verifier> = { w: newVerifier(f.keys.witness), a: newVerifier(f.keys.alt) };
			for (const row of f.parse) {
				rep.record();
				const [msg, expected, otherKeys, err, sigs] = row;
				const vs = [...otherKeys].map((k) => others[k] as Verifier);
				const got = attempt(() => parseCheckpoint(hexToBytes(msg), expected, logV, ...vs));
				const rid = `msg=${msg.slice(0, 80)}… expected=${expected} others=${otherKeys}`;
				if (err !== "") {
					if (got.ok) {
						rep.fail(rid, `go rejected (${err}), ts accepted`);
						continue;
					}
					rep.equal(rid, "err", err, messageOf(got.error));
					const note = got.error instanceof ParseCheckpointError ? got.error.note : undefined;
					rep.equal(rid, "note sigs", sigs, note === undefined ? -1 : (note.sigs?.length ?? 0));
					continue;
				}
				const [, , , , , origin, size, hash, other] = row as Extract<ParseRow, { length: 9 }>;
				if (!got.ok) {
					const n = hash.length / 2;
					const note = got.error instanceof ParseCheckpointError ? got.error.note : undefined;
					if (
						n !== 32 &&
						messageOf(got.error) ===
							`failed to unmarshal checkpoint: invalid checkpoint - root hash has unexpected size ${n}, want 32` &&
						(note?.sigs?.length ?? -1) === sigs
					) {
						rep.diverge("checkpoint-root-hash-size");
					} else {
						rep.fail(rid, `go accepted, ts rejected: ${messageOf(got.error)}`);
					}
					continue;
				}
				rep.equal(rid, "sigs", sigs, got.value.note.sigs?.length ?? 0);
				rep.equal(rid, "origin", origin, got.value.checkpoint.origin);
				rep.equal(rid, "size", u64(size), got.value.checkpoint.size);
				rep.equal(rid, "hash", hash, got.value.checkpoint.hash);
				rep.equal(rid, "otherData", other, got.value.otherData ?? new Uint8Array(0));
			}
			rep.assertClean(150, ["checkpoint-root-hash-size"], ["checkpoint-root-hash-size"]);
		});
	});
}
