// Copyright 2024 Google LLC. All Rights Reserved.
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
//
// Ported from tessera/api/layout/paths.go @ 4a6d9f9

// Module layout contains routines for specifying the path layout of Tessera logs,
// which is really to say that it provides functions to calculate paths used by the
// [tlog-tiles API].
//
// [tlog-tiles API]: https://c2sp.org/tlog-tiles

import { asUint64, MaxUint64 } from "../../internal/gostd/bits.ts";
import { parseUint } from "../../internal/gostd/strconv.ts";
import { EntryBundleWidth, partialTileSize, TileWidth } from "./tile.ts";

/** CheckpointPath is the location of the file containing the log checkpoint. */
export const CheckpointPath = "checkpoint";

// Port note: see the note in tile.ts — the spec constants are exported as `number`,
// and the uint64 arithmetic below uses these bigint companions.
// See docs/decisions/0030-untyped-go-constants.md.
const entryBundleWidth64 = BigInt(EntryBundleWidth);
const tileWidth64 = BigInt(TileWidth);

/**
 * EntriesPathForLogIndex builds the local path at which the leaf with the given index lives in.
 * Note that this will be an entry bundle containing up to 256 entries and thus multiple
 * indices can map to the same output path.
 * The logSize is required so that a partial qualifier can be appended to tiles that
 * would contain fewer than 256 entries.
 */
export function entriesPathForLogIndex(seq: bigint, logSize: bigint): string {
	const tileIndex = seq / entryBundleWidth64;
	return entriesPath(tileIndex, partialTileSize(0n, tileIndex, logSize));
}

/**
 * Range returns an iterator over a list of RangeInfo structs which describe the bundles/tiles
 * necessary to cover the specified range of individual entries/hashes `[from, min(from+N, treeSize) )`.
 *
 * If from >= treeSize or N == 0, the returned iterator will yield no elements.
 *
 * Port note: Go's `iter.Seq[RangeInfo]` becomes a generator (PORTING.md §3.5). Upstream's
 * `if !yield(ri) { return }` early exit is what a consumer's `break` does to a generator,
 * so it needs no equivalent here.
 *
 * Port note: `from+N` and `endInc` wrap as Go's uint64 arithmetic does, so a request whose
 * end overflows yields exactly the bundles Go yields. In the one case where that overflow
 * makes Go's `uint` count N itself wrap (a single bundle whose wrapped end falls before
 * First), the result does not fit RangeInfo.n's `number` and a RangeError is thrown
 * instead. See docs/decisions/0014-uint64-wrapping-made-explicit.md.
 */
export function* range(from: bigint, N: bigint, treeSize: bigint): Generator<RangeInfo> {
	// Range is empty if we're entirely beyond the extent of the tree, or we've been asked for zero items.
	if (from >= treeSize || N === 0n) {
		return;
	}
	// Truncate range at size of tree if necessary.
	if (asUint64(from + N) > treeSize) {
		N = treeSize - from;
	}

	const endInc = asUint64(from + N - 1n);
	const sIndex = from / entryBundleWidth64;
	const eIndex = endInc / entryBundleWidth64;

	for (let idx = sIndex; idx <= eIndex; idx++) {
		const ri: RangeInfo = {
			index: idx,
			partial: 0,
			first: 0,
			n: EntryBundleWidth,
		};

		if (ri.index === sIndex) {
			ri.partial = partialTileSize(0n, sIndex, treeSize);
			ri.first = Number(from % entryBundleWidth64);
			ri.n = EntryBundleWidth - ri.first;

			// Handle corner-case where the range is entirely contained in first bundle, if applicable:
			if (ri.index === eIndex) {
				ri.n = uintToNumber(asUint64((endInc % entryBundleWidth64) - BigInt(ri.first) + 1n));
			}
		} else if (ri.index === eIndex) {
			ri.partial = partialTileSize(0n, eIndex, treeSize);
			ri.n = Number(endInc % entryBundleWidth64) + 1;
		}

		yield ri;
	}
}

