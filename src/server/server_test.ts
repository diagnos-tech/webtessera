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

// Tests for webtessera/server on Node: the entry point and its export conditions, and
// openServerLog with every guardrail it promises. The browser half of the guard is tested
// in Chromium by guard_browser_test.ts, and the workerd half by server_workers_test.ts.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { newWitness, newWitnessGroup } from "webtessera";
import {
	importLogKey,
	MaxExtraDataBytes,
	openServerLog,
	parseReceipt,
	type ServerLog,
	verifyReceipt,
} from "webtessera/server";
import { fromSqliteSync, type SqlDatabase } from "webtessera/storage/sqlite";
import { newSignerForCosignatureV1, newWitnessServer, vKeyToCosignatureV1 } from "webtessera/witness";
import type { FetchFn } from "../client/fetcher.ts";
import { newEntry } from "../entry.ts";
import { newVerifiedMirror } from "../mirror/verify.ts";
import { generateLogKey } from "../safe/keys.ts";
import { ServerOnlyMessage } from "../safe/runtime.ts";
import { MemoryObjectStore } from "../storage/memory/memory.ts";
import type { ObjectInfo, ObjectStore } from "../storage/objectstore/objectstore.ts";
import { generateKey, newSigner } from "../vendor/note/note.ts";

const enc = new TextEncoder();
const dirs: string[] = [];

/**
 * RecordingStore is an ObjectStore over memory that openServerLog accepts as durable (it
 * refuses a MemoryObjectStore as objectStore), and that records which entry bundles are read.
 */
class RecordingStore implements ObjectStore {
	readonly bundleReads: string[] = [];
	readonly #store = new MemoryObjectStore();

	get(key: string): Promise<Uint8Array | undefined> {
		if (key.startsWith("tile/entries/")) {
			this.bundleReads.push(key);
		}
		return this.#store.get(key);
	}
	stat(key: string): Promise<ObjectInfo | undefined> {
		return this.#store.stat(key);
	}
	put(key: string, data: Uint8Array): Promise<void> {
		return this.#store.put(key, data);
	}
	create(key: string, data: Uint8Array): Promise<boolean> {
		return this.#store.create(key, data);
	}
	deletePrefix(prefix: string): Promise<void> {
		return this.#store.deletePrefix(prefix);
	}
	lock<T>(name: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		return this.#store.lock(name, fn, signal);
	}
}

