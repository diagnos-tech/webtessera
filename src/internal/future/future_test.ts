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
// There is no future_test.go upstream. These tests pin the contract queue.ts (and
// eventually the client work package) depends on: get() blocks until set() is called,
// the first set() wins, and an error passed to set() is thrown rather than returned.

import { describe, expect, it } from "vitest";
import { newFutureErr } from "./future.ts";

describe("internal/future/FutureErr", () => {
	it("blocks get() until set() is called", async () => {
		const [f, set] = newFutureErr<number>();
		let resolved = false;
		const p = f.get().then((v) => {
			resolved = true;
			return v;
		});
		// Give any (incorrect) premature resolution a chance to happen.
		await Promise.resolve();
		await Promise.resolve();
		expect(resolved).toBe(false);

		set(42, undefined);
		expect(await p).toBe(42);
		expect(resolved).toBe(true);
	});

	it("throws the error passed to set() instead of returning it", async () => {
		const [f, set] = newFutureErr<number>();
		set(0, new Error("boom"));
		await expect(f.get()).rejects.toThrow("boom");
	});

	it("resolves immediately for a future already set before get() is called", async () => {
		const [f, set] = newFutureErr<string>();
		set("value", undefined);
		expect(await f.get()).toBe("value");
	});

	it("lets every caller of get() observe the same resolution", async () => {
		const [f, set] = newFutureErr<number>();
		const p1 = f.get();
		const p2 = f.get();
		set(7, undefined);
		expect(await p1).toBe(7);
		expect(await p2).toBe(7);
	});

	it("keeps the first set() and ignores later calls, mirroring sync.Once", async () => {
		const [f, set] = newFutureErr<number>();
		set(1, undefined);
		set(2, undefined);
		set(0, new Error("should be ignored"));
		expect(await f.get()).toBe(1);
	});

	it("keeps the first set() even when the first call is an error", async () => {
		const [f, set] = newFutureErr<number>();
		set(0, new Error("first"));
		set(99, undefined);
		await expect(f.get()).rejects.toThrow("first");
	});
});
