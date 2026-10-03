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

// Differential suite for api/layout over fixtures/data/differential_layout.json
// (fixtures/gen/differential_layout.go).

import { describe, it } from "vitest";
import {
	entriesPath,
	entriesPathForLogIndex,
	nWithSuffix,
	parseTileIndexPartial,
	parseTileLevel,
	parseTileLevelIndexPartial,
	type RangeInfo,
	range,
	tilePath,
} from "../../../api/layout/paths.ts";
import { nodeCoordsToTileAddress, partialTileSize } from "../../../api/layout/tile.ts";
import { loadFixture, u64 } from "../../fixtures.ts";
import { attempt, DifferentialReport, messageOf } from "../differential.ts";

interface LayoutCorpus {
	readonly index: readonly (readonly [index: string, err: string, tileIndex?: string, width?: number])[];
	readonly level: readonly (readonly [level: string, err: string, tileLevel?: string])[];
	readonly levelIndex: readonly (readonly [
		level: string,
		index: string,
		err: string,
		tileLevel?: string,
		tileIndex?: string,
		width?: number,
	])[];
	readonly paths: readonly (readonly [
		level: string,
		index: string,
		p: number,
		tilePath: string,
		entriesPath: string,
		nWithSuffix: string,
		logSize: string,
		entriesPathForLogIndex: string,
	])[];
	readonly tiles: readonly (readonly [
		level: string,
		index: string,
		logSize: string,
		partial: number,
		tileLevel: string,
		tileIndex: string,
		nodeLevel: number,
		nodeIndex: string,
	])[];
	readonly range: readonly (readonly [
		from: string,
		n: string,
		size: string,
		items: readonly (readonly [index: string, partial: number, first: string, n: string])[],
	])[];
}

function result<T>(f: () => T, render: (v: T) => string): string {
	const got = attempt(f);
	return got.ok ? render(got.value) : `err:${messageOf(got.error)}`;
}

/** describeLayoutDifferential registers the api/layout differential tests. */
export function describeLayoutDifferential(): void {
	describe("api/layout differential (differential_layout.json)", () => {
		it("parseTileIndexPartial, parseTileLevel and parseTileLevelIndexPartial reach Go's verdict", async () => {
			const f = await loadFixture<LayoutCorpus>("differential_layout");
			const rep = new DifferentialReport("tlog-tiles path parsers");
			for (const [s, err, idx, w] of f.index) {
				rep.record();
				rep.equal(
					`index=${JSON.stringify(s)}`,
					"parseTileIndexPartial",
					err === "" ? `ok:${idx}:${w}` : `err:${err}`,
					result(
						() => parseTileIndexPartial(s),
						(v) => `ok:${v.index}:${v.width}`,
					),
				);
			}
			for (const [s, err, lvl] of f.level) {
				rep.record();
				rep.equal(
					`level=${JSON.stringify(s)}`,
					"parseTileLevel",
					err === "" ? `ok:${lvl}` : `err:${err}`,
					result(
						() => parseTileLevel(s),
						(v) => `ok:${v}`,
					),
				);
			}
			for (const [l, s, err, lvl, idx, w] of f.levelIndex) {
				rep.record();
				rep.equal(
					`level=${JSON.stringify(l)} index=${JSON.stringify(s)}`,
					"parseTileLevelIndexPartial",
					err === "" ? `ok:${lvl}:${idx}:${w}` : `err:${err}`,
					result(
						() => parseTileLevelIndexPartial(l, s),
						(v) => `ok:${v.level}:${v.index}:${v.width}`,
					),
				);
			}
			rep.assertClean(4500);
		});

		it("path builders and tile arithmetic match Go over random uint64 coordinates", async () => {
			const f = await loadFixture<LayoutCorpus>("differential_layout");
			const rep = new DifferentialReport("tlog-tiles path builders");
			for (const [level, index, p, tp, ep, nws, logSize, epl] of f.paths) {
				rep.record();
				const rid = `level=${level} index=${index} p=${p} logSize=${logSize}`;
				const l = u64(level);
				const i = u64(index);
				rep.equal(
					rid,
					"tilePath",
					tp,
					result(() => tilePath(l, i, p), String),
				);
				rep.equal(
					rid,
					"entriesPath",
					ep,
					result(() => entriesPath(i, p), String),
				);
				rep.equal(
					rid,
					"nWithSuffix",
					nws,
					result(() => nWithSuffix(l, i, p), String),
				);
				rep.equal(
					rid,
					"entriesPathForLogIndex",
					epl,
					result(() => entriesPathForLogIndex(i, u64(logSize)), String),
				);
			}
			for (const [level, index, logSize, partial, tl, ti, nl, ni] of f.tiles) {
				rep.record();
				const rid = `level=${level} index=${index} logSize=${logSize}`;
				const l = u64(level);
				const i = u64(index);
				rep.equal(rid, "partialTileSize", partial, partialTileSize(l, i, u64(logSize)));
				const a = nodeCoordsToTileAddress(l, i);
				rep.equal(
					rid,
					"nodeCoordsToTileAddress",
					[tl, ti, nl, ni],
					[a.tileLevel, a.tileIndex, a.nodeLevel, a.nodeIndex],
				);
			}
			rep.assertClean(3000);
		});

		it("range yields Go's bundles, including where the request overflows 2^64", async () => {
			const f = await loadFixture<LayoutCorpus>("differential_layout");
			const rep = new DifferentialReport("layout.range");
			for (const [from, n, size, items] of f.range) {
				rep.record();
				const rid = `range(${from}, ${n}, ${size})`;
				const got: RangeInfo[] = [];
				const run = attempt(() => {
					for (const ri of range(u64(from), u64(n), u64(size))) {
						got.push(ri);
						if (got.length === 6) {
							break;
						}
					}
				});
				const ts = got.map((ri) => [String(ri.index), ri.partial, String(ri.first), String(ri.n)]);
				if (!run.ok) {
					// The one documented difference: a single bundle whose count wraps Go's uint.
					const wrapped = items[got.length];
					if (
						run.error instanceof RangeError &&
						wrapped !== undefined &&
						BigInt(wrapped[3]) > BigInt(Number.MAX_SAFE_INTEGER) &&
						rep.equal(rid, "items before the throw", items.slice(0, got.length), ts)
					) {
						rep.diverge("uint-count-overflow");
					} else {
						rep.fail(rid, `ts threw ${messageOf(run.error)}; go yielded ${JSON.stringify(items)}`);
					}
					continue;
				}
				rep.equal(rid, "items", items, ts);
			}
			rep.assertClean(700, ["uint-count-overflow"]);
		});
	});
}
