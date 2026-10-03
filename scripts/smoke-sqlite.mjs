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

// End-to-end smoke test of the built package's SQLite backend (dist/) on whichever
// JavaScript runtime executes this file, with the SQLite that runtime ships: node:sqlite
// under Node.js and Deno, bun:sqlite under Bun.
//
// Usage, after `bun run build`:
//
//     node scripts/smoke-sqlite.mjs
//     bun scripts/smoke-sqlite.mjs
//     deno run --allow-read scripts/smoke-sqlite.mjs
//
// It appends a few hundred entries to a log kept in an in-memory SQLite database, waits
// for a checkpoint that commits to the last one, and verifies the checkpoint's signature
// and the entry's inclusion proof against it. It then restarts the log on the same
// database with lease locking, appends again, and checks that the log resumed where it
// stopped. Zero dependencies.

import { fetchCheckpoint, newProofBuilder } from "../dist/client/index.js";
import { newAppender, newAppendOptions, newEntry, newPublicationAwaiter } from "../dist/index.js";
import { fromSqliteSync, newSqliteDriver } from "../dist/storage/sqlite/index.js";
import { verifyInclusion } from "../dist/vendor/merkle/proof/index.js";
import { DefaultHasher } from "../dist/vendor/merkle/rfc6962/rfc6962.js";
import { generateKey, newSigner, newVerifier } from "../dist/vendor/note/note.js";

/** openMemoryDatabase opens an in-memory database with the runtime's own SQLite binding. */
async function openMemoryDatabase() {
	if (typeof globalThis.Bun !== "undefined") {
		const { Database } = await import("bun:sqlite");
		return { engine: "bun:sqlite", db: new Database(":memory:") };
	}
	const { DatabaseSync } = await import("node:sqlite");
	const engine = typeof globalThis.Deno !== "undefined" ? "node:sqlite (Deno)" : "node:sqlite (Node.js)";
	return { engine, db: new DatabaseSync(":memory:") };
}

const enc = new TextEncoder();
const { engine, db } = await openMemoryDatabase();
const database = fromSqliteSync(db);
const { skey, vkey } = generateKey(undefined, "example.com/smoke-sqlite");
const verifier = newVerifier(vkey);
const opts = newAppendOptions().withCheckpointSigner(newSigner(skey)).withBatching(256, 10).withCheckpointInterval(100);

/** appendAndProve appends count entries and then data, and proves data's inclusion in a published checkpoint. */
async function appendAndProve(driverOptions, count, label) {
	const ac = new AbortController();
	const driver = await newSqliteDriver({ database, ...driverOptions });
	const { appender, shutdown, reader } = await newAppender(driver, opts, ac.signal);
	const awaiter = newPublicationAwaiter((s) => reader.readCheckpoint(s), 20, ac.signal);
	for (let i = 0; i < count; i++) {
		appender.add(newEntry(enc.encode(`${label} ${i}`)));
	}
	const data = enc.encode(`${label}: the last entry`);
	const [index] = await awaiter.await(appender.add(newEntry(data)));
	const { checkpoint } = await fetchCheckpoint((s) => reader.readCheckpoint(s), verifier, verifier.name());
	const proofs = await newProofBuilder(checkpoint.size, (l, i, p, s) => reader.readTile(l, i, p, s));
	const proof = await proofs.inclusionProof(index.index);
	verifyInclusion(DefaultHasher, index.index, checkpoint.size, DefaultHasher.hashLeaf(data), proof, checkpoint.hash);
	await shutdown();
	ac.abort();
	return { index: index.index, size: checkpoint.size };
}

const first = await appendAndProve({}, 300, "local");
const second = await appendAndProve({ locking: "lease" }, 20, "lease");
if (first.index !== 300n || second.index !== 321n || second.size < 322n) {
	throw new Error(`unexpected result: indices ${first.index} and ${second.index}, checkpoint size ${second.size}`);
}
const version = database.query({ sql: "SELECT sqlite_version() AS v", params: [] });
// biome-ignore lint/suspicious/noConsole: the script's output is its report; console is the one sink every runtime shares.
console.log(
	`smoke-sqlite: ok on ${engine}, SQLite ${(await version)[0]?.v} (index ${second.index} proven in a tree of ${second.size})`,
);
