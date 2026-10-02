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
// Ported from tessera/fsck/fsck_test.go @ 4a6d9f9
//
// Port note: upstream's own fsck_test.go has exactly one test, TestTrimFullToPartial,
// covering only resourceCheckWorker -- Fsck.Check/New have no direct Go unit test
// anywhere upstream (the real end-to-end coverage lives in storage/{posix,gcp,aws}'s own
// *_test.go files and integration/fault/posix/fault_test.go, none of which are in this
// port's scope). Given Check is this package's central, donation-defining behaviour ("our
// port can audit a whole log and catch corruption" -- see the mission brief), two
// additional fixture-backed cases are added below, following the same pattern those
// upstream driver tests use (`fsck.New(vk.Name(), vk, lr, defaultMerkleLeafHasher,
// fsck.Opts{N: ...})` against a real log), reusing the same `client_log` fixture
// client_test.ts already established (docs/decisions/0065-client-log-fixture-reads-static-testdata.md).

import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { CheckpointPath, entriesPath, tilePath } from "../api/layout/index.ts";
import { concatBytes, toUTF8 } from "../internal/gostd/bytes.ts";
import { ErrNotExist } from "../internal/gostd/errors.ts";
import { defaultMerkleLeafHasher } from "../lifecycle.ts";
import { hexToBytes, loadFixture } from "../testonly/fixtures.ts";
import { newVerifier } from "../vendor/note/note.ts";
import {
	type Fetcher,
	fsckTree,
	newCountingFetcher,
	newFsck,
	ResourceQueue,
	type resource,
	resourceBackpressureThreshold,
} from "./fsck.ts";
import { newRangeTracker, OK } from "./status.ts";

describe("TestTrimFullToPartial", () => {
	const tests: { name: string; r: resource; storedTile: Uint8Array; wantErr: boolean }[] = [
		{
			name: "partial request, partial exists",
			r: { level: 0n, index: 0n, partial: 10, content: makeTile(10) },
			storedTile: makeTile(10),
			wantErr: false,
		},
		{
			name: "partial request, full exists",
			r: { level: 0n, index: 0n, partial: 10, content: makeTile(10) },
			storedTile: makeTile(256),
			wantErr: false,
		},
		{
			name: "invalid stored data",
			r: { level: 0n, index: 0n, partial: 0, content: makeTile(256) },
			storedTile: makeTile(2),
			wantErr: true,
		},
		{
			name: "full request, full exists",
			r: { level: 0n, index: 0n, partial: 0, content: makeTile(256) },
			storedTile: makeTile(256),
			wantErr: false,
		},
	];

	for (const test of tests) {
		it(test.name, async () => {
			const f = new fsckTree({
				expectedResources: new ResourceQueue(),
				fetcher: newCountingFetcher(new fakeFetcher(test.storedTile)),
				rangeTracker: newRangeTracker(1n),
			});

			f.expectedResources.push(test.r);
			f.expectedResources.close();

			let gotErr: unknown;
			try {
				await f.resourceCheckWorker()();
			} catch (err) {
				gotErr = err;
			}
			expect(gotErr !== undefined, `resourceCheckWorker: ${String(gotErr)} want err ${test.wantErr}`).toBe(
				test.wantErr,
			);
		});
	}
});

class fakeFetcher implements Fetcher {
	readonly #tile: Uint8Array;

	constructor(tile: Uint8Array) {
		this.#tile = tile;
	}

	readCheckpoint(): Promise<Uint8Array> {
		return Promise.reject(new Error("not implemented"));
	}

	readTile(): Promise<Uint8Array> {
		return Promise.resolve(this.#tile);
	}

	readEntryBundle(): Promise<Uint8Array> {
		return Promise.reject(new Error("not implemented"));
	}
}

/** makeTile mirrors Go's makeTile: n leaf hashes of `fmt.Appendf(nil, "%50d", i)`, concatenated. */
function makeTile(n: number): Uint8Array {
	const parts: Uint8Array[] = [];
	for (let i = 0; i < n; i++) {
		parts.push(sha256(toUTF8(fmt50d(i))));
	}
	return concatBytes(...parts);
}

/** fmt50d renders i the way Go's `fmt.Sprintf("%50d", i)` does: right-justified, space-padded to width 50. */
function fmt50d(i: number): string {
	return i.toString().padStart(50, " ");
}

// Not part of upstream fsck_test.go -- see the file header.

interface FixtureResourceFile {
	readonly path: string;
	readonly raw: string;
}
interface ClientLogFixture {
	readonly origin: string;
	readonly logVkey: string;
	readonly latest: string;
	readonly tiles: readonly FixtureResourceFile[];
	readonly entryBundles: readonly FixtureResourceFile[];
}

/** fixtureFetcher is a fsck.Fetcher backed by a static map of path -> raw bytes. */
class fixtureFetcher implements Fetcher {
	readonly #resources: Map<string, Uint8Array>;

	constructor(resources: Map<string, Uint8Array>) {
		this.#resources = resources;
	}

