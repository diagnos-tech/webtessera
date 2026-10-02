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

// The golden compatibility suite: the proof, run by every storage backend, that a log written
// through webtessera onto that backend is byte for byte the log Tessera's own POSIX driver
// writes, and that a log Tessera wrote can be carried on by webtessera. See
// docs/compatibility.md for how this fits with the Go interop harness, and
// docs/decisions/0160-golden-compatibility-suite-for-every-backend.md for the design.
//
// fixtures/data/log_<N>.json is a complete log built by the real Tessera POSIX driver
// (fixtures/gen/log.go): every tile, every entry bundle, the signed checkpoint and the
// driver's private .state/ files, read back off disk. The fixture's signing key is a published
// test key and Ed25519 signatures are deterministic, so even the signed checkpoint must match
// byte for byte.
//
// # Contract
//
// describeGoldenCompatibility(name, newStore, options?) registers one describe block, named
// `${name}: golden compatibility with Tessera's POSIX driver`, holding the cases below.
//
//   - newStore returns a fresh, EMPTY store; every case calls it exactly once. The caller owns
//     the store's lifetime: close it in an afterEach, as callers of the conformance suites do.
//   - options.reopen(store) returns a second, independent handle onto the data store holds (a
//     new database connection, a second tab, a restarted Durable Object). Each session of the
//     restart cases runs over a fresh handle. It defaults to store itself.
//   - options.listKeys(store) returns every key the backend holds, through the backend's own
//     listing. When given, the exact key set is asserted through it. Without it, the suite
//     reads back every key ever written to the store (see KeyRecorder in ./golden_log.ts),
//     which catches a key dropped, left undeleted or stored under another name, but not one a
//     backend invents on its own. Pass it whenever the backend can enumerate its keys.
//   - options.sizes restricts which log_<N> fixtures run; it defaults to all of goldenSizes.
//     Restrict it only when a runtime genuinely cannot afford the larger sizes, and say why in
//     the calling file.
//   - options.timeout is each case's timeout in milliseconds.
//
// The suite uses only vitest, library code and src/testonly/fixtures.ts, whose loader is a
// bundler-resolved dynamic import, so it runs unchanged in Node, in real Chromium and in workerd.
//
// # What every case compares
//
//   - the exact set of public keys (everything outside .state/) the backend holds, against what
//     the POSIX driver holds for the same history of batch boundaries;
//   - the bytes of every one of them: each tile, entry bundle and the signed checkpoint the final
//     tree implies, byte-identical to the fixture; each superseded partial resource,
//     byte-identical to what POSIX wrote at that path (see supersededPartial);
//   - the private state: `.state/treeState` and `.state/version` byte-identical to the files Go
//     wrote, which is what lets a POSIX log directory and a store be exchanged in both
//     directions.
//
// # Cases
//
//   1. One batch, every size: the store holds exactly what Go's POSIX directory held.
//   2. Batches of 37, sizes above one tile: Go's resources plus exactly the superseded partials
//      those batch boundaries leave; after garbage collection, exactly what POSIX's GC leaves.
//   3. Restarts: a fresh driver (over a fresh handle) for each of several sessions, split at and
//      around tile boundaries; the log resumes from its own state and converges on Go's.
//   4. Go-written state continued by webtessera: the store is preloaded with a smaller fixture's
//      files, .state/ included, exactly as Go left them on disk, and appending the next entries
//      yields the larger fixture.
//
// Test-only: excluded from the published build.

import { describe, expect, it } from "vitest";
import { bytesEqual } from "../../../internal/gostd/bytes.ts";
import type { ObjectStoreDriver } from "../driver.ts";
import type { ObjectStore } from "../objectstore.ts";
import {
	batchEndsOf,
	expectedPublicKeys,
	goldenSizes,
	type LogFixture,
	loadLog,
	publicFiles,
	stateDir,
	stateFile,
	stateFiles,
	supersededPartial,
} from "./golden_fixtures.ts";
import { appendEntries, collectGarbage, goldenOptions, KeyRecorder, singleBatchOptions } from "./golden_log.ts";

export { goldenSizes } from "./golden_fixtures.ts";

