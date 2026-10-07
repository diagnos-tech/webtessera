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

// Tests, in real Chromium, that webtessera/server refuses to run in a browser: the module
// the `browser` export condition selects fails at import, the real entry point fails its
// runtime check at import in a window and in a worker, and each key-holding function
// checks again for a bundler that skipped the entry module.

import { describe, expect, it } from "vitest";
import { detectRuntime, ServerOnlyMessage } from "../safe/runtime.ts";
import type { RealmReply, RealmRequest } from "../safe/testing/realm_worker.ts";
import { generateKey } from "../vendor/note/note.ts";

function askWorker(req: RealmRequest): Promise<RealmReply> {
	const worker = new Worker(new URL("../safe/testing/realm_worker.ts", import.meta.url), { type: "module" });
	return new Promise<RealmReply>((resolve, reject) => {
		worker.onmessage = (e: MessageEvent<RealmReply>) => {
			worker.terminate();
			resolve(e.data);
		};
		worker.onerror = (e) => {
			worker.terminate();
			reject(new Error(e.message));
		};
		worker.postMessage(req);
	});
}

describe("webtessera/server in a browser", () => {
	it("detects a browser window", () => {
		expect(detectRuntime()).toBe("browser");
	});

	it("resolves, under the browser condition, to a module that throws at import", async () => {
		await expect(import("./NOT-FOR-BROWSERS--use-webtessera-browser.ts")).rejects.toThrow(ServerOnlyMessage);
	});

	it("refuses to load in a window", async () => {
		await expect(import("./index.ts")).rejects.toThrow(/holds signing keys .*running in a browser window/);
	});

	it("refuses to load in a worker, which it detects as a browser worker", async () => {
		const reply = await askWorker({ type: "runtime" });
		expect(reply.type).toBe("runtime");
		if (reply.type === "runtime") {
			expect(reply.kind).toBe("browser-worker");
			expect(reply.serverImportError).toMatch(/holds signing keys .*running in a browser worker/);
		}
	});

	it("checks again in each function that takes a key, for bundles that skip the entry module", async () => {
		const { importLogKey } = await import("./keys.ts");
		const { openServerLog } = await import("./log.ts");
		const { skey } = generateKey(undefined, "example.com/log");
		const err = (await importLogKey(skey).catch((e: unknown) => e)) as Error;
		expect(err.message).toContain(ServerOnlyMessage);
		expect(err.message).not.toContain(skey.slice(-20));
		await expect(openServerLog({ key: undefined as never, storage: { memory: true } })).rejects.toThrow(
			ServerOnlyMessage,
		);
	});
});
