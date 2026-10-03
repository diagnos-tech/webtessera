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

import type { R2Bucket } from "@cloudflare/workers-types/index.ts";
import { describe, expect, it } from "vitest";
import { newSinkTarget, type Sink } from "webtessera/mirror";
import { ErrNotExist, errorIs } from "../internal/gostd/errors.ts";
import { MemoryObjectStore } from "../storage/memory/memory.ts";
import type { ObjectStore } from "../storage/objectstore/objectstore.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("Sink", () => {
	it("is satisfied by ObjectStores and Cloudflare R2 bindings as they are", () => {
		// Compile-time checks: the typecheck is the test, and these conversions need no adapter.
		const fromObjectStore = (s: ObjectStore): Sink => s;
		const fromR2 = (b: R2Bucket): Sink => b;
		expect([fromObjectStore, fromR2]).toHaveLength(2);
	});
});

describe("newSinkTarget", () => {
	it("writes each resource under its tlog-tiles path, after the prefix", async () => {
		const store = new MemoryObjectStore();
		const t = newSinkTarget(store, { prefix: "logs/x/" });
		await t.writeTile(1n, 1234067n, 0, enc("t"));
		await t.writeEntryBundle(5n, 7, enc("b"));
		await t.writeCheckpoint(enc("c"));
		expect(store.keys()).toEqual(["logs/x/checkpoint", "logs/x/tile/1/x001/x234/067", "logs/x/tile/entries/005.p/7"]);
	});

	it("reads back bytes, ArrayBuffers and bodies, and reports absence as ErrNotExist", async () => {
		const objects: Record<string, unknown> = {
			checkpoint: enc("cp"),
			"tile/0/000": enc("tile").buffer,
			"tile/entries/000": new Response(enc("bundle") as BodyInit),
		};
		const sink: Sink = {
			put: async () => undefined,
			get: async (k) => (objects[k] as Uint8Array | undefined) ?? null,
		};
		const t = newSinkTarget(sink);
		expect(await t.readCheckpoint()).toEqual(enc("cp"));
		expect(await t.readTile(0n, 0n, 0)).toEqual(enc("tile"));
		expect(await t.readEntryBundle(0n, 0)).toEqual(enc("bundle"));
		// A missing partial falls back to the full resource, as fetchers do.
		expect(await t.readTile(0n, 0n, 9)).toEqual(enc("tile"));
		const err = await t.readTile(0n, 1n, 0).catch((e: unknown) => e);
		expect(errorIs(err, ErrNotExist)).toBe(true);
		const writeOnly = newSinkTarget({ put: async () => undefined });
		expect(errorIs(await writeOnly.readCheckpoint().catch((e: unknown) => e), ErrNotExist)).toBe(true);
	});
});
