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
// Ported from tessera/client/client_test.go @ 4a6d9f9
//
// Port note: upstream reads its test log from the static, checked-in
// "../testdata/log" directory (built once by testdata/build_log.sh; a real 15-entry
// tlog-tiles log, not synthesised). That directory has no counterpart in this repo, so
// the fixture generator reads it back directly and packages it as fixtures/data/
// client_log.json -- see fixtures/gen/client.go and
// docs/decisions/0065-client-log-fixture-reads-static-testdata.md. testOrigin and
// testLogVerifier come from that fixture rather than being retyped by hand, so the key
// material can never drift from what the generator actually read off disk.

import { sha256 } from "@noble/hashes/sha2.js";
import { beforeAll, describe, expect, it } from "vitest";
import { CheckpointPath, partialTileSize, TileHeight, TileWidth, tilePath } from "../api/layout/index.ts";
import { HashTile } from "../api/state.ts";
import { fromUTF8, toUTF8 } from "../internal/gostd/bytes.ts";
import { ErrNotExist } from "../internal/gostd/errors.ts";
import { type Fixture, hexToBytes, loadFixture } from "../testonly/fixtures.ts";
import { Checkpoint, parseCheckpoint } from "../vendor/formats/log/index.ts";
import { newNodeID } from "../vendor/merkle/compact/index.ts";
import { Nodes } from "../vendor/merkle/proof/proof.ts";
import { newSigner, newVerifier, sign, type Verifier } from "../vendor/note/note.ts";
import {
	type CheckpointFetcherFunc,
	ErrInconsistency,
	getEntryBundle,
	newLogStateTracker,
	newNodeCache,
	newProofBuilder,
	type TileFetcherFunc,
	unilateralConsensus,
} from "./client.ts";

interface CheckpointSnapshot {
	readonly n: string;
	readonly raw: string;
}
interface ResourceFile {
	readonly path: string;
	readonly raw: string;
}
interface ClientLogFixture {
	readonly origin: string;
	readonly logVkey: string;
	readonly logSkey: string;
	readonly latest: string;
	readonly checkpoints: readonly CheckpointSnapshot[];
	readonly tiles: readonly ResourceFile[];
	readonly entryBundles: readonly ResourceFile[];
}

let testOrigin: string;
let testLogVerifier: Verifier;
// testLogSigner is not part of upstream client_test.go -- Go's own version of this test
// only ever has the log's public verifier key available. It is used solely by the
// "rejects an inconsistent checkpoint" case below, which forges a checkpoint to exercise
// LogStateTracker's rejection path; see that test's comment and
// docs/decisions/0065-client-log-fixture-reads-static-testdata.md.
let testLogSigner: ReturnType<typeof newSigner>;
// Built using fixtures/gen/client.go, which reads back testdata/build_log.sh's output.
let testRawCheckpoints: Uint8Array[];
let testCheckpoints: Checkpoint[];
let resources: Map<string, Uint8Array>;

beforeAll(async () => {
	const fixture: Fixture<ClientLogFixture> = await loadFixture<ClientLogFixture>("client_log");

	testOrigin = fixture.origin;
	testLogVerifier = newVerifier(fixture.logVkey);
	testLogSigner = newSigner(fixture.logSkey);

	resources = new Map<string, Uint8Array>();
	resources.set(CheckpointPath, hexToBytes(fixture.latest));
	for (const cp of fixture.checkpoints) {
		resources.set(`${CheckpointPath}.${cp.n}`, hexToBytes(cp.raw));
	}
	for (const t of fixture.tiles) {
		resources.set(t.path, hexToBytes(t.raw));
	}
	for (const b of fixture.entryBundles) {
		resources.set(b.path, hexToBytes(b.raw));
	}

	testRawCheckpoints = fixture.checkpoints.map((cp) => hexToBytes(cp.raw));
	testCheckpoints = testRawCheckpoints.map((raw) => parseCheckpoint(raw, testOrigin, testLogVerifier).checkpoint);
});

// testLogFetcher is a fetcher which reads from the checked-in golden test log
// data stored in fixtures/data/client_log.json (mirroring ../testdata/log upstream).
async function testLogFetcher(p: string): Promise<Uint8Array> {
	const raw = resources.get(p);
	if (raw === undefined) {
		throw ErrNotExist;
	}
	return raw;
}

const testLogTileFetcher: TileFetcherFunc = async (l: bigint, i: bigint, p: number): Promise<Uint8Array> =>
	testLogFetcher(tilePath(l, i, p));