afterAll(() => {
	for (const d of dirs) {
		rmSync(d, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const d = mkdtempSync(join(tmpdir(), "webtessera-server-"));
	dirs.push(d);
	return d;
}

/** recording wraps a SqlDatabase and records every statement it runs. */
function recording(db: SqlDatabase): { db: SqlDatabase; sql: string[] } {
	const sql: string[] = [];
	return {
		sql,
		db: {
			query: (st) => {
				sql.push(st.sql);
				return db.query(st);
			},
			batch: (sts) => {
				sql.push(...sts.map((s) => s.sql));
				return db.batch(sts);
			},
			defaultLocking: db.defaultLocking,
			leaseClock: db.leaseClock,
		},
	};
}

describe("webtessera/server", () => {
	it("imports in Node and exports the safe API", async () => {
		const mod = await import("webtessera/server");
		expect(Object.keys(mod).sort()).toEqual(
			[
				"DefaultCheckpointIntervalMs",
				"DefaultPublishTimeoutMs",
				"MaxExtraDataBytes",
				"ReceiptError",
				"detectRuntime",
				"generateLogKey",
				"importLogKey",
				"openServerLog",
				"parseReceipt",
				"verifyReceipt",
				"webCryptoEd25519",
			].sort(),
		);
	});

	it("resolves to a module that fails under the browser condition, whose message is the runtime check's", async () => {
		await expect(import("./browser_guard.ts")).rejects.toThrow(ServerOnlyMessage);
		const source = readFileSync(new URL("./browser_guard.ts", import.meta.url), "utf8");
		expect(source).toContain(`throw new Error(${JSON.stringify(ServerOnlyMessage)});`);
	});

	describe("package.json export conditions", () => {
		// A copy of the package's real exports map and sideEffects list, with a stand-in for each
		// target, resolved by Node's own resolver under each set of conditions a toolchain
		// applies, and bundled by esbuild. Bundlers implement Node's algorithm: the first listed
		// condition they apply wins.
		const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
			exports: Record<string, string | Record<string, string>>;
			sideEffects: readonly string[] | false;
		};
		const dir = tempDir();
		const root = join(dir, "node_modules", "webtessera");
		mkdirSync(join(root, "dist", "server"), { recursive: true });
		mkdirSync(join(root, "dist", "browser"), { recursive: true });
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				name: "webtessera",
				type: "module",
				sideEffects: pkg.sideEffects,
				exports: { "./server": pkg.exports["./server"], "./browser": pkg.exports["./browser"] },
			}),
		);
		// Stand-ins with the shape of the real modules: the guard exports nothing and throws.
		writeFileSync(
			join(root, "dist/server/index.js"),
			'export function openServerLog() {}\nexport const marker = "server";\n',
		);
		writeFileSync(join(root, "dist/server/browser_guard.js"), 'throw new Error("guard");\nexport {};\n');
		writeFileSync(join(root, "dist/browser/index.js"), "export function openBrowserLog() {}\n");

		function resolve(conditions: string[], specifier = "webtessera/server"): string {
			const out = execFileSync(
				execPath,
				[
					...conditions.flatMap((c) => ["-C", c]),
					"--input-type=module",
					"-e",
					`process.stdout.write(import.meta.resolve(${JSON.stringify(specifier)}))`,
				],
				{ cwd: dir, encoding: "utf8" },
			);
			return out.slice(out.indexOf("/dist/") + 1);
		}

		const cases: { toolchain: string; conditions: string[]; want: string }[] = [
			{ toolchain: "Node, Deno and Bun (no extra conditions)", conditions: [], want: "dist/server/index.js" },
			{
				toolchain: "a browser bundle (Vite, esbuild, Rollup, Parcel)",
				conditions: ["browser"],
				want: "dist/server/browser_guard.js",
			},
			{
				toolchain: "webpack's webworker target",
				conditions: ["worker", "browser"],
				want: "dist/server/browser_guard.js",
			},
			{ toolchain: "React Native", conditions: ["react-native"], want: "dist/server/browser_guard.js" },
			{
				toolchain: "wrangler (Cloudflare Workers)",
				conditions: ["workerd", "worker", "browser"],
				want: "dist/server/index.js",
			},
			{
				toolchain: "Vercel's Edge Runtime",
				conditions: ["edge-light", "worker", "browser"],
				want: "dist/server/index.js",
			},
			{ toolchain: "Deno's npm resolution", conditions: ["deno"], want: "dist/server/index.js" },
		];
		for (const c of cases) {
			it(`resolves webtessera/server for ${c.toolchain} to ${c.want}`, () => {
				expect(resolve(c.conditions)).toBe(c.want);
			});
		}

		describe("with esbuild, the bundler under Vite, wrangler and Bun's", () => {
			// A root dev dependency, pinned to the version Vite and wrangler resolve, so that the
			// guard is tested against the bundler that real toolchains run.
			const esbuild = createRequire(import.meta.url)("esbuild") as {
				build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
			};

			function bundle(source: string, options: Record<string, unknown>): Promise<string> {
				const entry = join(dir, `entry-${Math.random().toString(36).slice(2)}.mjs`);
				writeFileSync(entry, source);
				return esbuild
					.build({
						entryPoints: [entry],
						bundle: true,
						format: "esm",
						write: false,
						logLevel: "silent",
						absWorkingDir: dir,
						...options,
					})
					.then((r) => r.outputFiles[0]?.text ?? "");
			}

			it("fails a browser build that imports a name from webtessera/server, at the guard", async () => {
				await expect(
					bundle('import { openServerLog } from "webtessera/server";\nopenServerLog();\n', { platform: "browser" }),
				).rejects.toMatchObject({
					errors: [
						expect.objectContaining({
							text: expect.stringMatching(/No matching export in .*browser_guard\.js.* "openServerLog"/),
						}),
					],
				});
			});

			it("keeps the throwing guard in a browser build that imports webtessera/server for its side effects", async () => {
				const out = await bundle('import "webtessera/server";\n', { platform: "browser" });
				expect(out).toContain('throw new Error("guard")');
			});

			it("bundles the real module for Cloudflare Workers", async () => {
				const out = await bundle('import { marker } from "webtessera/server";\nconsole.log(marker);\n', {
					platform: "neutral",
					conditions: ["workerd", "worker", "browser"],
				});
				expect(out).toContain('"server"');
			});
		});

		it("resolves webtessera/browser to the same module everywhere", () => {
			expect(resolve([], "webtessera/browser")).toBe("dist/browser/index.js");
			expect(resolve(["browser"], "webtessera/browser")).toBe("dist/browser/index.js");
		});
	});
});

