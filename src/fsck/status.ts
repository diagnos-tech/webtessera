// Copyright 2025 The Tessera authors. All Rights Reserved.
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
// Ported from tessera/fsck/status.go @ 4a6d9f9
//
// Port note: `State` is a Go `uint8` with a `String()` method. TypeScript primitives
// cannot carry instance methods, so `State` is a `number` alias plus top-level exported
// constants (mirroring Go's `iota` block exactly, per docs/decisions/0002's "exported
// const -> unchanged" rule) and a standalone `stateString` function standing in for the
// method. See docs/decisions/0091-fsck-translation-choices.md.
//
// Port note: Go's `mu *sync.Mutex` field on rangeTracker is dropped. Every method here
// (`update`, `ranges`, `dumpRanges`) is purely synchronous -- no `await` anywhere in its
// body -- so JavaScript's run-to-completion semantics already guarantee no two calls
// interleave, even though fsck.ts's resourceCheckWorkers call `update` from
// independently-scheduled async functions. See
// docs/decisions/0004-errors-context-and-concurrency.md.

import { TileHeight, TileWidth } from "../api/layout/index.ts";
import { type Element, type List, newList } from "../internal/gostd/list.ts";

// State represents the state of a given static resource.
//
// Port note: `type State uint8` -> `number`, per docs/decisions/0003-uint64-as-bigint.md's
// "uint8 stays number" rule.
export type State = number;

// Unchecked represents the state of resources which hasn't yet been checked.
export const Unchecked: State = 0;
// Fetching is the state of a resource being retrieved from the target log.
export const Fetching: State = 1;
// FetchError is the state of a failed fetch.
export const FetchError: State = 2;
// Fetched represents a resource which has been fetched, but not yet processed.
export const Fetched: State = 3;
// Calculating represents a resource being used to calculate hashes.
export const Calculating: State = 4;
// OK represents a resource which was successfully verified.
export const OK: State = 5;
// Invalid represents a resource which was determined to be incorrect or invalid somehow.
export const Invalid: State = 6;

/**
 * stateString returns a string representation of the state.
 *
 * Port note: stands in for Go's `(s State) String() string` method -- see the file
 * header. Callers that formatted a State via `%v`/`%s` in Go (Range.String,
 * rangeTracker.dumpRanges) call this explicitly instead.
 */
export function stateString(s: State): string {
	switch (s) {
		case Unchecked:
			return "Unchecked";
		case Fetching:
			return "Fetching";
		case FetchError:
			return "FetchError";
		case Fetched:
			return "Fetched";
		case Calculating:
			return "Calculating";
		case OK:
			return "OK";
		case Invalid:
			return "Invalid";
		default:
			throw new Error(`unknown state ${s}`);
	}
}

/**
 * rangeTracker is a struct which knows how to maintain the state of all resources in a log.
 *
 * Resources in a given "level" (i.e. tile level or entry bundle) are represented as ranges with a given state.
 * Resources covered by a given range must, by definition, all share the same state.
 * Initially there is a single range at each level with covers the entire set of resources at that level, e.g. all entry bundles.
 * When individual resources in the range have their state updated, the range which contains that resource is split (into either
 * two or three ranges) such that we can continue to represent all elements while honouring the one-state-per-range invariant.
 * In some situations, updates to resources will mean that there are two adjacent ranges which have the same state, and any such
 * ranges are coalescent into a single larger range which covers the union.
 *
 * In this way, we can represent the state of all resources in the log in an efficient scheme.
 * Due to the way the fsck tool works, the number of ranges is expected to be relatively small:
 *   - the entire tree starts in state Unknown
 *   - As the checking progresses, the left hand side of the tree will mostly be in the OK state,
 *     and the right hand side will mostly be Unknown, with some range fragmentation in the middle (Fetching, Calculating, etc.)
 *   - Eventually, all the ranges will (hopefully) return to being OK.
 *
 * Port note: unexported in Go (`rangeTracker`), but reached directly by upstream's own
 * status_test.go (`s.entries.Front()`, `s.dumpRanges()`). Exported and marked `@internal`
 * per docs/decisions/0010-package-private-members.md; not re-exported from
 * `src/fsck/index.ts`.
 *
 * Port note: declaration order. Go defines this struct, then `Range`, then
 * `newRangeTracker`, then the two `maybeMergeWith*` helpers, and only *then* attaches
 * `Update`/`Ranges`/`dumpRanges` as methods at the bottom of the file (status.go:181-292).
 * TypeScript classes require every method to live inside the class body, so those three
 * methods are pulled forward into this class immediately after the constructor; every
 * declaration outside this class (`Range`, `newRangeTracker`, `maybeMergeWithPrev`,
 * `maybeMergeWithNext`) keeps Go's original relative order below. This is a mechanical
 * consequence of TypeScript's class syntax, not a judgement call.
 */