/** fetchCheckpointShim allows fetcher requests for checkpoints to be intercepted. */
class FetchCheckpointShim {
	/**
	 * checkpoints holds raw checkpoints to be returned when the fetcher is asked to
	 * retrieve a checkpoint path. The zero-th entry will be returned until advance is
	 * called.
	 */
	checkpoints: Uint8Array[];

	constructor(checkpoints: Uint8Array[]) {
		this.checkpoints = checkpoints;
	}

	/**
	 * fetchCheckpoint intercepts requests for the checkpoint file, returning the
	 * zero-th entry in the checkpoints field.
	 */
	fetchCheckpoint: CheckpointFetcherFunc = async (): Promise<Uint8Array> => {
		if (this.checkpoints.length === 0) {
			throw ErrNotExist;
		}
		return this.checkpoints[0] as Uint8Array;
	};

	/** advance causes subsequent intercepted checkpoint requests to return the next entry in the checkpoints slice. */
	advance(): void {
		this.checkpoints = this.checkpoints.slice(1);
	}
}

describe("TestCheckLogStateTracker", () => {
	const tests: { desc: string; cpIdx: number[]; wantCpIdx: number[] }[] = [
		{
			desc: "Consistent",
			cpIdx: [0, 2, 3, 5, 6, 10],
			wantCpIdx: [0, 2, 3, 5, 6, 10],
		},
		{
			desc: "Identical CP",
			cpIdx: [0, 0, 0, 0],
			wantCpIdx: [0, 0, 0, 0],
		},
		{
			desc: "Identical CP pairs",
			cpIdx: [0, 0, 5, 5],
			wantCpIdx: [0, 0, 5, 5],
		},
		{
			desc: "Out of order",
			cpIdx: [5, 2, 0, 3],
			wantCpIdx: [5, 5, 5, 5],
		},
	];

	for (const test of tests) {
		it(test.desc, async () => {
			const shim = new FetchCheckpointShim(test.cpIdx.map((i) => testRawCheckpoints[i] as Uint8Array));
			const lst = await newLogStateTracker(
				testLogTileFetcher,
				testRawCheckpoints[0] as Uint8Array,
				testLogVerifier,
				testOrigin,
				unilateralConsensus(shim.fetchCheckpoint),
			);

			for (let i = 0; i < test.cpIdx.length; i++) {
				const { newer } = await lst.update();
				expect(newer, `Update ${i}`).toEqual(testRawCheckpoints[test.wantCpIdx[i] as number]);
				shim.advance();
			}
		});
	}
});

it("TestCheckLogStateTracker rejects a checkpoint whose hash is inconsistent with the tracked state", async () => {
	// Not part of upstream client_test.go: every case in TestCheckLogStateTracker feeds
	// LogStateTracker checkpoints taken from the real, honestly-grown log, so none of
	// them exercises the rejection path -- ErrInconsistency is thrown only by
	// proof.VerifyConsistency, and forging a validly-signed-but-wrong checkpoint is the
	// only way to make that fail without an actually compromised or buggy server. This
	// is exactly the mechanism ErrInconsistency exists to catch (client/client.go's own
	// doc comment: "evidence of inconsistent log updates").

	// Start the tracker from a real, non-zero checkpoint (size 5) -- update() skips the
	// consistency check entirely whenever the tracked size is 0, so a zero-sized start
	// would never reach the code path this test targets.
	const initial = testRawCheckpoints[5] as Uint8Array;

	// Forge a checkpoint claiming a larger size (10) than the tracked one, with a hash
	// that does not match the real tree's root at that size, but which is otherwise
	// validly signed by the log's own key.
	const forged = new Checkpoint({ origin: testOrigin, size: 10n, hash: new Uint8Array(32).fill(0x42) });
	expect(forged.hash).not.toEqual((testCheckpoints[10] as Checkpoint).hash);
	const forgedRaw = sign({ text: fromUTF8(forged.marshal()) }, testLogSigner);

	const shim = new FetchCheckpointShim([forgedRaw]);
	const lst = await newLogStateTracker(
		testLogTileFetcher,
		initial,
		testLogVerifier,
		testOrigin,
		unilateralConsensus(shim.fetchCheckpoint),
	);

	let caught: unknown;
	try {
		await lst.update();
	} catch (err) {
		caught = err;
	}

	expect(caught).toBeInstanceOf(ErrInconsistency);
	const ei = caught as ErrInconsistency;
	expect(ei.smallerRaw).toEqual(initial);
	expect(ei.largerRaw).toEqual(forgedRaw);
	expect(ei.proof.length).toBeGreaterThan(0);

	// The tracker must not have advanced past the last genuinely accepted checkpoint.
	expect(lst.latest().size).toBe(5n);
});

