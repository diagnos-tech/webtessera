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
// Drives the log server through its fetch handler, as HTTP clients would, on temporary SQLite
// files opened with node:sqlite, and checks what it serves with the same client code a user
// runs (client.ts). The guardrails covered: several writers on one file, under the lease locking
// a file gets by default, make one log; a client notices a log that rewrote its history; and a
// database refuses a key that did not create its log.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKey } from "webtessera/note";
import { verifyLog } from "./client.ts";
import { newLogServer } from "./log_server.ts";
import { node } from "./runtime/node.ts";
import { openPublicLog } from "./server.ts";

const base = "http://log.test/";
const enc = new TextEncoder();
const { skey, vkey } = generateKey(undefined, "example.com/test-log");

let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "log-server-test-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** A server is one process's view of the log: its own connection, its own log, its own handler. */
interface server {
	readonly serve: (request: Request) => Promise<Response>;
	readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
	close(): Promise<void>;
}

/** open opens the log in file, with the adapter's default locking: leases, for a file. */
async function open(file: string, key = skey): Promise<server> {
	const db = node.openSqlite(join(dir, file));
	const log = await openPublicLog(db.database, { logKey: key });
	const serve = newLogServer(log);
	return {
		serve,
		fetch: (input, init) => serve(new Request(new URL(input, base), init)),
		close: async () => {
			await log.close();
			db.close();
		},
	};
}

async function add(s: server, entry: string): Promise<bigint> {
	const res = await s.fetch("/add", { method: "POST", body: entry });
	const body = await res.text();
	expect(res.status, body).toBe(200);
	expect(body).toMatch(/^(0|[1-9][0-9]*)$/);
	return BigInt(body);
}

describe("log server", () => {
	it("makes one log of two processes appending to one SQLite file, under the leases a file gets by default", async () => {
		const a = await open("shared.db");
		const b = await open("shared.db");
		try {
			const entries = Array.from({ length: 24 }, (_, i) => `entry ${i}`);
			const indices = await Promise.all(entries.map((e, i) => add(i % 2 === 0 ? a : b, e)));
			// No index was handed out twice, and none was skipped.
			expect([...indices].sort((x, y) => Number(x - y))).toEqual(entries.map((_, i) => BigInt(i)));
			// Each entry is where its writer was told it is, proven against the signed checkpoint.
			for (const [i, entry] of entries.entries()) {
				await verifyLog({
					url: new URL(base),
					vkey,
					index: indices[i] as bigint,
					entry: enc.encode(entry),
					fetch: a.fetch,
				});
			}
		} finally {
			await a.close();
			await b.close();
		}
	});

	it("serves the tlog-tiles read API with the spec's headers", async () => {
		const s = await open("read-api.db");
		try {
			await add(s, "hello");
			const checkpoint = await s.fetch("/checkpoint");
			expect(checkpoint.status).toBe(200);
			expect(checkpoint.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
			expect(checkpoint.headers.get("Access-Control-Allow-Origin")).toBe("*");
			expect((await checkpoint.text()).split("\n")[0]).toBe("example.com/test-log");

			const cases: [string, RequestInit, number][] = [
				["/tile/0/000.p/1", {}, 200],
				["/tile/entries/000.p/1", {}, 200],
				["/tile/0/x999/999", {}, 404],
				["/tile/0/abc", {}, 400],
				["/checkpoint", { method: "HEAD" }, 200],
				["/add", {}, 405],
				["/add", { method: "POST", body: new Uint8Array(0x10000) }, 413],
				["/nothing-here", {}, 404],
			];
			for (const [path, init, status] of cases) {
				const res = await s.fetch(path, init);
				expect(res.status, `${init.method ?? "GET"} ${path}`).toBe(status);
				await res.body?.cancel();
			}
		} finally {
			await s.close();
		}
	});

	it("lets a client notice a log that rewrote its history", async () => {
		const honest = await open("honest.db");
		const rewritten = await open("rewritten.db");
		try {
			await add(honest, "the original first entry");
			const seen = await verifyLog({ url: new URL(base), vkey, fetch: honest.fetch });

			// Same key, same URL, different history: what a compromised server would serve.
			await add(rewritten, "a replacement first entry");
			await add(rewritten, "and a second one");
			await expect(
				verifyLog({ url: new URL(base), vkey, previous: seen.checkpoint, fetch: rewritten.fetch }),
			).rejects.toThrow();

			// The honest log, grown, still proves that it only grew.
			await add(honest, "a second entry");
			const grown = await verifyLog({ url: new URL(base), vkey, previous: seen.checkpoint, fetch: honest.fetch });
			expect(grown.size).toBe(2n);
		} finally {
			await honest.close();
			await rewritten.close();
		}
	});

	it("refuses to open a database whose log another key created", async () => {
		const s = await open("owned.db");
		await add(s, "signed by the first key");
		await s.close();
		const other = generateKey(undefined, "example.com/test-log").skey;
		await expect(open("owned.db", other)).rejects.toThrow(/not created with this key/);
	});
});
