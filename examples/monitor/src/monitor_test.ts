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
// Points the monitor at a deliberately misbehaving log (testing/forking_log.ts) and checks that
// it follows honest growth quietly, and reports every way the log can lie: a fork of the same
// size, a fork that grew past what was verified, a fork made while the monitor was down, a
// rollback, and a checkpoint signed by someone else.

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Monitor, type MonitorEvent, openMonitor } from "./monitor.ts";
import { newFileStateStore, newMemoryStateStore, type StateStore } from "./state.ts";
import { type ForkingLog, newForkingLog } from "./testing/forking_log.ts";

let log: ForkingLog;
beforeEach(async () => {
	log = await newForkingLog();
});
afterEach(() => log.close());

function watch(state: StateStore, target: ForkingLog = log): Promise<Monitor> {
	return openMonitor({ url: new URL("http://log.test/"), vkey: target.vkey, state, fetch: target.fetch });
}

function kind(event: MonitorEvent): string {
	return event.kind;
}

describe("monitor", () => {
	it("follows a growing log, proving each new checkpoint consistent with the last, and saves it", async () => {
		await log.append("a");
		const state = newMemoryStateStore();
		const monitor = await watch(state);
		expect(monitor.started).toEqual({ size: 1n, resumed: false });

		await log.append("b", "c");
		expect(await monitor.check()).toEqual({ kind: "grew", from: 1n, to: 3n });
		expect(await state.load()).toEqual(await log.checkpoint());
		expect(await monitor.check()).toEqual({ kind: "unchanged", size: 3n });
	});

	it("resumes from its saved checkpoint after a restart", async () => {
		await log.append("a", "b");
		const state = newMemoryStateStore();
		await watch(state);

		await log.append("c");
		const restarted = await watch(state);
		expect(restarted.started).toEqual({ size: 2n, resumed: true });
		expect(await restarted.check()).toEqual({ kind: "grew", from: 2n, to: 3n });
	});

	it("reports a fork that shows a different tree of the same size, and keeps the evidence", async () => {
		await log.append("a");
		await log.appendHonest("b");
		await log.appendForked("x");
		const state = newMemoryStateStore();
		const monitor = await watch(state);
		const verified = await state.load();

		log.serve("forked");
		const event = await monitor.check();
		expect(kind(event)).toBe("fork");
		const [evidence] = [...state.evidence.values()];
		expect(evidence).toContain(new TextDecoder().decode(verified));
		expect(evidence).toContain("## checkpoint 2");

		// The verified checkpoint is kept, so the fork is reported on every check, not adopted.
		expect(await state.load()).toEqual(verified);
		expect(kind(await monitor.check())).toBe("fork");
	});

	it("reports a fork that grew past the tree it verified", async () => {
		await log.append("a");
		await log.appendHonest("b");
		await log.appendForked("x", "y", "z");
		const monitor = await watch(newMemoryStateStore());

		log.serve("forked");
		expect(kind(await monitor.check())).toBe("fork");
	});

	it("reports a fork made while it was down", async () => {
		await log.append("a");
		await log.appendHonest("b");
		await log.appendForked("x", "y");
		const state = newMemoryStateStore();
		await watch(state);

		log.serve("forked");
		const restarted = await watch(state);
		expect(kind(await restarted.check())).toBe("fork");
	});

	it("reports a log that shrank below what it verified while it was down", async () => {
		await log.append("a");
		await log.appendHonest("b", "c", "d");
		await log.appendForked("x");
		const state = newMemoryStateStore();
		await watch(state);

		// The forked history is shorter: the log can no longer prove anything about the tree the
		// monitor verified, and serving an older checkpoint is a rollback whatever the reason.
		log.serve("forked");
		const restarted = await watch(state);
		expect(await restarted.check()).toEqual({ kind: "rollback", verified: 4n, served: 2n });
	});

	it("reports a rollback to an older checkpoint, and keeps the newer one", async () => {
		await log.append("a");
		const old = await log.checkpoint();
		const state = newMemoryStateStore();
		const monitor = await watch(state);
		await log.append("b", "c");
		expect(kind(await monitor.check())).toBe("grew");

		log.pinCheckpoint(old);
		expect(await monitor.check()).toEqual({ kind: "rollback", verified: 3n, served: 1n });
		expect(await state.load()).toEqual(await log.checkpoint());
	});

	it("does not trust a checkpoint signed by another key", async () => {
		await log.append("a");
		const state = newMemoryStateStore();
		const monitor = await watch(state);
		const impostor = await newForkingLog();
		try {
			await impostor.append("a", "b");
			log.pinCheckpoint(await impostor.checkpoint());
			const event = await monitor.check();
			expect(kind(event)).toBe("error");
			expect(await state.load()).not.toEqual(await impostor.checkpoint());
		} finally {
			await impostor.close();
		}
	});
});

describe("file state store", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "monitor-state-"));
	});
	afterEach(() => rm(dir, { recursive: true, force: true }));

	it("keeps the checkpoint and the evidence across reopening, with no temporary file left", async () => {
		await log.append("a");
		await log.appendHonest("b");
		await log.appendForked("x");
		await watch(newFileStateStore(dir));
		expect(new Uint8Array(await readFile(join(dir, "checkpoint")))).toEqual(await log.checkpoint());
		expect(await readdir(dir)).toEqual(["checkpoint"]);

		log.serve("forked");
		const event = await (await watch(newFileStateStore(dir))).check();
		expect(event.kind).toBe("fork");
		expect(await readdir(join(dir, "evidence"))).toHaveLength(1);
	});
});
