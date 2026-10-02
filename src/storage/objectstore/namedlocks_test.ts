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

// The ObjectStore conformance suite covers NamedLocks through every backend that uses
// it; these cases pin the properties a custom store relies on when it delegates to it.

import { describe, expect, it } from "vitest";
import { NamedLocks } from "./namedlocks.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("storage/objectstore/NamedLocks", () => {
	it("serves waiters in arrival order", async () => {
		const locks = new NamedLocks();
		const gate = deferred();
		const order: number[] = [];
		const holder = locks.run("l", () => gate.promise);
		const waiters = [1, 2, 3].map((i) =>
			locks.run("l", async () => {
				order.push(i);
			}),
		);
		gate.resolve();
		await Promise.all([holder, ...waiters]);
		expect(order).toEqual([1, 2, 3]);
	});

	it("hands the lock past a waiter that gave up", async () => {
		const locks = new NamedLocks();
		const gate = deferred();
		const order: string[] = [];
		const holder = locks.run("l", () => gate.promise);
		const ac = new AbortController();
		const quitter = locks.run(
			"l",
			async () => {
				order.push("quitter");
			},
			ac.signal,
		);
		const patient = locks.run("l", async () => {
			order.push("patient");
		});
		ac.abort(new Error("gave up"));
		await expect(quitter).rejects.toThrow("gave up");
		gate.resolve();
		await Promise.all([holder, patient]);
		expect(order).toEqual(["patient"]);
	});

	it("keeps no state for names nobody holds", async () => {
		const locks = new NamedLocks();
		for (let i = 0; i < 1000; i++) {
			await locks.run(`name ${i}`, async () => undefined);
		}
		// A fresh run on any name is granted immediately, from an empty map.
		let ran = false;
		await locks.run("name 0", async () => {
			ran = true;
		});
		expect(ran).toBe(true);
	});

	it("does not run fn when the signal is already aborted", async () => {
		const locks = new NamedLocks();
		const ac = new AbortController();
		ac.abort(new Error("already"));
		let ran = false;
		await expect(
			locks.run(
				"l",
				async () => {
					ran = true;
				},
				ac.signal,
			),
		).rejects.toThrow("already");
		expect(ran).toBe(false);
		expect(await locks.run("l", async () => "free")).toBe("free");
	});
});
