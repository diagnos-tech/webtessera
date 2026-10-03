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

// Test-only helpers shared by the http, witness and mirror suites: a real log, written by the
// real appender into memory, so that what those suites serve, witness and copy is exactly what
// a deployment would. Not part of the published build (tsconfig.build.json excludes testing/).

import { type AppendOptions, newAppender, newAppendOptions } from "../../append_lifecycle.ts";
import { newPublicationAwaiter } from "../../await.ts";
import type { FetchFn } from "../../client/fetcher.ts";
import { newEntry } from "../../entry.ts";
import type { LogReader } from "../../lifecycle.ts";
import { MemoryObjectStore, newMemoryDriver } from "../../storage/memory/memory.ts";
import { generateKey, newSigner, newVerifier, type Signer, type Verifier } from "../../vendor/note/note.ts";

/** TestLog is a running log held in memory. */
export interface TestLog {
	readonly origin: string;
	readonly signer: Signer;
	readonly verifier: Verifier;
	/** skey and vkey are the log's signer and verifier keys. */
	readonly skey: string;
	readonly vkey: string;
	readonly store: MemoryObjectStore;
	readonly reader: LogReader;
	/** add appends entries and resolves once a published checkpoint commits to all of them. */
	add(entries: readonly Uint8Array[]): Promise<void>;
	/** shutdown stops the appender. */
	shutdown(): Promise<void>;
}

/** TestLogOptions configures newTestLog. */
export interface TestLogOptions {
	readonly origin?: string;
	/** fetch receives the appender's outgoing requests (to witnesses). */
	readonly fetch?: FetchFn;
	/** configure may add options (witnesses, say) on top of the fast defaults. */
	readonly configure?: (opts: AppendOptions) => AppendOptions;
	/** keys replaces the freshly generated log key pair, to restart a log with the same key. */
	readonly keys?: { readonly skey: string; readonly vkey: string };
	readonly store?: MemoryObjectStore;
}

/** newTestLog starts a log whose appender batches and publishes every few milliseconds. */
export async function newTestLog(options: TestLogOptions = {}): Promise<TestLog> {
	const origin = options.origin ?? "example.com/test-log";
	const { skey, vkey } = options.keys ?? generateKey(undefined, origin);
	const signer = newSigner(skey);
	const store = options.store ?? new MemoryObjectStore();
	const driver = newMemoryDriver(options.fetch === undefined ? { store } : { store, fetch: options.fetch });
	let opts = newAppendOptions().withCheckpointSigner(signer).withBatching(256, 5).withCheckpointInterval(100);
	if (options.configure !== undefined) {
		opts = options.configure(opts);
	}
	const ac = new AbortController();
	const { appender, shutdown, reader } = await newAppender(driver, opts, ac.signal);
	const awaiter = newPublicationAwaiter((s) => reader.readCheckpoint(s), 10, ac.signal);
	return {
		origin,
		signer,
		verifier: newVerifier(vkey),
		skey,
		vkey,
		store,
		reader,
		async add(entries: readonly Uint8Array[]): Promise<void> {
			await Promise.all(entries.map((e) => awaiter.await(appender.add(newEntry(e)))));
		},
		async shutdown(): Promise<void> {
			await shutdown();
			ac.abort();
		},
	};
}

/** entriesOf returns n distinct entries, starting with "entry <from>". */
export function entriesOf(n: number, from = 0): Uint8Array[] {
	return Array.from({ length: n }, (_, i) => new TextEncoder().encode(`entry ${from + i}`));
}

/**
 * fetchVia returns a FetchFn that answers every request with handler, as though it were
 * the server at the other end of the network, and 404 when the handler owns nothing.
 */
export function fetchVia(handler: (request: Request) => Promise<Response | undefined>): FetchFn {
	return async (input: string, init?: RequestInit): Promise<Response> =>
		(await handler(new Request(input, init))) ?? new Response("not found\n", { status: 404 });
}