export class rangeTracker {
	/**
	 * @internal tiles holds information about the tiles in each level of the log, with tiles[0] being the
	 * lowest level tiles, just above the entries.
	 * The elements in this list are all Range instances.
	 */
	_tiles: List<Range>[];
	/**
	 * @internal entries holds information about the entrybundles in the log. The list elements are all
	 * Range instances.
	 */
	_entries: List<Range>;

	/**
	 * @internal Stands in for Go's `&rangeTracker{...}` composite literal; construct via
	 * {@link newRangeTracker}.
	 */
	constructor(entries: List<Range>, tiles: List<Range>[]) {
		this._entries = entries;
		this._tiles = tiles;
	}

	/**
	 * update updates the range state representation with the new state for the static resource at the given index.
	 * level is the tile level if it's >= 0, or an entry bundle if it's == -1.
	 */
	update(l: number, idx: bigint, state: State): void {
		let list: List<Range>;
		if (l === -1) {
			list = this._entries;
		} else if (l < this._tiles.length) {
			list = this._tiles[l] as List<Range>;
		} else {
			throw new Error(`no such tile level ${l}`);
		}

		for (let p = list.front(); p !== null; p = p.next()) {
			const v = p.value;
			if (!v.contains(idx)) {
				continue;
			}
			if (v.state === state) {
				return;
			}
			const r = new Range(idx, 1n, state);

			if (v.n === 1n) {
				// If this range has 1 element, then just change the state of the range.
				// This may mean we can coalesce this range with the previous and/or next range.
				v.state = state;
				maybeMergeWithPrev(p, list);
				maybeMergeWithNext(p, list);
			} else if (v.first === idx) {
				// If we're changing the state of the first element in a range, then cleave that off into its
				// own range and insert it into the list before this one.
				const e = list.insertBefore(r, p);
				v.first++;
				v.n--;
				maybeMergeWithPrev(e, list);
			} else if (v.first + v.n - 1n === idx) {
				// If we're changing the state of the last element in a range, then cleave that last element off
				// into its own range and add it after this one.
				const e = list.insertAfter(r, p);
				v.n--;
				maybeMergeWithNext(e, list);
			} else {
				// We're changing an element somewhere in the middle of the range, so we want to split this range
				// up into 3 parts:
				//   - a prefix range
				//   - a range consisting of one element whose state we're changing
				//   - a suffix range
				const suffix = new Range(r.first + 1n, v.n - (idx - v.first) - 1n, v.state);
				// Turn the current range into the prefix range:
				v.n = idx - v.first;
				// Add the single element range:
				const e = list.insertAfter(r, p);
				// Add the suffix range:
				list.insertAfter(suffix, e as Element<Range>);
			}
			return;
		}
		const dump = this.dumpRanges();
		throw new Error(`walked off end of range with idx ${idx}. List:\n${dump.join("\n")}`);
	}