	async readCheckpoint(): Promise<Uint8Array> {
		const raw = this.#resources.get(CheckpointPath);
		if (raw === undefined) {
			throw ErrNotExist;
		}
		return raw;
	}

	async readTile(l: bigint, i: bigint, p: number): Promise<Uint8Array> {
		const raw = this.#resources.get(tilePath(l, i, p));
		if (raw === undefined) {
			throw ErrNotExist;
		}
		return raw;
	}

	async readEntryBundle(i: bigint, p: number): Promise<Uint8Array> {
		const raw = this.#resources.get(entriesPath(i, p));
		if (raw === undefined) {
			throw ErrNotExist;
		}
		return raw;
	}
}

async function loadClientLogResources(): Promise<{ fixture: ClientLogFixture; resources: Map<string, Uint8Array> }> {
	const fixture = await loadFixture<ClientLogFixture>("client_log");
	const resources = new Map<string, Uint8Array>();
	resources.set(CheckpointPath, hexToBytes(fixture.latest));
	for (const t of fixture.tiles) {
		resources.set(t.path, hexToBytes(t.raw));
	}
	for (const b of fixture.entryBundles) {
		resources.set(b.path, hexToBytes(b.raw));
	}
	return { fixture, resources };
}

it("check() verifies a real log end to end (not part of upstream fsck_test.go)", async () => {
	const { fixture, resources } = await loadClientLogResources();
	const verifier = newVerifier(fixture.logVkey);

	const f = newFsck(fixture.origin, verifier, new fixtureFetcher(resources), defaultMerkleLeafHasher, { n: 2 });
	await f.check();

	const status = f.status();
	for (const r of status.entryRanges) {
		expect(r.state, r.toString()).toBe(OK);
	}
	for (const level of status.tileRanges) {
		for (const r of level) {
			expect(r.state, r.toString()).toBe(OK);
		}
	}
});

it("check() rejects a log with a corrupted tile (not part of upstream fsck_test.go)", async () => {
	const { fixture, resources } = await loadClientLogResources();
	const verifier = newVerifier(fixture.logVkey);

	// Corrupt the level-0 tile that backs the log's latest (size-15) checkpoint --
	// fsck re-derives its expected content from the (untouched) entry bundle, so the
	// comparison against this flipped byte must fail.
	const corruptPath = tilePath(0n, 0n, 15);
	const original = resources.get(corruptPath);
	if (original === undefined) {
		throw new Error(`test fixture is missing expected resource ${corruptPath}`);
	}
	const corrupted = original.slice();
	corrupted[0] = (corrupted[0] as number) ^ 0xff;
	resources.set(corruptPath, corrupted);

	const f = newFsck(fixture.origin, verifier, new fixtureFetcher(resources), defaultMerkleLeafHasher, { n: 2 });
	await expect(f.check()).rejects.toThrow(/log has:/);
});

// Not part of upstream fsck_test.go. The `client_log` fixture is only size 15, so no tile
// in it ever fills to 256 nodes -- meaning nothing in the suite above exercises visit's
// full-tile branch, where `partial: t.nodes.length % 256` must wrap 256 -> 0 (Go's
// `uint8(256)`). A naive `partial: t.nodes.length` would emit 256 here, resolving to a
// non-existent `tile/0/000.p/256` path instead of the full-tile `tile/0/000`. This drives
// exactly one full level-0 tile and pins that wrap. See ADR-0091 §4.
it("visit enqueues a full 256-node tile with partial 0, not 256 (uint8(256) wrap)", async () => {
	const hashes: Uint8Array[] = [];
	for (let i = 0; i < 256; i++) {
		hashes.push(sha256(toUTF8(fmt50d(i))));
	}
	const q = new ResourceQueue();
	const tree = new fsckTree({
		expectedResources: q,
		fetcher: newCountingFetcher(new fakeFetcher(new Uint8Array())),
		rangeTracker: newRangeTracker(256n),
		bundleHasher: () => hashes,
	});

	tree.appendBundle({ index: 0n, partial: 0, first: 0, n: 256 }, new Uint8Array());
	q.close();

	const drained: resource[] = [];
	for (let r = await q.pull(); r !== null; r = await q.pull()) {
		drained.push(r);
	}
	const level0 = drained.filter((r) => r.level === 0n);
	expect(level0.length, "one full level-0 tile enqueued").toBe(1);
	expect((level0[0] as resource).partial, "full tile partial wraps to 0").toBe(0);
});

// Not part of upstream fsck_test.go. ResourceQueue.waitUntilBelow is this port's
// substitute for the back-pressure a bounded Go channel gives check() for free (see
// ADR-0091 §1 and the docstring on waitUntilBelow) -- unlike `push`, which is called
// from the synchronous VisitFn and can never block, `waitUntilBelow` is awaited from
// check()'s own bundle loop, the one place in the pipeline that can. These three cases
// prove, directly against the primitive rather than through the full Fsck.check()
// plumbing, that it: (a) doesn't block when there's already room, (b) genuinely blocks
// and later unblocks once a consumer pulls, and (c) -- the deadlock hazard the reviewer
// flagged -- unblocks via signal abort even when nothing ever pulls, so a producer
// waiting here can never hang forever against a fully-dead consumer pool.
describe("ResourceQueue.waitUntilBelow", () => {
	it("resolves immediately when already below the threshold", async () => {
		const q = new ResourceQueue();
		q.push({ level: 0n, index: 0n, partial: 1, content: new Uint8Array() });
		await expect(q.waitUntilBelow(2)).resolves.toBeUndefined();
	});

	it("blocks while at/above the threshold, and unblocks once a pull drops it below", async () => {
		const q = new ResourceQueue();
		q.push({ level: 0n, index: 0n, partial: 1, content: new Uint8Array() });
		q.push({ level: 0n, index: 1n, partial: 1, content: new Uint8Array() });

		let resolved = false;
		const waiting = q.waitUntilBelow(2).then(() => {
			resolved = true;
		});

		// Give the (deliberately unresolved) promise a couple of microtask turns to
		// prove it does NOT resolve on its own while size stays at the threshold.
		await Promise.resolve();
		await Promise.resolve();
		expect(resolved, "must not resolve while size is still at the threshold").toBe(false);

		await q.pull(); // size: 2 -> 1, now below the threshold of 2.
		await waiting;
		expect(resolved).toBe(true);
	});

	it("unblocks via signal abort even though nothing ever pulls (the deadlock-avoidance path)", async () => {
		const q = new ResourceQueue();
		q.push({ level: 0n, index: 0n, partial: 1, content: new Uint8Array() });
		q.push({ level: 0n, index: 1n, partial: 1, content: new Uint8Array() });

		const ctrl = new AbortController();
		const waiting = q.waitUntilBelow(2, ctrl.signal);

		let settled = false;
		void waiting
			.catch(() => {})
			.finally(() => {
				settled = true;
			});
		await Promise.resolve();
		expect(settled, "must still be pending -- nothing has pulled or aborted yet").toBe(false);

		// Simulates every resourceCheckWorker having already errored out (eg.signal
		// aborts on first worker error) while the producer is parked here: without this
		// path, the producer -- and so check() -- would hang forever even though
		// eg.wait() is ready to surface the real error.
		ctrl.abort(new Error("all workers died"));
		await expect(waiting).rejects.toThrow("all workers died");
	});

	it("rejects immediately if the signal is already aborted", async () => {
		const q = new ResourceQueue();
		q.push({ level: 0n, index: 0n, partial: 1, content: new Uint8Array() });
		const ctrl = new AbortController();
		ctrl.abort(new Error("gone"));
		await expect(q.waitUntilBelow(1, ctrl.signal)).rejects.toThrow("gone");
	});
});

// Not part of upstream fsck_test.go. Proves the OOM hazard a reviewer identified in
// ADR-0091 §1 is actually closed: drives fsckTree.appendBundle/visit -- the same
// producer check() drives -- through far more full tiles than the backpressure
// threshold, awaiting ResourceQueue.waitUntilBelow between pushes exactly as check()'s
// bundle loop now does, against a consumer that is deliberately much slower than the
// producer. If waitUntilBelow were a no-op (the pre-fix behaviour), the queue would grow
// to roughly the full tile count; with it, size is capped at the threshold throughout.
it("check()'s backpressure caps buffered resources regardless of log size (ADR-0091 §1)", async () => {
	const n = 2;
	const threshold = resourceBackpressureThreshold(n);
	const fullTileCount = threshold * 3; // far more resources than the queue may ever hold at once.

	const hashes: Uint8Array[] = [];
	for (let i = 0; i < fullTileCount * 256; i++) {
		hashes.push(sha256(toUTF8(fmt50d(i))));
	}

	const q = new ResourceQueue();
	const tree = new fsckTree({
		expectedResources: q,
		fetcher: newCountingFetcher(new fakeFetcher(new Uint8Array())),
		rangeTracker: newRangeTracker(BigInt(fullTileCount * 256)),
		bundleHasher: () => hashes,
	});

	let peakSize = 0;
	let pulled = 0;
	// A deliberately slow consumer: one pull every macrotask tick, far slower than the
	// producer below (which never awaits a timer), so the queue is guaranteed to press
	// against the threshold if nothing bounds it.
	const drainer = (async () => {
		for (;;) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			const r = await q.pull();
			if (r === null) {
				return;
			}
			pulled++;
		}
	})();

	for (let i = 0; i < fullTileCount; i++) {
		tree.appendBundle({ index: BigInt(i), partial: 0, first: 0, n: 256 }, new Uint8Array());
		peakSize = Math.max(peakSize, q.size);
		// The call under test: this is exactly what check() now does between bundles.
		await q.waitUntilBelow(threshold);
	}
	q.close();
	await drainer;

	expect(pulled, "every pushed resource was eventually drained").toBe(fullTileCount);
	expect(peakSize, "queue size never exceeded the backpressure threshold").toBeLessThanOrEqual(threshold + 1);
});