/** GoldenCompatibilityOptions tunes describeGoldenCompatibility for a backend. See the file header. */
export interface GoldenCompatibilityOptions<S extends ObjectStore> {
	/** reopen returns a second, independent handle onto the data store holds. Defaults to store itself. */
	readonly reopen?: (store: S) => ObjectStore | Promise<ObjectStore>;
	/** listKeys returns every key the backend holds, through its own listing. */
	readonly listKeys?: (store: S) => readonly string[] | Promise<readonly string[]>;
	/** sizes are the log_<N> fixtures to run. Defaults to goldenSizes, all of them. */
	readonly sizes?: readonly number[];
	/** timeout is each case's timeout in milliseconds. Defaults to two minutes. */
	readonly timeout?: number;
}

/** defaultTimeout is generous: on Node every case takes well under a second, in Chromium a few. */
const defaultTimeout = 120_000;

/** batchSize37 matches the existing many-batch evidence: it does not divide 256, so batches straddle every tile. */
const batchSize37 = 37;

/**
 * restartPoints are where the restart cases stop one driver and start the next: on, just before
 * and just after the first bundle, tile and level-1 boundaries the fixtures reach.
 */
const restartPoints: readonly number[] = [1, 2, 255, 256, 257, 511, 512, 513, 1000, 4095, 4096, 4097];

/**
 * crossings are the (smaller, larger) fixture pairs the "Go-written state" cases grow one into
 * the other: from the empty log, within one bundle, onto and across the first tile boundary, and
 * from a multi-tile log with partial resources at two levels into a much larger one.
 */
const crossings: readonly (readonly [number, number])[] = [
	[0, 1],
	[1, 2],
	[2, 255],
	[255, 256],
	[255, 257],
	[256, 257],
	[257, 1000],
	[1000, 5000],
];

/** treeStatePath is the POSIX driver's integrated tree state file. */
const treeStatePath = `${stateDir}treeState`;

/**
 * describeGoldenCompatibility registers the golden compatibility suite for the backend whose
 * fresh, empty stores newStore returns. See the file header for the contract.
 */
export function describeGoldenCompatibility<S extends ObjectStore>(
	name: string,
	newStore: () => S | Promise<S>,
	options: GoldenCompatibilityOptions<S> = {},
): void {
	const sizes = options.sizes ?? goldenSizes;
	const timeout = options.timeout ?? defaultTimeout;
	const open = (): Promise<harness> => newHarness(newStore, options);

	describe(`${name}: golden compatibility with Tessera's POSIX driver`, () => {
		for (const size of sizes) {
			it(`log_${size}: one batch leaves exactly the files Go's POSIX driver left`, { timeout }, async () => {
				const fx = await loadLog(size);
				const h = await open();

				await appendEntries(h.store, singleBatchOptions(size), 0, size);

				await expectPublicFiles(h, fx, [0n, BigInt(size)], false);
				await expectGoState(h, fx);
			});
		}

		for (const size of sizes.filter((s) => s > 256)) {
			it(`log_${size}: batches of ${batchSize37} leave Go's files plus superseded partials, and GC leaves what POSIX's GC leaves`, {
				timeout,
			}, async () => {
				const fx = await loadLog(size);
				const h = await open();

				const driver = await appendEntries(h.store, goldenOptions(batchSize37, 5), 0, size);

				const ends = batchEndsOf(0, size, batchSize37);
				await expectPublicFiles(h, fx, ends, false);
				await expectGoState(h, fx);
				await collectGarbage(driver, size);
				await expectPublicFiles(h, fx, ends, true);
				await expectGoTreeState(h, fx);
			});
		}

		for (const size of sizes) {
			const splits = restartPoints.filter((p) => p < size);
			if (splits.length === 0) {
				continue;
			}
			it(`log_${size}: a driver restarted at ${splits.join(", ")} resumes its own state and converges on Go's files`, {
				timeout,
			}, async () => {
				const fx = await loadLog(size);
				const h = await open();
				const ends = [0, ...splits, size];

				let driver: ObjectStoreDriver | undefined;
				for (let s = 1; s < ends.length; s++) {
					const from = ends[s - 1] ?? 0;
					const to = ends[s] ?? 0;
					driver = await appendEntries(await h.reopen(), singleBatchOptions(to - from), from, to);
				}

				const bigEnds = ends.map(BigInt);
				await expectPublicFiles(h, fx, bigEnds, false);
				await expectGoState(h, fx);
				if (driver !== undefined) {
					await collectGarbage(driver, size);
				}
				await expectPublicFiles(h, fx, bigEnds, true);
				await expectGoTreeState(h, fx);
			});
		}

		for (const [from, to] of crossings.filter(([a, b]) => sizes.includes(a) && sizes.includes(b))) {
			it(`log_${from} + entries [${from}, ${to}) == log_${to}: resumes the files and state Go's POSIX driver wrote`, {
				timeout,
			}, async () => {
				const fromFx = await loadLog(from);
				const toFx = await loadLog(to);
				const h = await open();

				// Lay the Go log out in the store exactly as it sits on disk, private state included.
				for (const [path, raw] of [...publicFiles(fromFx), ...stateFiles(fromFx)]) {
					await h.store.put(path, raw);
				}
				const driver = await appendEntries(h.store, singleBatchOptions(to - from), from, to);

				const ends = [BigInt(from), BigInt(to)];
				await expectPublicFiles(h, toFx, ends, false);
				await expectGoState(h, toFx);
				await collectGarbage(driver, to);
				await expectPublicFiles(h, toFx, ends, true);
				await expectGoTreeState(h, toFx);
			});
		}
	});
}

