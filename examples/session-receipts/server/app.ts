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
// The whole server as one fetch handler: session registration, the witness, log uploads and
// commits, and the application under audit. Runtime-neutral: main.ts serves it on Node, Bun or
// Deno, and the tests call it directly.

import { combineHandlers } from "webtessera/http";
import type { Sink } from "webtessera/mirror";
import type { ObjectStore } from "webtessera/storage/objectstore";
import type { InconsistencyEvidence, WitnessServer } from "webtessera/witness";
import { type Committer, newCommitter } from "./committer.ts";
import { newNotesHandler } from "./notes.ts";
import { newRegistrationHandler, Sessions } from "./sessions.ts";
import { newUploadHandler } from "./uploads.ts";
import { newSessionWitness } from "./witness.ts";

/** SessionServerStores are the server's durable state, one ObjectStore per concern. */
export interface SessionServerStores {
	readonly registry: ObjectStore;
	readonly witness: ObjectStore;
	readonly staging: ObjectStore;
}

/** SessionServerOptions configures newSessionServer. */
export interface SessionServerOptions {
	/** witnessKey is the witness's private note key; witnessVkey its public half, for browsers. */
	readonly witnessKey: string;
	readonly witnessVkey: string;
	readonly stores: SessionServerStores;
	/** sink is where witnessed logs are committed: an S3 bucket, or an ObjectStore (sink.ts). */
	readonly sink: Sink;
	readonly onError?: (err: unknown) => void;
	readonly onInconsistency?: (evidence: InconsistencyEvidence) => void;
}

/** SessionServer is the running server's parts, for main.ts and the tests. */
export interface SessionServer {
	readonly fetch: (request: Request) => Promise<Response>;
	readonly sessions: Sessions;
	readonly witness: WitnessServer;
	readonly committer: Committer;
}

export function newSessionServer(options: SessionServerOptions): SessionServer {
	const sessions = new Sessions(options.stores.registry);
	const witness = newSessionWitness({
		witnessKey: options.witnessKey,
		store: options.stores.witness,
		sessions,
		...(options.onInconsistency === undefined ? {} : { onInconsistency: options.onInconsistency }),
	});
	const committer = newCommitter({ witness, staging: options.stores.staging, sink: options.sink });
	const fetch = combineHandlers(
		newRegistrationHandler(sessions, options.witnessVkey),
		witness.handle,
		newUploadHandler({
			sessions,
			staging: options.stores.staging,
			committer,
			...(options.onError === undefined ? {} : { onError: options.onError }),
		}),
		newNotesHandler(sessions),
	);
	return { fetch, sessions, witness, committer };
}