it("TestNodeCacheHandlesInvalidRequest", async () => {
	const wantBytes = toUTF8("0123456789ABCDEF0123456789ABCDEF");
	const f: TileFetcherFunc = async (): Promise<Uint8Array> => {
		const h = new HashTile([wantBytes]);
		return h.marshalText();
	};

	// Large tree, but we're emulating skew since f, above, will return a tile which only knows about 1
	// leaf.
	const nc = newNodeCache(f, 10n);

	const got = await nc.getNode(newNodeID(0, 0n));
	expect(got).toEqual(wantBytes);

	await expect(nc.getNode(newNodeID(0, 1n))).rejects.toThrow();
});

it("TestHandleZeroRoot", async () => {
	const zeroCP = testCheckpoints[0] as Checkpoint;
	expect(zeroCP.size, "BadData: checkpoint has non-zero size").toBe(0n);
	expect(zeroCP.hash.length, "BadTestData: checkpoint.0 has empty root hash").toBeGreaterThan(0);

	await expect(newProofBuilder(zeroCP.size, testLogTileFetcher)).resolves.toBeDefined();
});

describe("TestGetEntryBundleAddressing", () => {
	const tests: {
		name: string;
		idx: bigint;
		clientLogSize: bigint;
		actualLogSize: bigint;
		wantPartialTileSize: number;
	}[] = [
		{
			name: "works - partial tile",
			idx: 0n,
			clientLogSize: 34n,
			actualLogSize: 34n,
			wantPartialTileSize: 34,
		},
		{
			name: "works - full tile",
			idx: 1n,
			clientLogSize: BigInt(TileWidth) * 2n + 45n,
			actualLogSize: BigInt(TileWidth) * 2n + 45n,
			wantPartialTileSize: 0,
		},
	];

	for (const test of tests) {
		it(test.name, async () => {
			let gotIdx = 0n;
			let gotTileSize = 0;
			const f = async (i: bigint, sz: number): Promise<Uint8Array> => {
				gotIdx = i;
				gotTileSize = sz;
				const p = partialTileSize(0n, i, test.actualLogSize);
				if (p !== sz) {
					throw ErrNotExist;
				}
				return new Uint8Array(0);
			};

			await expect(getEntryBundle(f, test.idx, test.clientLogSize)).resolves.toBeDefined();
			expect(gotIdx, "idx").toBe(test.idx);
			expect(gotTileSize, "tileSize").toBe(test.wantPartialTileSize);
		});
	}
});

describe("TestNodeFetcherAddressing", () => {
	const tests: {
		name: string;
		nodeLevel: number;
		nodeIdx: bigint;
		clientLogSize: bigint;
		actualLogSize: bigint;
		wantPartialTileSize: number;
	}[] = [
		{
			name: "works - partial tile",
			nodeLevel: 0,
			nodeIdx: 0n,
			clientLogSize: 34n,
			actualLogSize: 34n,
			wantPartialTileSize: 34,
		},
		{
			name: "works - full tile",
			nodeLevel: 0,
			nodeIdx: 56n,
			clientLogSize: BigInt(TileWidth) * 2n + 45n,
			actualLogSize: BigInt(TileWidth) * 2n + 45n,
			wantPartialTileSize: 0,
		},
	];

	for (const test of tests) {
		it(test.name, async () => {
			let gotLevel = 0n;
			let gotIdx = 0n;
			let gotTileSize = 0;
			const f: TileFetcherFunc = async (l: bigint, i: bigint, sz: number): Promise<Uint8Array> => {
				gotLevel = l;
				gotIdx = i;
				gotTileSize = sz;
				const p = partialTileSize(l, i, test.actualLogSize);
				if (p !== sz) {
					throw ErrNotExist;
				}
				const r = new HashTile();
				const s = sz === 0 ? TileWidth : sz;
				const nodes: Uint8Array[] = [];
				for (let x = 0; x < s; x++) {
					nodes.push(sha256(toUTF8(`node at ${l}/${i + BigInt(x)}`)));
				}
				r.nodes = nodes;
				return r.marshalText();
			};
			const pb = await newProofBuilder(test.clientLogSize, f);
			await expect(
				pb.fetchNodes(new Nodes([newNodeID(test.nodeLevel, test.nodeIdx)], 0, 0, newNodeID(0, 0n))),
			).resolves.toBeDefined();

			const wantLevel = BigInt(test.nodeLevel >> TileHeight);
			expect(gotLevel, "level").toBe(wantLevel);
			const wantIdx = test.nodeIdx >> BigInt(TileHeight);
			expect(gotIdx, "idx").toBe(wantIdx);
			expect(gotTileSize, "tileSize").toBe(test.wantPartialTileSize);
		});
	}
});
