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

// The data model behind the golden compatibility suite (./golden.ts): what the real Tessera
// POSIX driver left on disk for each fixtures/data/log_<N>.json, and which extra keys a store
// may legitimately hold once a log has grown through other batch boundaries. Everything here
// is derived from the fixtures and from the tlog-tiles layout rules, never from the driver
// under test, so that the suite's expectations cannot drift along with a bug. Plain functions
// with no test-framework dependency; test-only, excluded from the published build.

import { tilePath } from "../../../api/layout/index.ts";
import { newAppendOptions } from "../../../append_lifecycle.ts";
import { toUTF8 } from "../../../internal/gostd/bytes.ts";
import { hexToBytes, loadFixture } from "../../../testonly/fixtures.ts";

/** resourceFile is one file of a fixture log: its path relative to the log root and its exact bytes. */
interface resourceFile {
	readonly path: string;
	readonly raw: string;
}

/** LogFixture is the part of fixtures/data/log_<N>.json (fixtures/gen/log.go) the suite reads. */
export interface LogFixture {
	readonly size: string;
	/** checkpoint is the signed checkpoint, exactly as the POSIX driver published it. */
	readonly checkpoint: string;
	readonly tiles: readonly resourceFile[];
	readonly entryBundles: readonly resourceFile[];
	/** state is the driver's private .state/ files (lock files aside), exactly as Go wrote them. */
	readonly state: readonly resourceFile[];
}

/**
 * goldenSizes are the log sizes fixtures/gen/log.go builds: the empty log, a single entry, the
 * sizes either side of a full bottom tile, the first size with a level-1 tile, and two sizes deep
 * into multi-tile territory.
 */
export const goldenSizes: readonly number[] = [0, 1, 2, 255, 256, 257, 1000, 5000];

/**
 * logSKey is fixtures/gen/note.go's logSKey, the key every log_<N> checkpoint is signed with. It
 * is a published test key and protects nothing; Ed25519 signatures are deterministic, so a port
 * signing the same checkpoint body with it must produce the same bytes as Go.
 */
export const logSKey = "PRIVATE+KEY+webtessera.fixture.log+dc00151b+AcwDSjtCWhsc7xNHRYufTeqK6/OA73GaH/GCwyT1xsvP";

/** stateDir is the prefix under which both drivers keep their private, non-tlog-tiles state. */
export const stateDir = ".state/";

/** loadLog loads fixtures/data/log_<size>.json. */
export function loadLog(size: number): Promise<LogFixture> {
	return loadFixture<LogFixture>(`log_${size}`);
}

/** entryData reproduces fixtures/gen/log.go's entry scheme: entry i is the UTF-8 bytes of "entry-<i>". */
export function entryData(i: number): Uint8Array {
	return toUTF8(`entry-${i}`);
}

/** publicFiles returns a fixture's tlog-tiles resources, checkpoint included, keyed by path. */
export function publicFiles(fx: LogFixture): Map<string, Uint8Array> {
	const m = new Map<string, Uint8Array>();
	for (const r of [...fx.tiles, ...fx.entryBundles]) {
		m.set(r.path, hexToBytes(r.raw));
	}
	m.set("checkpoint", hexToBytes(fx.checkpoint));
	return m;
}

/** stateFiles returns the .state/ files Go's POSIX driver wrote for the fixture, keyed by path. */
export function stateFiles(fx: LogFixture): Map<string, Uint8Array> {
	return new Map(fx.state.map((r) => [r.path, hexToBytes(r.raw)]));
}

/** stateFile returns the bytes Go wrote at one .state/ path for the fixture, failing if it wrote none. */
export function stateFile(fx: LogFixture, path: string): Uint8Array {
	const raw = stateFiles(fx).get(path);
	if (raw === undefined) {
		throw new Error(`log_${fx.size} records no ${path}; regenerate the fixtures with "bun run fixtures"`);
	}
	return raw;
}

/**
 * partialKeysAt returns the keys of the partial resources on the right-hand edge of a tree of
 * the given size: the ones a batch ending at that size writes, and the ones a client asks for
 * when it reads a tree of that size.
 */
