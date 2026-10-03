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

// The SQLite ObjectStore's own behaviour, beyond what the ObjectStore conformance suite
// asks of every backend: how objects are laid out in rows, how deletePrefix maps onto
// SQLite's byte ordering, and how namespaces and schema versions keep logs apart. Every
// engine's suite runs it, so that each engine's SQL semantics are checked, not just
// node:sqlite's. Runtime-neutral and test-only.

import { describe, expect, it } from "vitest";
import { bytesEqual } from "../../../internal/gostd/bytes.ts";
import { errorIs } from "../../../internal/gostd/errors.ts";
import type { SqlDatabase } from "../database.ts";
import { ErrLeaseLost } from "../lease.ts";
import { type Tables, tableNames } from "../schema.ts";
import { openSqliteObjectStore, type SqliteObjectStore } from "../sqlite.ts";
import { prefixCases } from "./prefix_cases.ts";
import { type StoreOptions, type StoreTarget, uniqueNamespace } from "./stores.ts";

const enc = new TextEncoder();

function filled(n: number, seed: number): Uint8Array {
	const b = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		b[i] = (i * 31 + seed) & 0xff;
	}
	return b;
}

/** opened is a store together with the database and tables behind it. */
interface opened {
	readonly store: SqliteObjectStore;
	readonly db: SqlDatabase;
	readonly t: Tables;
}

/**
 * describeSqliteBehaviour registers the SQLite ObjectStore behaviour suite under a
 * describe block called name. newTarget returns a fresh, empty target per call.
 */
