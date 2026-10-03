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
// Wires the server and browser sessions together in one process for the tests: the server's
// fetch handler stands in for the network, and each browser session is the client's own code
// (client/src/session.ts) with an in-memory log, signed by an ephemeral key, in place of
// IndexedDB and a device key.

import { generateLogKey, type LogKey } from "webtessera/browser";
import type { FetchFn } from "webtessera/client";
import type { Sink } from "webtessera/mirror";
import { generateKey } from "webtessera/note";
import { MemoryObjectStore } from "webtessera/storage/memory";
import type { InconsistencyEvidence } from "webtessera/witness";
import { openSession, registerSession, type Session } from "../client/src/session.ts";
import { newSessionServer, type SessionServer, type SessionServerStores } from "../server/app.ts";
import { newSessionOrigin } from "../shared/protocol.ts";

/** Harness is a server and the means to open browser sessions against it. */
export interface Harness {
	readonly server: SessionServer;
	readonly stores: SessionServerStores;
	readonly sink: Sink;
	readonly witnessVkey: string;
	/** evidence holds every rewrite the witness refused. */
	readonly evidence: InconsistencyEvidence[];
	/** fetch reaches the server, as a browser's fetch would. */
	readonly fetch: FetchFn;
	readonly url: URL;
	/** newSession registers and opens a session, as the page does on first load. */
	newSession(): Promise<TestSession>;
}

/** TestSession is a session, with the key its log is signed with. */
export interface TestSession extends Session {
	readonly key: LogKey;
}

export function newHarness(sink: Sink = new MemoryObjectStore()): Harness {
	const { skey, vkey } = generateKey(undefined, "witness.test/w1");
	const stores = {
		registry: new MemoryObjectStore(),
		witness: new MemoryObjectStore(),
		staging: new MemoryObjectStore(),
	};
	const evidence: InconsistencyEvidence[] = [];
	const server = newSessionServer({
		witnessKey: skey,
		witnessVkey: vkey,
		stores,
		sink,
		onInconsistency: (e) => evidence.push(e),
	});
	const fetch: FetchFn = (input, init) => server.fetch(new Request(input, init));
	// A loopback URL: a witness URL must be https, or http on loopback.
	const url = new URL("http://127.0.0.1:8787/");
	return {
		server,
		stores,
		sink,
		witnessVkey: vkey,
		evidence,
		fetch,
		url,
		async newSession() {
			const key = await generateLogKey(newSessionOrigin(url.host));
			const info = await registerSession({ server: url, key, fetch });
			return { ...(await openSession(info, { server: url, key, storage: { memory: true }, fetch })), key };
		},
	};
}