/**
 * RangeInfo describes a specific range of elements within a particular bundle/tile.
 *
 * Usage:
 *
 *	const bundleRaw = await fetchBundle(..., ri.index, ri.partial);
 *	const bundle = parseBundle(bundleRaw);
 *	const elements = bundle.entries.slice(ri.first, ri.first + ri.n);
 */
export interface RangeInfo {
	/** index is the index of the entry bundle/tile in the tree. */
	index: bigint;
	/** partial is the partial size of the bundle/tile, or zero if a full bundle/tile is expected. */
	partial: number;
	/** first is the offset into the entries contained by the bundle/tile at which the range starts. */
	first: number;
	/** n is the number of entries, starting at first, which are covered by the range. */
	n: number;
}

/**
 * NWithSuffix returns a tiles-spec "N" path, with a partial suffix if p > 0.
 *
 * Port note: `l` is unused, exactly as in the Go original. It is kept so that the
 * signature still matches upstream's.
 */
// biome-ignore lint/correctness/noUnusedFunctionParameters: `l` mirrors the upstream signature (see port note above).
export function nWithSuffix(l: bigint, n: bigint, p: number): string {
	let suffix = "";
	if (p > 0) {
		suffix = `.p/${p}`;
	}
	return `${fmtN(n)}${suffix}`;
}

/**
 * EntriesPath returns the local path for the nth entry bundle. p denotes the partial
 * tile size, or 0 if the tile is complete.
 */
export function entriesPath(n: bigint, p: number): string {
	return `tile/entries/${nWithSuffix(0n, n, p)}`;
}

/**
 * TilePath builds the path to the subtree tile with the given level and index in tile space.
 * If p > 0 the path represents a partial tile.
 */
export function tilePath(tileLevel: bigint, tileIndex: bigint, p: number): string {
	return `tile/${tileLevel}/${nWithSuffix(tileLevel, tileIndex, p)}`;
}

// fmtN returns the "N" part of a Tiles-spec path.
//
// N is grouped into chunks of 3 decimal digits, starting with the most significant digit, and
// padding with zeroes as necessary.
// Digit groups are prefixed with "x", except for the least-significant group which has no prefix,
// and separated with slashes.
//
// See https://github.com/C2SP/C2SP/blob/main/tlog-tiles.md#:~:text=index%201234067%20will%20be%20encoded%20as%20x001/x234/067
function fmtN(N: bigint): string {
	let n = fmt03d(N % 1000n);
	N /= 1000n;
	while (N > 0n) {
		n = `x${fmt03d(N % 1000n)}/${n}`;
		N /= 1000n;
	}
	return n;
}

/**
 * TileLevelIndexPartial is what ParseTileLevelIndexPartial returns.
 *
 * Port note: Go returns the three values positionally. See
 * docs/decisions/0031-multi-value-returns.md.
 */
export interface TileLevelIndexPartial {
	/** level is the tile level, in tile space. */
	readonly level: bigint;
	/** index is the tile index at that level, in tile space. */
	readonly index: bigint;
	/** width is the partial tile width, or 0 for a full tile. */
	readonly width: number;
}

/**
 * ParseTileLevelIndexPartial takes level and index in string, validates and returns the level, index and width in uint64.
 *
 * Examples:
 * "/tile/0/x001/x234/067" means level 0 and index 1234067 of a full tile.
 * "/tile/0/x001/x234/067.p/8" means level 0, index 1234067 and width 8 of a partial tile.
 */
export function parseTileLevelIndexPartial(level: string, index: string): TileLevelIndexPartial {
	const l = parseTileLevel(level);

	const { index: i, width: w } = parseTileIndexPartial(index);

	return { level: l, index: i, width: w };
}