	/**
	 * ranges returns a snapshot of the current status of resources in the log.
	 *
	 * Returns:
	 *   - entries: one or more contiguous Range structs which cover all the entry bundles
	 *   - tiles: a slice of Range[] which perform the same function for the internal Merkle tree levels, with the
	 *     zeroth entry being the bottom-most level of the tree, just above the entry bundles.
	 *
	 * Port note: Go returns `([]Range, [][]Range)` positionally; see
	 * docs/decisions/0031-multi-value-returns.md. Named `entries`/`tiles` after the doc
	 * comment above. Go's `eRange = append(eRange, *v)` dereferences the list's `*Range`
	 * to copy the *value* into the returned slice, so later mutation of the tracker's
	 * internal ranges cannot retroactively change an already-returned snapshot; `Range`
	 * is a class here (a reference type), so each entry is explicitly cloned with
	 * `new Range(...)` to preserve that same snapshot independence.
	 */
	ranges(): { entries: Range[]; tiles: Range[][] } {
		const eRange: Range[] = [];
		for (let p = this._entries.front(); p !== null; p = p.next()) {
			const v = p.value;
			eRange.push(new Range(v.first, v.n, v.state));
		}

		const tRanges: Range[][] = [];
		for (const t of this._tiles) {
			const tr: Range[] = [];
			for (let p = t.front(); p !== null; p = p.next()) {
				const v = p.value;
				tr.push(new Range(v.first, v.n, v.state));
			}
			tRanges.push(tr);
		}
		return { entries: eRange, tiles: tRanges };
	}

	/**
	 * dumpRanges returns a string suitable for logging/printing to std out to help debug the internal
	 * state of the tracked ranges.
	 */
	dumpRanges(): string[] {
		const d: string[] = [];
		for (let p = this._entries.front(); p !== null; p = p.next()) {
			const v = p.value;
			d.push(`([${v.first}:${v.first + v.n}): ${stateString(v.state)}`);
		}
		return d;
	}
}

/**
 * Range describes the common state of a range of bundles/tiles.
 * The range covers [First, First+N) in tile-space, and all resources in the range share the same State.
 */
export class Range {
	/** first is the index of the first resource covered by this range. */
	first: bigint;
	/** n is the number of resources covered by this range. */
	n: bigint;
	/** state is the state all resources covered by this range have. */
	state: State;

	constructor(first: bigint, n: bigint, state: State = Unchecked) {
		this.first = first;
		this.n = n;
		this.state = state;
	}

	/** toString returns a simple human readable representation of the range. Port of `(*Range) String`. */
	toString(): string {
		return `[${this.first}, ${this.first + this.n}):${stateString(this.state)}`;
	}

	// containts returns true iff the provided index is covered by this range.
	contains(idx: bigint): boolean {
		return idx >= this.first && idx < this.first + this.n;
	}
}

// Port note: the constants below are untyped in Go, so each use site adopts whichever
// integer type it needs. See docs/decisions/0030-untyped-go-constants.md.
const tileHeight64 = BigInt(TileHeight);
const tileWidth64 = BigInt(TileWidth);

// newRangeTracker constructs a new tracker for a log of the given size.
export function newRangeTracker(logSize: bigint): rangeTracker {
	const el = newList<Range>();
	const t: List<Range>[] = [];
	for (let level = 0, levelSize = logSize; levelSize > 0n; level++, levelSize >>= tileHeight64) {
		let n = levelSize >> tileHeight64;
		if (levelSize % tileWidth64 > 0n) {
			n++;
		}
		if (level === 0) {
			el.pushBack(new Range(0n, n, Unchecked));
		}
		const l = newList<Range>();
		l.pushBack(new Range(0n, n, Unchecked));
		t.push(l);
	}

	return new rangeTracker(el, t);
}

/**
 * maybeMergeWithPrev merges the provided Range element with the Range element before it
 * in the list into a single larger range, iff they share the same state.
 */
function maybeMergeWithPrev(e: Element<Range> | null, l: List<Range>): void {
	if (e === null) {
		return;
	}
	const ev = e.value;
	const p = e.prev();
	if (p !== null) {
		const pv = p.value;
		if (pv.state === ev.state) {
			ev.n += pv.n;
			ev.first = pv.first;
			l.remove(p);
		}
	}
}

/**
 * maybeMergeWithNext merges the provided Range element with the Range element after it
 * in the list into a single larger range, iff they share the same state.
 */
function maybeMergeWithNext(e: Element<Range> | null, l: List<Range>): void {
	if (e === null) {
		return;
	}
	const ev = e.value;
	const n = e.next();
	if (n !== null) {
		const nv = n.value;
		if (nv.state === ev.state) {
			ev.n += nv.n;
			l.remove(n);
		}
	}
}