describe("importLogKey", () => {
	it("imports a signer key from a secret store as a non-extractable key", async () => {
		const { skey, vkey } = generateKey(undefined, "example.com/log");
		const key = await importLogKey(skey);
		expect(key.vkey).toBe(vkey);
		expect(key.extractable).toBe(false);
		expect(`${key}`).not.toContain(skey.slice(-20));
	});
});

describe("openServerLog", () => {
	it("appends to SQLite, hands back verified receipts, proves, serves, and survives a restart", async () => {
		const file = join(tempDir(), "log.db");
		const { skey } = generateKey(undefined, "example.com/log");
		const db = new DatabaseSync(file);
		const log = await openServerLog({ key: await importLogKey(skey), storage: { sqlite: fromSqliteSync(db) } });
		expect(log).toBeInstanceOf(Object);
		expect(log.storage).toBe("sqlite");
		const data = Array.from({ length: 20 }, (_, i) => enc.encode(`entry ${i}`));
		const receipts = await Promise.all(data.map((d) => log.append(d)));
		expect(receipts.map((r) => r.index).sort((a, b) => (a < b ? -1 : 1))).toEqual(data.map((_, i) => BigInt(i)));
		for (const [i, r] of receipts.entries()) {
			const d = data[i] as Uint8Array;
			expect(verifyReceipt(r.text, { vkey: log.vkey, data: d }).index).toBe(r.index);
			expect(log.verify(r, d).index).toBe(r.index);
			expect(parseReceipt(r.text).index).toBe(r.index);
			expect(r.checkpoint.size).toBeGreaterThan(r.index);
		}

		const latest = await log.latestCheckpoint();
		expect(latest.size).toBe(20n);
		expect(latest.origin).toBe("example.com/log");
		const proved = await log.prove(7);
		expect(proved.checkpoint.size).toBe(20n);
		expect(verifyReceipt(proved, { vkey: log.vkey, data: data[7] as Uint8Array }).index).toBe(7n);
		await expect(log.prove(20n)).rejects.toThrow(/covers entries 0 to 19, not 20/);
		await expect(log.prove(-1)).rejects.toThrow(/non-negative integer/);

		const res = await log.handler(new Request("https://log.example/checkpoint"));
		expect(res?.status).toBe(200);
		expect(new Uint8Array(await (res as Response).arrayBuffer())).toEqual(latest.signed);

		await log.close();
		await log.close();
		await expect(log.append(enc.encode("late"))).rejects.toThrow("append: this log is closed");
		db.close();

		const again = await openServerLog({
			key: await importLogKey(skey),
			storage: { sqlite: fromSqliteSync(new DatabaseSync(file)) },
		});
		try {
			expect((await again.latestCheckpoint()).size).toBe(20n);
			expect((await again.append(enc.encode("after restart"))).index).toBe(20n);
		} finally {
			await again.close();
		}
	});

	it("refuses to open a log that another key created", async () => {
		const db = fromSqliteSync(new DatabaseSync(":memory:"));
		const first = await openServerLog({ key: await generateLogKey("example.com/log"), storage: { sqlite: db } });
		await first.append(enc.encode("x"));
		await first.close();
		await expect(
			openServerLog({ key: await generateLogKey("example.com/log"), storage: { sqlite: db } }),
		).rejects.toThrow(/holds a log that was not created with this key: its published checkpoint does not verify/);
		await expect(
			openServerLog({ key: await generateLogKey("example.com/other"), storage: { sqlite: db } }),
		).rejects.toThrow(/was not created with this key/);
	});

	it("locks SQLite as its adapter does, leases for a file and local for a private database, unless told", async () => {
		const leases = async (db: SqlDatabase, locking?: "lease" | "local"): Promise<boolean> => {
			const rec = recording(db);
			const log = await openServerLog({
				key: await generateLogKey("example.com/log"),
				storage: locking === undefined ? { sqlite: rec.db } : { sqlite: rec.db, locking },
			});
			await log.append(enc.encode("x"));
			await log.close();
			return rec.sql.some((s) => s.includes("INTO webtessera_locks"));
		};
		// A file another process could open: fromSqliteSync, and so the log, takes leases.
		expect(await leases(fromSqliteSync(new DatabaseSync(join(tempDir(), "log.db"))))).toBe(true);
		// An in-memory database nothing outside this process can reach: local locks.
		expect(await leases(fromSqliteSync(new DatabaseSync(":memory:")))).toBe(false);
		// An adapter that does not say gets leases (ADR-0210).
		const memory = fromSqliteSync(new DatabaseSync(":memory:"));
		expect(await leases({ query: (st) => memory.query(st), batch: (sts) => memory.batch(sts) })).toBe(true);
		// The caller's choice wins, either way.
		expect(await leases(fromSqliteSync(new DatabaseSync(join(tempDir(), "log.db"))), "local")).toBe(false);
		expect(await leases(fromSqliteSync(new DatabaseSync(":memory:")), "lease")).toBe(true);
	});

	it("keeps a log in memory only when asked to by name", async () => {
		const key = await generateLogKey("example.com/log");
		const log = await openServerLog({ key, storage: { memory: true } });
		expect(log.storage).toBe("memory");
		await log.close();
		await expect(openServerLog({ key, storage: { objectStore: new MemoryObjectStore() } })).rejects.toThrow(
			/MemoryObjectStore keeps nothing once the process exits; pass storage: \{ memory: true \}/,
		);
		await expect(openServerLog({ key } as never)).rejects.toThrow(/choose where the log is kept/);
		await expect(openServerLog({ key, storage: { memory: false } } as never)).rejects.toThrow(
			/choose where the log is kept/,
		);
	});

	it("refuses keys that are not LogKeys, without echoing a private key", async () => {
		const { skey } = generateKey(undefined, "example.com/log");
		const err = (await openServerLog({ key: skey as never, storage: { memory: true } }).catch(
			(e: unknown) => e,
		)) as Error;
		expect(err.message).toMatch(/key must be a LogKey, not a string.*importLogKey\(skey\)/);
		expect(err.message).not.toContain(skey.slice(-20));
		await expect(openServerLog({ key: newSigner(skey) as never, storage: { memory: true } })).rejects.toThrow(
			/must be a LogKey made by generateLogKey, importLogKey or openDeviceKey/,
		);
		await expect(openServerLog(undefined as never)).rejects.toThrow(/takes an options object/);
	});

	it("refuses entries it cannot hold, and intervals the driver cannot run", async () => {
		const key = await generateLogKey("example.com/log");
		await expect(openServerLog({ key, storage: { memory: true }, checkpointIntervalMs: 50 })).rejects.toThrow(
			"checkpointIntervalMs must be at least 100",
		);
		const log = await openServerLog({ key, storage: { memory: true } });
		try {
			await expect(log.append(new Uint8Array(65536))).rejects.toThrow(/at most 65535 bytes.*SHA-256 digest/);
			await expect(log.append("text" as never)).rejects.toThrow(/new TextEncoder\(\)\.encode/);
			expect((await log.append(new Uint8Array(65535))).index).toBe(0n);
		} finally {
			await log.close();
		}
	});

	describe("reading entries back", () => {
		async function filled(n: number): Promise<{ log: ServerLog; store: RecordingStore; data: Uint8Array[] }> {
			const store = new RecordingStore();
			const log = await openServerLog({
				key: await generateLogKey("example.com/log"),
				storage: { objectStore: store },
				appendOptions: (o) => o.withBatching(1024, 10),
			});
			const data = Array.from({ length: n }, (_, i) => enc.encode(`entry ${i}`));
			// Indices are assigned in the order entries are added, so the receipt for the last
			// entry means that a published checkpoint covers them all.
			for (const d of data.slice(0, -1)) {
				log.appender.add(newEntry(d));
			}
			await log.append(data.at(-1) as Uint8Array);
			return { log, store, data };
		}

		async function collect(it: AsyncIterable<{ index: bigint; data: Uint8Array }>): Promise<bigint[]> {
			const out: bigint[] = [];
			for await (const e of it) {
				out.push(e.index);
			}
			return out;
		}

		it("streams every entry, in order, across full and partial bundles", async () => {
			const { log, data } = await filled(600);
			try {
				let i = 0n;
				for await (const e of log.entries()) {
					expect(e.index).toBe(i);
					expect(e.data).toEqual(data[Number(i)]);
					i++;
				}
				expect(i).toBe(600n);
				expect((await log.entry(511)).data).toEqual(data[511]);
				expect((await log.entry(599n)).data).toEqual(data[599]);
			} finally {
				await log.close();
			}
		});

		it("reads a range, clamped to the latest checkpoint, and refuses what it does not cover", async () => {
			const { log } = await filled(300);
			try {
				expect(await collect(log.entries(250, 260))).toEqual(Array.from({ length: 10 }, (_, i) => BigInt(250 + i)));
				expect(await collect(log.entries(255n, 257n))).toEqual([255n, 256n]);
				expect(await collect(log.entries(290, 1_000))).toHaveLength(10);
				expect(await collect(log.entries(300))).toEqual([]);
				expect(await collect(log.entries(7, 7))).toEqual([]);
				await expect(collect(log.entries(301))).rejects.toThrow(
					/entries: the latest checkpoint covers entries 0 to 299, not 301/,
				);
				expect(() => log.entries(5, 4)).toThrow("entries: from must not be greater than to, got from 5 and to 4");
				expect(() => log.entries(-1)).toThrow("entries: the from must be a non-negative integer, got -1");
				expect(() => log.entries(0, 1.5)).toThrow("entries: the to must be a non-negative integer, got 1.5");
				await expect(log.entry(300)).rejects.toThrow(/entry: the latest checkpoint covers entries 0 to 299, not 300/);
				await expect(log.entry(-1)).rejects.toThrow(/entry: the index must be a non-negative integer/);
			} finally {
				await log.close();
			}
			const empty = await openServerLog({ key: await generateLogKey("example.com/log"), storage: { memory: true } });
			try {
				expect(await collect(empty.entries())).toEqual([]);
				await expect(empty.entry(0)).rejects.toThrow(/entry: the latest checkpoint covers no entries, not 0/);
			} finally {
				await empty.close();
			}
		});

		it("reads only the bundles it yields from, and stops reading when the loop does", async () => {
			const { log, store } = await filled(2_600);
			try {
				store.bundleReads.length = 0;
				expect(await collect(log.entries(260, 270))).toHaveLength(10);
				expect(store.bundleReads).toEqual(["tile/entries/001"]);

				store.bundleReads.length = 0;
				for await (const e of log.entries()) {
					if (e.index === 3n) {
						break;
					}
				}
				// The first bundle, and the read-ahead window topped up once it arrived: five of
				// the log's eleven bundles, whatever its size.
				expect(store.bundleReads.length).toBeLessThanOrEqual(5);
				expect((await log.entry(2_599)).index).toBe(2_599n);
			} finally {
				await log.close();
			}
		});

		it("refuses an entry its tiles do not commit to, rather than yield it", async () => {
			const { log, store, data } = await filled(10);
			try {
				// Flip a bit of the last entry's bytes in its bundle, and nothing else.
				const bundle = (await store.get("tile/entries/000.p/10")) as Uint8Array;
				bundle.set([(bundle.at(-1) as number) ^ 1], bundle.length - 1);
				await store.put("tile/entries/000.p/10", bundle);
				expect((await log.entry(8)).data).toEqual(data[8]);
				await expect(log.entry(9)).rejects.toThrow(
					/entry: entry 9 in the log's storage is not the entry its tiles commit to; .*check it with fsck/,
				);
				await expect(collect(log.entries())).rejects.toThrow(/entries: entry 9 in the log's storage/);
			} finally {
				await log.close();
			}
		});

		it("refuses to read once the log is closed", async () => {
			const { log } = await filled(3);
			await log.close();
			expect(() => log.entries()).toThrow("entries: this log is closed");
			await expect(log.entry(0)).rejects.toThrow("entry: this log is closed");
		});
	});

	describe("receipts with extra data", () => {
		it("carries extraData in the extra line, from append and from prove", async () => {
			const log = await openServerLog({ key: await generateLogKey("example.com/log"), storage: { memory: true } });
			try {
				const data = enc.encode("a record");
				const r = await log.append(data, { extraData: data });
				expect(r.proof.extraData).toEqual(data);
				expect(r.text).toContain(`\nextra ${btoa("a record")}\n`);
				const v = verifyReceipt(r.text, { vkey: log.vkey, dataInExtra: true });
				expect([v.index, v.data]).toEqual([r.index, data]);

				const context = enc.encode("session 7");
				const proved = await log.prove(r.index, { extraData: context });
				expect(verifyReceipt(proved, { vkey: log.vkey, data }).extraData).toEqual(context);
				expect((await log.prove(r.index, AbortSignal.timeout(5_000))).proof.extraData).toBeUndefined();
				expect((await log.append(enc.encode("none"))).text).not.toContain("\nextra ");
				expect((await log.append(enc.encode("empty"), { extraData: new Uint8Array(0) })).text).toContain("\nextra \n");
			} finally {
				await log.close();
			}
		});

		it("refuses extra data a receipt could not carry, before it appends anything", async () => {
			const log = await openServerLog({ key: await generateLogKey("example.com/log"), storage: { memory: true } });
			try {
				const most = new Uint8Array(MaxExtraDataBytes).fill(0x61);
				const r = await log.append(enc.encode("x"), { extraData: most });
				// The longest extra line that the format's decoders read back.
				expect(parseReceipt(r.text).extraData).toEqual(most);
				await expect(log.append(enc.encode("y"), { extraData: new Uint8Array(MaxExtraDataBytes + 1) })).rejects.toThrow(
					`append: a receipt carries at most ${MaxExtraDataBytes} bytes of extra data, and this is 49147`,
				);
				await expect(log.prove(0, { extraData: "text" as never })).rejects.toThrow(
					"prove: extraData must be a Uint8Array",
				);
				expect((await log.latestCheckpoint()).size).toBe(1n);
			} finally {
				await log.close();
			}
		});
	});

	it("installs its own key over one set by appendOptions", async () => {
		const key = await generateLogKey("example.com/log");
		const intruder = newSigner(generateKey(undefined, "example.com/log").skey);
		const log = await openServerLog({
			key,
			storage: { memory: true },
			appendOptions: (o) => o.withCheckpointSigner(intruder).withBatching(1, 0),
		});
		try {
			const r = await log.append(enc.encode("x"));
			expect(verifyReceipt(r, { vkey: key.vkey, data: enc.encode("x") }).index).toBe(0n);
		} finally {
			await log.close();
		}
	});

	describe("with a witness (session receipts)", () => {
		const witnessKey = generateKey(undefined, "witness.example");

		/** setup opens a witnessed log; cutOff makes the witness unreachable from then on. */
		async function setup(
			origin: string,
			options: { witnessTimeoutMs?: number } = {},
		): Promise<{ log: ServerLog; cutOff: () => void }> {
			const key = await generateLogKey(origin);
			const witness = newWitnessServer({
				signer: newSignerForCosignatureV1(witnessKey.skey),
				store: new MemoryObjectStore(),
				lookupLog: (o) => (o === key.origin ? { verifierKeys: [key.vkey] } : undefined),
			});
			let reachable = true;
			const fetch: FetchFn = async (input, init) => {
				if (!reachable) {
					throw new TypeError("fetch failed");
				}
				return (await witness.handle(new Request(input, init))) ?? new Response("not found", { status: 404 });
			};
			const log = await openServerLog({
				key,
				storage: { memory: true },
				witnesses: newWitnessGroup(
					1,
					newWitness(vKeyToCosignatureV1(witnessKey.vkey), new URL("https://witness.example/")),
				),
				fetch,
				...options,
			});
			return {
				log,
				cutOff: () => {
					reachable = false;
				},
			};
		}

		it("hands back receipts the witness cosigned, which a k-of-n policy accepts offline", async () => {
			const { log } = await setup("session.example/user-1");
			try {
				const data = enc.encode("POST /cart 200");
				const r = await log.append(data);
				const v = verifyReceipt(r.text, {
					vkey: log.vkey,
					data,
					witnesses: { threshold: 1, witnesses: [witnessKey.vkey] },
				});
				expect(v.cosignedBy).toEqual(["witness.example"]);
				expect(log.verify(r, data).cosignedBy).toEqual(["witness.example"]);
			} finally {
				await log.close();
			}
		});

		it("gives up on a receipt the witness never cosigns, saying where the entry is and what to check", async () => {
			const { log, cutOff } = await setup("session.example/user-2", { witnessTimeoutMs: 100 });
			cutOff();
			try {
				await expect(log.append(enc.encode("x"), { timeoutMs: 1_500 })).rejects.toThrow(
					/durably sequenced at index 0, but no checkpoint covering it was published within 1500 ms\. If the log has witnesses, check that they are reachable, and that none has cosigned a larger or different tree than this storage holds; call prove\(0n\)/,
				);
				const ac = new AbortController();
				const pending = log.append(enc.encode("y"), { signal: ac.signal });
				ac.abort(new Error("user went away"));
				await expect(pending).rejects.toThrow("user went away");
			} finally {
				await log.close(AbortSignal.timeout(300)).catch(() => {});
			}
		});

		it("says that storage holds an older log than its witness cosigned, when the witness has seen more", async () => {
			const key = await generateLogKey("session.example/user-4");
			const witness = newWitnessServer({
				signer: newSignerForCosignatureV1(witnessKey.skey),
				store: new MemoryObjectStore(),
				lookupLog: (o) => (o === key.origin ? { verifierKeys: [key.vkey] } : undefined),
			});
			const options = {
				key,
				witnesses: newWitnessGroup(
					1,
					newWitness(vKeyToCosignatureV1(witnessKey.vkey), new URL("https://witness.example/")),
				),
				witnessTimeoutMs: 1_000,
				fetch: (async (input, init) =>
					(await witness.handle(new Request(input, init))) ?? new Response("not found", { status: 404 })) as FetchFn,
			};
			const first = await openServerLog({ ...options, storage: { memory: true } });
			await Promise.all([first.append(enc.encode("a")), first.append(enc.encode("b"))]);
			await first.close();

			// The same log, opened on storage that lost what the witness saw.
			const err = (await openServerLog({ ...options, storage: { memory: true } }).catch((e: unknown) => e)) as Error;
			expect(err.message).toMatch(
				/^openServerLog: this storage holds an older or different log than its witnesses cosigned: the witness at "https:\/\/witness\.example\/add-checkpoint" has cosigned this log at size 2, and the storage holds no entries \(it is empty, or was wiped\)\. /,
			);
			expect(err.message).toContain("Open the storage that holds the log the witnesses saw");
			expect(err.message).toContain("replied with x.tlog.size 2, larger than log size 0");
			expect(err.message).not.toContain("must be reachable");
		});

		it("cannot create a log while its witnesses are unreachable, and says why", async () => {
			const key = await generateLogKey("session.example/user-3");
			await expect(
				openServerLog({
					key,
					storage: { memory: true },
					witnesses: newWitnessGroup(
						1,
						newWitness(vKeyToCosignatureV1(witnessKey.vkey), new URL("https://witness.example/")),
					),
					witnessTimeoutMs: 100,
					fetch: async () => {
						throw new TypeError("fetch failed");
					},
				}),
			).rejects.toThrow(/could not start the log: [\s\S]*its witnesses must be reachable then/);
		});
	});

	it("is a Source for the ported mirror, which copies it only as far as it verifies", async () => {
		const log = await openServerLog({ key: await generateLogKey("example.com/log"), storage: { memory: true } });
		try {
			await Promise.all([1, 2, 3].map((i) => log.append(enc.encode(`e${i}`))));
			const target = new MemoryObjectStore();
			await newVerifiedMirror({ source: log.reader, target, origin: log.origin, verifier: log.verifier }).run();
			expect(await target.get("checkpoint")).toEqual((await log.latestCheckpoint()).signed);
		} finally {
			await log.close();
		}
	});
});