/** harness is one case's view of the backend under test. */
interface harness {
	/** store is the store newStore returned, with every write recorded. Cases write through it. */
	readonly store: ObjectStore;
	/** reopen returns a fresh, recorded handle onto the same data, from options.reopen. */
	reopen(): Promise<ObjectStore>;
	/** get reads a key straight from the backend. */
	get(key: string): Promise<Uint8Array | undefined>;
	/** heldKeys returns, in ascending order, every key the backend holds; `also` names keys worth probing. */
	heldKeys(also: Iterable<string>): Promise<string[]>;
}

async function newHarness<S extends ObjectStore>(
	newStore: () => S | Promise<S>,
	options: GoldenCompatibilityOptions<S>,
): Promise<harness> {
	const raw = await newStore();
	const recorder = new KeyRecorder();
	const { listKeys, reopen } = options;
	return {
		store: recorder.wrap(raw),
		reopen: async () => recorder.wrap(reopen === undefined ? raw : await reopen(raw)),
		get: (key) => raw.get(key),
		heldKeys: async (also) =>
			listKeys === undefined ? recorder.heldKeys(raw, also) : [...(await listKeys(raw))].sort(),
	};
}

/**
 * expectPublicFiles asserts that the backend's public keys are exactly those the POSIX driver
 * holds after growing a log through batchEnds to the fixture's size (before or after GC), and
 * that every one of them holds Go's bytes.
 */
async function expectPublicFiles(
	h: harness,
	fx: LogFixture,
	batchEnds: readonly bigint[],
	afterGC: boolean,
): Promise<void> {
	const final = publicFiles(fx);
	const want = expectedPublicKeys(fx, batchEnds, afterGC);
	const held = (await h.heldKeys(want)).filter((k) => !k.startsWith(stateDir));
	expect(held, `public keys of log_${fx.size}${afterGC ? " after GC" : ""}`).toEqual(want);
	for (const key of want) {
		expectBytes(await h.get(key), final.get(key) ?? supersededPartial(key, final), key);
	}
}

/** expectGoState asserts that the backend's .state/ keys are exactly Go's, with Go's bytes. */
async function expectGoState(h: harness, fx: LogFixture): Promise<void> {
	const want = stateFiles(fx);
	const held = (await h.heldKeys(want.keys())).filter((k) => k.startsWith(stateDir));
	expect(held, `.state/ keys of log_${fx.size}`).toEqual([...want.keys()].sort());
	for (const [key, raw] of want) {
		expectBytes(await h.get(key), raw, key);
	}
}

/** expectGoTreeState asserts that `.state/treeState` holds the bytes Go wrote for the fixture's tree. */
async function expectGoTreeState(h: harness, fx: LogFixture): Promise<void> {
	expectBytes(await h.get(treeStatePath), stateFile(fx, treeStatePath), treeStatePath);
}

/** expectBytes asserts that got is want, naming the first differing byte when it is not. */
function expectBytes(got: Uint8Array | undefined, want: Uint8Array, key: string): void {
	expect(got, `${key} is missing`).toBeDefined();
	if (got === undefined || bytesEqual(got, want)) {
		return;
	}
	let i = 0;
	while (i < got.length && i < want.length && got[i] === want[i]) {
		i++;
	}
	expect.fail(
		`${key} differs from Go's: ${got.length} bytes where Go has ${want.length}, first difference at byte ${i}`,
	);
}
