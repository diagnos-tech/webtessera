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
// A log that can be told to misbehave, for the monitor's tests and smoke script. It keeps two
// histories signed by the same key, which is exactly what a compromised or dishonest log
// operator can produce: an honest one, and a fork that shares a prefix with it and then
// diverges. It serves either over the tlog-tiles API, or pins its checkpoint to an older one.

import type { FetchFn } from "webtessera/client";
import { generateKey } from "webtessera/note";
import { importLogKey, openServerLog, type ServerLog } from "webtessera/server";

/** ForkingLog is a fake log server whose behaviour the test chooses. */
export interface ForkingLog {
	readonly vkey: string;
	/** fetch serves the chosen history, as an HTTP server would. */
	readonly fetch: FetchFn;
	/** append adds entries to both histories: the prefix they share. */
	append(...entries: string[]): Promise<void>;
	appendHonest(...entries: string[]): Promise<void>;
	appendForked(...entries: string[]): Promise<void>;
	/** serve chooses the history to serve from now on. */
	serve(history: "honest" | "forked"): void;
	/** pinCheckpoint serves this checkpoint instead of the latest one: a rollback. */
	pinCheckpoint(checkpoint: Uint8Array | undefined): void;
	/** checkpoint returns the honest history's latest checkpoint. */
	checkpoint(): Promise<Uint8Array>;
	close(): Promise<void>;
}

/** newForkingLog opens both histories in memory, signed by one fresh key with the given origin. */
export async function newForkingLog(origin = "log.test/forking"): Promise<ForkingLog> {
	const { skey, vkey } = generateKey(undefined, origin);
	const open = async (): Promise<ServerLog> =>
		openServerLog({ key: await importLogKey(skey), storage: { memory: true }, checkpointIntervalMs: 100 });
	const honest = await open();
	const forked = await open();
	let current = honest;
	let pinned: Uint8Array | undefined;
	const enc = new TextEncoder();
	const add = (log: ServerLog, entries: string[]) => Promise.all(entries.map((e) => log.append(enc.encode(e))));

	return {
		vkey,
		fetch: async (input, init) => {
			const request = new Request(input, init);
			if (pinned !== undefined && new URL(request.url).pathname === "/checkpoint") {
				return new Response(pinned.slice());
			}
			return (await current.handler(request)) ?? new Response("not found\n", { status: 404 });
		},
		append: async (...entries) => {
			// One at a time, so that both histories hold the shared entries in the same order.
			for (const e of entries) {
				await add(honest, [e]);
				await add(forked, [e]);
			}
		},
		appendHonest: async (...entries) => {
			await add(honest, entries);
		},
		appendForked: async (...entries) => {
			await add(forked, entries);
		},
		serve: (history) => {
			current = history === "honest" ? honest : forked;
		},
		pinCheckpoint: (checkpoint) => {
			pinned = checkpoint;
		},
		checkpoint: async () => (await honest.latestCheckpoint()).signed,
		close: async () => {
			await honest.close();
			await forked.close();
		},
	};
}
