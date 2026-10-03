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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { newWitness, newWitnessGroup } from "webtessera";
import { importLogKey, openServerLog, parseReceipt, type ServerLog, verifyReceipt } from "webtessera/server";
import { fromSqliteSync, type SqlDatabase } from "webtessera/storage/sqlite";
import { newSignerForCosignatureV1, newWitnessServer, vKeyToCosignatureV1 } from "webtessera/witness";
import type { FetchFn } from "../client/fetcher.ts";
import { newVerifiedMirror } from "../mirror/verify.ts";
import { generateLogKey } from "../safe/keys.ts";
import { ServerOnlyMessage } from "../safe/runtime.ts";
import { MemoryObjectStore } from "../storage/memory/memory.ts";
import { generateKey, newSigner } from "../vendor/note/note.ts";

const enc = new TextEncoder();
const dirs: string[] = [];

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
			// esbuild is a dependency of vitest's Vite, so it is in pnpm's store but not
			// importable by name from here.
			const store = new URL("../../node_modules/.pnpm/", import.meta.url).pathname;
			const dirName = readdirSync(store).find((d) => d.startsWith("esbuild@"));
			const esbuild = createRequire(`${store}${dirName}/node_modules/esbuild/`)("esbuild") as {
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

	it("locks SQLite with leases unless told the process is the only writer", async () => {
		const lease = recording(fromSqliteSync(new DatabaseSync(":memory:")));
		const a = await openServerLog({ key: await generateLogKey("example.com/log"), storage: { sqlite: lease.db } });
		await a.append(enc.encode("x"));
		await a.close();
		expect(lease.sql.some((s) => s.includes("INTO webtessera_locks"))).toBe(true);

		const local = recording(fromSqliteSync(new DatabaseSync(":memory:")));
		const b = await openServerLog({
			key: await generateLogKey("example.com/log"),
			storage: { sqlite: local.db, locking: "local" },
		});
		await b.append(enc.encode("x"));
		await b.close();
		expect(local.sql.some((s) => s.includes("INTO webtessera_locks"))).toBe(false);
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
					/durably sequenced at index 0, but no checkpoint covering it was published within 1500 ms\. If the log has witnesses, check that they are reachable; call prove\(0n\)/,
				);
				const ac = new AbortController();
				const pending = log.append(enc.encode("y"), { signal: ac.signal });
				ac.abort(new Error("user went away"));
				await expect(pending).rejects.toThrow("user went away");
			} finally {
				await log.close(AbortSignal.timeout(300)).catch(() => {});
			}
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
