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

// Golden-fixture coverage for api/layout/paths.ts.
//
// The tables here were emitted by running the real Tessera Go implementation
// (fixtures/gen), so a disagreement means this port is wrong — never the fixture
// (AGENTS.md §5). They are kept out of paths_test.ts so that file stays a
// line-for-line mirror of upstream's paths_test.go.
//
// The matrices are large (1210 tile paths, 726 suffixes), so each table is a single
// test that walks every case rather than 1210 test names.

import { beforeAll, describe, expect, it } from "vitest";
import { MaxUint64 } from "../../internal/gostd/bits.ts";
import { type Fixture, loadFixture, u64 } from "../../testonly/fixtures.ts";
import {
	CheckpointPath,
	entriesPath,
	entriesPathForLogIndex,
	nWithSuffix,
	parseTileIndexPartial,
	parseTileLevel,
	parseTileLevelIndexPartial,
	range,
	tilePath,
} from "./paths.ts";

interface LayoutPathsFixture {
	readonly checkpointPath: string;
	readonly nWithSuffix: readonly { level: string; index: string; p: number; want: string }[];
	readonly tilePath: readonly { tileLevel: string; tileIndex: string; p: number; want: string }[];
	readonly entriesPath: readonly { n: string; p: number; want: string }[];
	readonly entriesPathForLogIndex: readonly { seq: string; logSize: string; want: string }[];
}

interface LayoutParseFixture {
	readonly parseTileLevelIndexPartial: readonly {
		pathLevel: string;
		pathIndex: string;
		wantLevel: string;
		wantIndex: string;
		wantP: number;
		wantErr: boolean;
		wantErrMsg: string;
	}[];
	readonly parseTileLevel: readonly {
		pathLevel: string;
		wantLevel: string;
		wantErr: boolean;
		wantErrMsg: string;
	}[];
	readonly parseTileIndexPartial: readonly {
		pathIndex: string;
		wantIndex: string;
		wantP: number;
		wantErr: boolean;
		wantErrMsg: string;
	}[];
}

interface LayoutRangeFixture {
	readonly cases: readonly {
		desc: string;
		from: string;
		n: string;
		treeSize: string;
		want: readonly { index: string; partial: number; first: number; n: number }[];
	}[];
}

