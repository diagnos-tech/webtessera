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
// Ported from tessera/README_test.go @ 4a6d9f9

// This file contains code snippets used in the README.md file at the root of
// this repository.
//
// Having this code here, in a test file, helps ensure that our examples and
// snippets actually work with the current state of webtessera.
//
// Port note: upstream keeps README.md in sync with this file by running mdcode by
// hand, and leaves a TODO to check it in presubmit; README_sync_test.ts is that
// check. The upstream regions (common_imports, construct_example, use_appender_example)
// are kept; the others document the IndexedDB and SQLite drivers and verification, which
// upstream's README covers in prose. The posix driver becomes the memory driver.
// See docs/decisions/0140-testonly-and-readme-test-on-the-memory-driver.md.
//
// biome-ignore-all assist/source/organizeImports: the #region markers delimit import groups that README.md embeds verbatim.

import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

// #region common_imports
import { newAppender, newAppendOptions, newEntry, newPublicationAwaiter } from "webtessera";

// Choose one!
import { newMemoryDriver } from "webtessera/storage/memory";
// import { newIndexedDBDriver } from "webtessera/storage/indexeddb";
// import { newSqliteDriver, fromSqliteSync } from "webtessera/storage/sqlite";
// #endregion

import { fetchCheckpoint, newHTTPFetcher, newProofBuilder } from "webtessera/client";
import { verifyInclusion } from "webtessera/merkle/proof";
import { DefaultHasher } from "webtessera/merkle/rfc6962";
import { generateKey, newSigner, newVerifier, type Signer } from "webtessera/note";
import { newIndexedDBDriver } from "webtessera/storage/indexeddb";
import { MemoryObjectStore } from "webtessera/storage/memory";
import { fromSqliteSync, newSqliteDriver } from "webtessera/storage/sqlite";

// fastOptions keeps the snippets' logs quick to publish under test; the README's
// snippets use the defaults.
function fastOptions(signer: Signer) {
	return newAppendOptions().withCheckpointSigner(signer).withBatching(256, 10).withCheckpointInterval(100);
}

async function constructStorage(): Promise<void> {
	// #region construct_example
	const driver = newMemoryDriver();
	const signer = createSigner();

	const { appender, shutdown, reader } = await newAppender(driver, newAppendOptions().withCheckpointSigner(signer));
	// #endregion

	expect(appender).toBeDefined();
	expect(reader).toBeDefined();
	await shutdown();
}

async function constructAndUseAppender(): Promise<void> {
	const data = new TextEncoder().encode("hello");

	const driver = newMemoryDriver();
	const signer = createSigner();
	const ac = new AbortController();

	// #region use_appender_example
	const { appender, shutdown, reader } = await newAppender(driver, newAppendOptions().withCheckpointSigner(signer));

	const index = await appender.add(newEntry(data))();
	// #endregion

	expect(index).toEqual({ index: 0n, isDup: false });
	expect(reader).toBeDefined();
	await shutdown();
	ac.abort();
}

async function awaitPublication(): Promise<void> {
	const data = new TextEncoder().encode("hello");
	const ac = new AbortController();
	const signal = ac.signal;
	const { appender, shutdown, reader } = await newAppender(newMemoryDriver(), fastOptions(createSigner()), signal);

	// #region await_publication_example
	// One awaiter per log, shared by every request: it polls the published checkpoint
	// only while somebody is waiting.
	const awaiter = newPublicationAwaiter((s) => reader.readCheckpoint(s), 100, signal);

	const [index, checkpoint] = await awaiter.await(appender.add(newEntry(data)));
	// #endregion

	expect(index.index).toBe(0n);
	expect(checkpoint).toBeDefined();
	await shutdown();
	ac.abort();
}

async function verifyEntry(): Promise<void> {
	const data = new TextEncoder().encode("hello");
	const { skey, vkey: verifierKey } = generateKey(undefined, "example.com/my-log");
	const ac = new AbortController();
	const store = new MemoryObjectStore();
	const { appender, shutdown, reader } = await newAppender(
		newMemoryDriver({ store }),
		fastOptions(newSigner(skey)),
		ac.signal,
	);
	const awaiter = newPublicationAwaiter((s) => reader.readCheckpoint(s), 50, ac.signal);
	const [index] = await awaiter.await(appender.add(newEntry(data)));

	// Serve the store over "HTTP": a tlog-tiles log is a static tree of files, and the
	// store's keys are exactly their paths.
	vi.stubGlobal("fetch", async (url: string) => {
		const body = await store.get(new URL(url).pathname.slice(1));
		return body === undefined ? new Response(null, { status: 404 }) : new Response(new Uint8Array(body));
	});

	// #region verify_example
	const verifier = newVerifier(verifierKey);
	const log = newHTTPFetcher(new URL("https://log.example.com/"));

	// Fetch the latest checkpoint and check the log's signature on it.
	const { checkpoint } = await fetchCheckpoint((s) => log.readCheckpoint(s), verifier, verifier.name());

	// Prove that the entry at `index` is committed to by that checkpoint.
	const proofs = await newProofBuilder(checkpoint.size, (l, i, p, s) => log.readTile(l, i, p, s));
	const proof = await proofs.inclusionProof(index.index);
	verifyInclusion(DefaultHasher, index.index, checkpoint.size, DefaultHasher.hashLeaf(data), proof, checkpoint.hash);
	// #endregion

	await shutdown();
	ac.abort();
}

async function useIndexedDB(): Promise<void> {
	const signer = createSigner();
	const ac = new AbortController();
	const signal = ac.signal;

	// #region indexeddb_example
	// The log survives reloads, and several tabs may share it: Web Locks serialise
	// their writes.
	const driver = await newIndexedDBDriver({ name: "my-log" }, signal);
	const { appender, shutdown } = await newAppender(driver, newAppendOptions().withCheckpointSigner(signer), signal);
	// #endregion

	expect((await appender.add(newEntry(new Uint8Array([1])))()).index).toBe(0n);
	await shutdown();
	ac.abort();
}

async function useSqlite(): Promise<void> {
	const signer = createSigner();
	const ac = new AbortController();
	const signal = ac.signal;
	const dir = mkdtempSync(`${tmpdir()}/webtessera-readme-`);
	const file = `${dir}/log.db`;

	// #region sqlite_example
	// node:sqlite here; any other engine only changes this line (see the table below).
	const database = fromSqliteSync(new DatabaseSync(file));
	const driver = await newSqliteDriver({ database }, signal);
	const { appender, shutdown } = await newAppender(driver, newAppendOptions().withCheckpointSigner(signer), signal);
	// #endregion

	try {
		expect((await appender.add(newEntry(new Uint8Array([1])))()).index).toBe(0n);
		await shutdown();
	} finally {
		ac.abort();
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("README", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("TestConstructStorage", async () => {
		await constructStorage();
	});

	it("TestConstructAndUseAppender", async () => {
		await constructAndUseAppender();
	});

	it("awaits publication", async () => {
		await awaitPublication();
	});

	it("verifies an entry over HTTP", async () => {
		await verifyEntry();
	});

	it("keeps a log in IndexedDB", async () => {
		await useIndexedDB();
	});

	it("keeps a log in SQLite", async () => {
		await useSqlite();
	});
});

function createSigner(): Signer {
	// #region create_signer_example
	// Generate the key pair once. Keep skey secret; publish vkey so that clients can
	// verify the log's checkpoints.
	const { skey, vkey } = generateKey(undefined, "example.com/my-log");
	const signer = newSigner(skey);
	// #endregion
	expect(newVerifier(vkey).name()).toBe(signer.name());
	return signer;
}