export function partialKeysAt(size: bigint): string[] {
	const entriesPath = newAppendOptions().entriesPath();
	const r: string[] = [];
	for (let l = 0n, c = size; c > 0n; l++, c >>= 8n) {
		const idx = c / 256n;
		const p = Number(c % 256n);
		if (p !== 0) {
			if (l === 0n) {
				r.push(entriesPath(idx, p));
			}
			r.push(tilePath(l, idx, p));
		}
	}
	return r;
}

/** dirOf returns the directory part of a key, trailing slash included: the prefix a GC removes. */
function dirOf(key: string): string {
	return key.slice(0, key.lastIndexOf("/") + 1);
}

/**
 * expectedPublicKeys returns the public keys a store must hold once a log has grown through
 * the given batch end sizes (the size the log started from included) to the fixture's size:
 * the fixture's resources, plus every superseded partial version those batches wrote.
 *
 * The POSIX driver keeps those superseded partials too, as files (see supersededPartial for why
 * its symlinking of partial tiles does not change that in practice). After a GC at the final
 * size only the superseded partials in a partial directory of the final tree survive, because
 * garbageCollect, like posix's, removes the `.p/` directories of full resources only.
 */
export function expectedPublicKeys(fx: LogFixture, batchEnds: readonly bigint[], afterGC: boolean): string[] {
	const keep = new Set(partialKeysAt(BigInt(fx.size)).map(dirOf));
	const keys = new Set(publicFiles(fx).keys());
	for (const end of batchEnds) {
		for (const k of partialKeysAt(end)) {
			if (!afterGC || keep.has(dirOf(k))) {
				keys.add(k);
			}
		}
	}
	return [...keys].sort();
}

/** partialPattern splits a partial resource key into the full resource's key and the partial width. */
const partialPattern = /^(.+)\.p\/([1-9][0-9]*)$/;

/**
 * supersededPartial returns the bytes a superseded partial resource must hold, given want, the
 * final tree's resources.
 *
 * tlog-tiles resources only ever grow on the right, so a partial version is a prefix of every
 * later version of the same resource: the first w hashes of the tile, or the first w entries of
 * the bundle, which is what Go's POSIX driver wrote at the path. posix's writeTile means to
 * replace superseded partial tiles with symlinks to the full tile (the relinking
 * docs/decisions/0101-objectstore-partial-tiles-not-relinked.md declines to port), but it lists
 * them with a glob relative to the process's working directory rather than the log root, so
 * unless the log root is the working directory the files stay exactly as written:
 * docs/decisions/0162-bidirectional-go-interop-harness.md has the evidence.
 */
export function supersededPartial(key: string, want: ReadonlyMap<string, Uint8Array>): Uint8Array {
	const m = partialPattern.exec(key);
	if (m === null) {
		throw new Error(`${key} is not a partial resource`);
	}
	const [, base = "", width = ""] = m;
	const w = Number(width);
	const latest = want.get(base) ?? [...want].find(([k]) => k.startsWith(`${base}.p/`))?.[1];
	if (latest === undefined) {
		throw new Error(`the final tree has no version of ${key}`);
	}
	return base.startsWith("tile/entries/") ? bundlePrefix(latest, w) : latest.subarray(0, w * 32);
}

/**
 * bundlePrefix returns the leading n entries of a tlog-tiles entry bundle: each entry is a
 * big-endian uint16 length followed by that many bytes.
 */
function bundlePrefix(bundle: Uint8Array, n: number): Uint8Array {
	let off = 0;
	for (let i = 0; i < n && off + 2 <= bundle.length; i++) {
		off += 2 + (((bundle[off] ?? 0) << 8) | (bundle[off + 1] ?? 0));
	}
	return bundle.subarray(0, off);
}

/** batchEndsOf returns the sizes at which batches of batchSize end when growing a log from `from` to `to`. */
export function batchEndsOf(from: number, to: number, batchSize: number): bigint[] {
	const ends: bigint[] = [BigInt(from)];
	for (let s = from + batchSize; s < to; s += batchSize) {
		ends.push(BigInt(s));
	}
	ends.push(BigInt(to));
	return ends;
}
