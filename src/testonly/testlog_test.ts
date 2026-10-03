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

// Upstream has no testlog_test.go: NewTestLog is exercised only by the packages that
// use it. These tests pin the contract a caller of newTestLog relies on.

import { describe, expect, it } from "vitest";
import { newAppendOptions } from "../append_lifecycle.ts";
import { newPublicationAwaiter } from "../await.ts";
import { newEntry } from "../entry.ts";
import { parseCheckpoint } from "../vendor/formats/log/index.ts";
import { newTestLog } from "./testlog.ts";

describe("testonly/testlog", () => {
	it("appends, publishes a checkpoint signed by sigVerifier, and shuts down", async () => {
		const ac = new AbortController();
		const opts = newAppendOptions().withBatching(256, 10).withCheckpointInterval(100);
		const { testLog, shutdown } = await newTestLog(opts, ac.signal);

		const awaiter = newPublicationAwaiter((s) => testLog.logReader.readCheckpoint(s), 20, ac.signal);
		const [index, cpRaw] = await awaiter.await(testLog.appender.add(newEntry(new Uint8Array([7]))));
		expect(index).toEqual({ index: 0n, isDup: false });
		expect(cpRaw).toBeDefined();

		const v = testLog.sigVerifier;
		const { checkpoint } = parseCheckpoint(cpRaw, v.name(), v);
		expect(checkpoint.size).toBe(1n);
		expect(await testLog.store.get("checkpoint")).toEqual(cpRaw);

		await shutdown();
		ac.abort();
	});

	it("gives each log its own store and key", async () => {
		const ac = new AbortController();
		const a = await newTestLog(newAppendOptions(), ac.signal);
		const b = await newTestLog(newAppendOptions(), ac.signal);
		expect(a.testLog.store).not.toBe(b.testLog.store);
		expect(a.testLog.sigVerifier.keyHash()).not.toBe(b.testLog.sigVerifier.keyHash());
		await Promise.all([a.shutdown(), b.shutdown()]);
		ac.abort();
	});
});
