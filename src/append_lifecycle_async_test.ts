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

// Tests for AppendOptions.withCheckpointAsyncSigner, which has no upstream counterpart: it
// must publish exactly the checkpoints withCheckpointSigner publishes for the same keys.
// See docs/decisions/0223-async-signers-for-notes-and-checkpoints.md. The Go fixtures are
// replayed through it with WebCrypto keys by src/safe/testing/golden.ts.

import { describe, expect, it } from "vitest";
import { newAppender, newAppendOptions } from "./append_lifecycle.ts";
import { newPublicationAwaiter } from "./await.ts";
import type { FetchFn } from "./client/fetcher.ts";
import { newEntry } from "./entry.ts";
import { bytesEqual, fromUTF8 } from "./internal/gostd/bytes.ts";
import { ErrNotExist } from "./internal/gostd/errors.ts";
import type { LogReader } from "./lifecycle.ts";
import { newMemoryDriver } from "./storage/memory/memory.ts";
import { parseCheckpoint } from "./vendor/formats/log/index.ts";
import { DefaultHasher } from "./vendor/merkle/rfc6962/rfc6962.ts";
import { type AsyncSigner, generateKey, newSigner, newVerifier, type Signer } from "./vendor/note/note.ts";

const reader: LogReader = {
	readCheckpoint: async (): Promise<Uint8Array> => {
		throw ErrNotExist;
	},
	readTile: async (): Promise<Uint8Array> => {
		throw ErrNotExist;
	},
	readEntryBundle: async (): Promise<Uint8Array> => {
		throw ErrNotExist;
	},
	nextIndex: async (): Promise<bigint> => 0n,
	integratedSize: async (): Promise<bigint> => 0n,
};

const noFetch: FetchFn = async (): Promise<Response> => {
	throw new Error("unexpected request");
};

function asyncOf(s: Signer): AsyncSigner {
	return {
		name: () => s.name(),
		keyHash: () => s.keyHash(),
		sign: async (msg: Uint8Array): Promise<Uint8Array> => s.sign(msg),
	};
}

describe("AppendOptions.withCheckpointAsyncSigner", () => {
	const { skey, vkey } = generateKey(undefined, "example.com/async");
	const signer = newSigner(skey);
	const rotated = newSigner(generateKey(undefined, "example.com/async").skey);
	const root = DefaultHasher.hashLeaf(new Uint8Array([1, 2, 3]));

	it("publishes byte-identical checkpoints to withCheckpointSigner, including the empty tree", async () => {
		const sync = newAppendOptions().withCheckpointSigner(signer, rotated).checkpointPublisher(reader, noFetch);
		const async = newAppendOptions()
			.withCheckpointAsyncSigner(asyncOf(signer), asyncOf(rotated))
			.checkpointPublisher(reader, noFetch);
		for (const size of [0n, 1n, 255n, 256n, 18446744073709551615n]) {
			const want = await sync(size, root);
			const got = await async(size, root);
			expect(bytesEqual(got, want), `size ${size}:\n${fromUTF8(got)}`).toBe(true);
		}
	});

	it("satisfies AppendOptions.valid on its own", () => {
		expect(() => newAppendOptions().withCheckpointAsyncSigner(asyncOf(signer)).valid()).not.toThrow();
	});

	it("refuses additional signers with another name, with withCheckpointSigner's message", () => {
		const other = newSigner(generateKey(undefined, "example.com/other").skey);
		const want =
			'WithCheckpointSigner: additional signer name ("example.com/other") does not match primary signer name ("example.com/async")';
		expect(() => newAppendOptions().withCheckpointSigner(signer, other)).toThrow(want);
		expect(() => newAppendOptions().withCheckpointAsyncSigner(asyncOf(signer), asyncOf(other))).toThrow(want);
	});

	it("reports a signer's rejection as newCP: note.Sign: ..., as the synchronous path reports a throw", async () => {
		const failing: AsyncSigner = { ...asyncOf(signer), sign: () => Promise.reject(new Error("token unplugged")) };
		const throwing: Signer = {
			name: () => signer.name(),
			keyHash: () => signer.keyHash(),
			sign: () => {
				throw new Error("token unplugged");
			},
		};
		await expect(
			newAppendOptions().withCheckpointAsyncSigner(failing).checkpointPublisher(reader, noFetch)(1n, root),
		).rejects.toThrow("newCP: note.Sign: token unplugged");
		await expect(
			newAppendOptions().withCheckpointSigner(throwing).checkpointPublisher(reader, noFetch)(1n, root),
		).rejects.toThrow("newCP: note.Sign: token unplugged");
	});

	it("replaces a signer configured before it, and is replaced by one configured after it", async () => {
		const other = newSigner(generateKey(undefined, "example.com/async").skey);
		const a = await newAppendOptions()
			.withCheckpointSigner(other)
			.withCheckpointAsyncSigner(asyncOf(signer))
			.checkpointPublisher(reader, noFetch)(1n, root);
		const b = await newAppendOptions()
			.withCheckpointAsyncSigner(asyncOf(other))
			.withCheckpointSigner(signer)
			.checkpointPublisher(reader, noFetch)(1n, root);
		expect(bytesEqual(a, b)).toBe(true);
		expect(() => parseCheckpoint(a, "example.com/async", newVerifier(vkey))).not.toThrow();
	});

	it("runs a whole appender, whose published checkpoints verify", async () => {
		const ac = new AbortController();
		const opts = newAppendOptions()
			.withCheckpointAsyncSigner(asyncOf(signer))
			.withBatching(256, 10)
			.withCheckpointInterval(100);
		const { appender, shutdown, reader: r } = await newAppender(newMemoryDriver(), opts, ac.signal);
		const awaiter = newPublicationAwaiter((s) => r.readCheckpoint(s), 20, ac.signal);
		try {
			const [index, cp] = await awaiter.await(appender.add(newEntry(new Uint8Array([7]))));
			expect(index.index).toBe(0n);
			expect(parseCheckpoint(cp, "example.com/async", newVerifier(vkey)).checkpoint.size).toBe(1n);
		} finally {
			await shutdown();
			ac.abort();
		}
	});
});