// errorMessage runs fn and returns the message it threw, or undefined if it returned.
function errorMessage(fn: () => void): string | undefined {
	try {
		fn();
		return undefined;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

describe("golden fixtures: layout_paths", () => {
	let fx: Fixture<LayoutPathsFixture>;

	beforeAll(async () => {
		fx = await loadFixture<LayoutPathsFixture>("layout_paths");
	});

	it("CheckpointPath", () => {
		expect(CheckpointPath).toBe(fx.checkpointPath);
	});

	it("nWithSuffix", () => {
		expect(fx.nWithSuffix.length).toBeGreaterThan(0);
		for (const c of fx.nWithSuffix) {
			const got = nWithSuffix(u64(c.level), u64(c.index), c.p);
			expect(got, `nWithSuffix(${c.level}, ${c.index}, ${c.p})`).toBe(c.want);
		}
	});

	it("tilePath", () => {
		expect(fx.tilePath.length).toBeGreaterThan(0);
		for (const c of fx.tilePath) {
			const got = tilePath(u64(c.tileLevel), u64(c.tileIndex), c.p);
			expect(got, `tilePath(${c.tileLevel}, ${c.tileIndex}, ${c.p})`).toBe(c.want);
		}
	});

	it("entriesPath", () => {
		expect(fx.entriesPath.length).toBeGreaterThan(0);
		for (const c of fx.entriesPath) {
			const got = entriesPath(u64(c.n), c.p);
			expect(got, `entriesPath(${c.n}, ${c.p})`).toBe(c.want);
		}
	});

	it("entriesPathForLogIndex", () => {
		expect(fx.entriesPathForLogIndex.length).toBeGreaterThan(0);
		for (const c of fx.entriesPathForLogIndex) {
			const got = entriesPathForLogIndex(u64(c.seq), u64(c.logSize));
			expect(got, `entriesPathForLogIndex(${c.seq}, ${c.logSize})`).toBe(c.want);
		}
	});
});

describe("golden fixtures: layout_parse", () => {
	let fx: Fixture<LayoutParseFixture>;

	beforeAll(async () => {
		fx = await loadFixture<LayoutParseFixture>("layout_parse");
	});

	it("parseTileLevel", () => {
		expect(fx.parseTileLevel.length).toBeGreaterThan(0);
		for (const c of fx.parseTileLevel) {
			const where = `parseTileLevel(${JSON.stringify(c.pathLevel)})`;
			if (c.wantErr) {
				expect(
					errorMessage(() => parseTileLevel(c.pathLevel)),
					where,
				).toBe(c.wantErrMsg);
				continue;
			}
			expect(parseTileLevel(c.pathLevel), where).toBe(u64(c.wantLevel));
		}
	});

	it("parseTileIndexPartial", () => {
		expect(fx.parseTileIndexPartial.length).toBeGreaterThan(0);
		for (const c of fx.parseTileIndexPartial) {
			const where = `parseTileIndexPartial(${JSON.stringify(c.pathIndex)})`;
			if (c.wantErr) {
				expect(
					errorMessage(() => parseTileIndexPartial(c.pathIndex)),
					where,
				).toBe(c.wantErrMsg);
				continue;
			}
			const got = parseTileIndexPartial(c.pathIndex);
			expect(got.index, `${where}.index`).toBe(u64(c.wantIndex));
			expect(got.width, `${where}.width`).toBe(c.wantP);
		}
	});

	it("parseTileLevelIndexPartial", () => {
		expect(fx.parseTileLevelIndexPartial.length).toBeGreaterThan(0);
		for (const c of fx.parseTileLevelIndexPartial) {
			const where = `parseTileLevelIndexPartial(${JSON.stringify(c.pathLevel)}, ${JSON.stringify(c.pathIndex)})`;
			if (c.wantErr) {
				expect(
					errorMessage(() => parseTileLevelIndexPartial(c.pathLevel, c.pathIndex)),
					where,
				).toBe(c.wantErrMsg);
				continue;
			}
			const got = parseTileLevelIndexPartial(c.pathLevel, c.pathIndex);
			expect(got.level, `${where}.level`).toBe(u64(c.wantLevel));
			expect(got.index, `${where}.index`).toBe(u64(c.wantIndex));
			expect(got.width, `${where}.width`).toBe(c.wantP);
		}
	});

	it("rejects indices that would overflow uint64", () => {
		// This boundary is the whole reason api/layout counts in bigint (ADR-0003), so
		// pick the overflowing cases out of the fixture by their actual value rather than
		// trusting that some case somewhere covers it. If the fixture ever stops carrying
		// one, this fails rather than passing vacuously.
		const overflow = fx.parseTileIndexPartial.filter((c) => {
			const digits = (c.pathIndex.split(".p/")[0] ?? "").replace(/[x/]/g, "");
			return /^[0-9]+$/.test(digits) && BigInt(digits) > MaxUint64;
		});
		expect(overflow.length).toBeGreaterThan(0);
		for (const c of overflow) {
			expect(c.wantErr, c.pathIndex).toBe(true);
			expect(
				errorMessage(() => parseTileIndexPartial(c.pathIndex)),
				c.pathIndex,
			).toBe(c.wantErrMsg);
		}
	});
});

describe("golden fixtures: layout_range", () => {
	let fx: Fixture<LayoutRangeFixture>;

	beforeAll(async () => {
		fx = await loadFixture<LayoutRangeFixture>("layout_range");
	});

	it("range", () => {
		expect(fx.cases.length).toBeGreaterThan(0);
		for (const c of fx.cases) {
			const got = [...range(u64(c.from), u64(c.n), u64(c.treeSize))];
			const want = c.want.map((w) => ({
				index: u64(w.index),
				partial: w.partial,
				first: w.first,
				n: w.n,
			}));
			expect(got, c.desc).toEqual(want);
		}
	});
});