/** ParseTileLevel takes level in string, validates and returns the level in uint64. */
export function parseTileLevel(level: string): bigint {
	const l = tryParseUint(level);
	// Verify that level is an integer between 0 and 63 as specified in the tlog-tiles specification.
	if (l === undefined || l > 63n) {
		throw new Error("failed to parse tile level");
	}
	return l;
}

/**
 * TileIndexPartial is what ParseTileIndexPartial returns.
 *
 * Port note: Go returns the two values positionally. See
 * docs/decisions/0031-multi-value-returns.md.
 */
export interface TileIndexPartial {
	/** index is the tile index, in tile space. */
	readonly index: bigint;
	/** width is the partial tile width, or 0 for a full tile. */
	readonly width: number;
}

/** ParseTileIndexPartial takes index in string, validates and returns the index and width in uint64. */
export function parseTileIndexPartial(index: string): TileIndexPartial {
	let w = 0;
	let indexPaths = index.split("/");

	if (index.includes(".p")) {
		const w64 = tryParseUint(indexPaths[indexPaths.length - 1] as string);
		if (w64 === undefined || w64 < 1n || w64 >= tileWidth64) {
			throw new Error("failed to parse tile width");
		}
		w = Number(w64);
		// Port note: Go indexes indexPaths[len-2] unguarded. That is unreachable with a
		// single-element slice, because such an element still contains ".p" and so cannot
		// have parsed as a width above.
		indexPaths[indexPaths.length - 2] = trimSuffix(indexPaths[indexPaths.length - 2] as string, ".p");
		indexPaths = indexPaths.slice(0, indexPaths.length - 1);
	}

	if (count(index, "x") !== indexPaths.length - 1 || (indexPaths[indexPaths.length - 1] as string).startsWith("x")) {
		throw new Error("failed to parse tile index");
	}

	let i = 0n;
	for (let indexPath of indexPaths) {
		indexPath = trimPrefix(indexPath, "x");
		const n = tryParseUint(indexPath);
		if (n === undefined || n >= 1000n || indexPath.length !== 3) {
			throw new Error("failed to parse tile index");
		}
		if (i > (MaxUint64 - n) / 1000n) {
			throw new Error("failed to parse tile index");
		}
		i = i * 1000n + n;
	}

	return { index: i, width: w };
}

// Below this line are the small pieces of Go's `fmt` and `strings` that this file
// leans on. They are local because they are one-liners over TypeScript built-ins;
// anything with real behaviour of its own lives in src/internal/gostd/.

// uintToNumber narrows a Go `uint` result to the `number` RangeInfo carries, throwing a
// RangeError when it does not fit exactly; see the Port note on range.
function uintToNumber(v: bigint): number {
	if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new RangeError(`RangeInfo count ${v} does not fit in a number`);
	}
	return Number(v);
}

// fmt03d renders v the way Go's `fmt.Sprintf("%03d", v)` does: decimal, zero-padded to
// a minimum width of three digits, and never truncated — a value of 1000 or more prints
// in full.
function fmt03d(v: bigint): string {
	return v.toString().padStart(3, "0");
}

// tryParseUint is `n, err := strconv.ParseUint(s, 10, 64)` in the shape this file uses
// it: every call site here folds a parse failure into its own generic error message, so
// the failure is reported as undefined rather than thrown.
function tryParseUint(s: string): bigint | undefined {
	try {
		return parseUint(s, 10, 64);
	} catch {
		return undefined;
	}
}

// trimPrefix mirrors `strings.TrimPrefix`.
function trimPrefix(s: string, prefix: string): string {
	return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

// trimSuffix mirrors `strings.TrimSuffix`.
function trimSuffix(s: string, suffix: string): string {
	return suffix.length > 0 && s.endsWith(suffix) ? s.slice(0, s.length - suffix.length) : s;
}

// count mirrors `strings.Count` for a non-empty substr.
function count(s: string, substr: string): number {
	return s.split(substr).length - 1;
}