export function describeSqliteBehaviour(
	name: string,
	newTarget: () => StoreTarget | Promise<StoreTarget>,
	options: StoreOptions = {},
): void {
	const max = 1000;
	const open = async (o: StoreOptions = {}, target?: StoreTarget): Promise<opened> => {
		const tg = target ?? (await newTarget());
		const store = await openSqliteObjectStore({ ...options, maxChunkBytes: max, ...o, ...tg });
		return { store, db: tg.database, t: tableNames(tg.namespace) };
	};
	const chunkRows = async (o: opened, key: string): Promise<number> => {
		const rows = await o.db.query({
			sql: `SELECT count(*) AS n FROM ${o.t.chunks} WHERE key = CAST(? AS TEXT)`,
			params: [enc.encode(key)],
		});
		return Number(rows[0]?.n);
	};
	const allKeys = async (o: opened, table: string): Promise<number> => {
		const rows = await o.db.query({ sql: `SELECT count(*) AS n FROM ${table}`, params: [] });
		return Number(rows[0]?.n);
	};

	describe(`${name}: SQLite ObjectStore behaviour`, () => {
		for (const c of prefixCases) {
			it(`deletes by prefix exactly: ${c.name}`, async () => {
				for (const k of c.drop) {
					expect(k.startsWith(c.prefix), `${JSON.stringify(k)} is in the case's drop list`).toBe(true);
				}
				for (const k of c.keep) {
					expect(k.startsWith(c.prefix), `${JSON.stringify(k)} is in the case's keep list`).toBe(false);
				}
				const o = await open();
				// Every other key is chunked, so that chunk rows are held to the same ordering.
				const keys = [...c.drop, ...c.keep];
				for (const [i, k] of keys.entries()) {
					await o.store.put(k, i % 2 === 0 ? enc.encode(k) : filled(2 * max + 1, i));
				}
				await o.store.deletePrefix(c.prefix);
				for (const k of c.drop) {
					expect(await o.store.stat(k), `${JSON.stringify(k)} was deleted`).toBeUndefined();
					expect(await chunkRows(o, k), `${JSON.stringify(k)}'s chunks were deleted`).toBe(0);
				}
				for (const [i, k] of keys.entries()) {
					if (!c.drop.includes(k)) {
						const want = i % 2 === 0 ? enc.encode(k) : filled(2 * max + 1, i);
						const got = await o.store.get(k);
						expect(got !== undefined && bytesEqual(got, want), `${JSON.stringify(k)} was kept`).toBe(true);
					}
				}
			});
		}

		it("keeps objects of at most maxChunkBytes in one row, and splits larger ones", async () => {
			const o = await open();
			for (const size of [0, 1, max - 1, max, max + 1, 3 * max, 3 * max + 7]) {
				const key = `tile/entries/${size}`;
				await o.store.put(key, filled(size, size));
				expect(await chunkRows(o, key), `${size} bytes`).toBe(Math.max(0, Math.ceil(size / max) - 1));
				const got = await o.store.get(key);
				expect(got !== undefined && bytesEqual(got, filled(size, size)), `${size} bytes`).toBe(true);
				expect((await o.store.stat(key))?.size, `${size} bytes`).toBe(size);
			}
		});

		it("leaves no stale chunks when an object is overwritten", async () => {
			const o = await open();
			for (const size of [5 * max, 3 * max, 7 * max + 1, 2 * max, 10, 0, 4 * max]) {
				await o.store.put("k", filled(size, size));
				expect(await chunkRows(o, "k"), `after writing ${size} bytes`).toBe(Math.max(0, Math.ceil(size / max) - 1));
				const got = await o.store.get("k");
				expect(got !== undefined && bytesEqual(got, filled(size, size)), `${size} bytes`).toBe(true);
			}
		});

		it("creates a chunked object only when absent, leaving an existing one untouched", async () => {
			const o = await open();
			expect(await o.store.create("bundle", filled(4 * max, 1))).toBe(true);
			const before = await o.store.stat("bundle");
			expect(await o.store.create("bundle", filled(6 * max + 5, 2))).toBe(false);
			expect(await o.store.create("bundle", new Uint8Array(0))).toBe(false);
			expect(await o.store.stat("bundle")).toEqual(before);
			expect(await chunkRows(o, "bundle")).toBe(3);
			const got = await o.store.get("bundle");
			expect(got !== undefined && bytesEqual(got, filled(4 * max, 1))).toBe(true);
		});

		it("stores only the bytes a subarray covers", async () => {
			const o = await open();
			const backing = filled(64 * max, 5);
			await o.store.put("small", backing.subarray(10, 20));
			await o.store.put("large", backing.subarray(max, 4 * max + 3));
			expect(await o.store.get("small")).toEqual(backing.slice(10, 20));
			const got = await o.store.get("large");
			expect(got !== undefined && bytesEqual(got, backing.slice(max, 4 * max + 3))).toBe(true);
		});

		it("stamps modTime from the store's clock", async () => {
			let now = 1_700_000_000_123;
			const o = await open({ clock: () => now });
			await o.store.put("checkpoint", enc.encode("one"));
			expect((await o.store.stat("checkpoint"))?.modTime).toBe(1_700_000_000_123);
			now += 2500.7;
			await o.store.create("other", enc.encode("two"));
			expect((await o.store.stat("other"))?.modTime).toBe(1_700_000_002_623);
		});

		it("keeps the logs of different namespaces apart in one database", async () => {
			const { database } = await newTarget();
			const namespaces = [uniqueNamespace(), uniqueNamespace()] as const;
			const a = await open({}, { database, namespace: namespaces[0] });
			const b = await open({}, { database, namespace: namespaces[1] });
			await a.store.put("checkpoint", enc.encode("a"));
			await b.store.put("checkpoint", enc.encode("b"));
			await a.store.put("tile/entries/000", filled(3 * max, 1));
			await b.store.deletePrefix("");
			expect(await a.store.get("checkpoint")).toEqual(enc.encode("a"));
			expect(await b.store.get("checkpoint")).toBeUndefined();
			expect(await chunkRows(a, "tile/entries/000")).toBe(2);
			expect(await allKeys(b, b.t.objects)).toBe(0);
			expect(a.store.namespace).toBe(namespaces[0]);
		});

		it("opens an existing namespace without disturbing it", async () => {
			const target = await newTarget();
			const first = await open({}, target);
			await first.store.put("tile/entries/000", filled(3 * max, 9));
			const second = await open({}, target);
			const got = await second.store.get("tile/entries/000");
			expect(got !== undefined && bytesEqual(got, filled(3 * max, 9))).toBe(true);
		});

		it("rejects keys that are not well-formed Unicode", async () => {
			const o = await open();
			const bad = "tile/\ud800/x";
			await expect(o.store.get(bad)).rejects.toThrow("lone surrogate");
			await expect(o.store.stat(bad)).rejects.toThrow("lone surrogate");
			await expect(o.store.put(bad, new Uint8Array(1))).rejects.toThrow("lone surrogate");
			await expect(o.store.create(bad, new Uint8Array(1))).rejects.toThrow("lone surrogate");
			expect(await allKeys(o, o.t.objects)).toBe(0);
		});

		it("reports rows that do not add up to an object as corrupt", async () => {
			const o = await open();
			await o.store.put("k", filled(3 * max, 1));
			await o.db.query({ sql: `DELETE FROM ${o.t.chunks} WHERE seq = 1`, params: [] });
			await expect(o.store.get("k")).rejects.toThrow("chunk 1 is missing");
			await o.store.put("k", filled(2 * max, 1));
			await o.db.query({ sql: `UPDATE ${o.t.objects} SET size = size + 1`, params: [] });
			await expect(o.store.get("k")).rejects.toThrow("want 2001");
			await o.db.query({ sql: `DELETE FROM ${o.t.objects}`, params: [] });
			await expect(o.store.get("k")).rejects.toThrow("no object row");
		});

		it("refuses every write of a lease holder once another holder has taken the lock over", async () => {
			const o = await open({ locking: "lease" });
			await o.store.put("checkpoint", enc.encode("before"));
			await o.store.lock("treeState.lock", async () => {
				await o.db.query({ sql: `UPDATE ${o.t.locks} SET holder = 'another holder'`, params: [] });
				for (const write of [
					() => o.store.put("checkpoint", enc.encode("stale")),
					() => o.store.create("tile/0/000", enc.encode("stale")),
					() => o.store.deletePrefix(""),
				]) {
					const err = await write().catch((e: unknown) => e);
					expect(errorIs(err, ErrLeaseLost), String(err)).toBe(true);
				}
			});
			expect(await o.store.get("checkpoint")).toEqual(enc.encode("before"));
			expect(await o.store.get("tile/0/000")).toBeUndefined();
			expect(await allKeys(o, o.t.fence)).toBe(0);
		});
	});
}
