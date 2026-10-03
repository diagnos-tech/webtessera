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
// The server as witness: it cosigns each checkpoint of a session's log only after checking that
// it extends the last one it cosigned for that log. A browser that wipes its log, or rewrites
// any entry it already got cosigned, can never get a cosignature again: the history the server
// cosigned is the only one that can continue.

import {
	type InconsistencyEvidence,
	newSignerForCosignatureV1,
	newWitnessServer,
	type WitnessServer,
	type WitnessStore,
} from "webtessera/witness";
import { Routes } from "../shared/protocol.ts";
import type { Sessions } from "./sessions.ts";

/** SessionWitnessOptions configures newSessionWitness. */
export interface SessionWitnessOptions {
	/** witnessKey is the witness's private note key, `PRIVATE+KEY+<name>+...`. */
	readonly witnessKey: string;
	/** store keeps the latest cosigned checkpoint of every session; its lock makes each check atomic. */
	readonly store: WitnessStore;
	readonly sessions: Sessions;
	/** onInconsistency is told about every validly signed checkpoint refused as a rewrite. */
	readonly onInconsistency?: (evidence: InconsistencyEvidence) => void;
}

export function newSessionWitness(options: SessionWitnessOptions): WitnessServer {
	return newWitnessServer({
		signer: newSignerForCosignatureV1(options.witnessKey),
		store: options.store,
		keyPrefix: "witness/",
		// Sessions come and go, so the witness asks the registry about each origin rather than
		// being configured with a fixed list of logs. A busy server would put a small cache of
		// recent answers in front of the registry, as the lookupLog documentation suggests.
		lookupLog: async (origin) => {
			const session = await options.sessions.byOrigin(origin);
			return session === undefined ? undefined : { verifierKeys: [session.vkey] };
		},
		prefix: Routes.witness,
		...(options.onInconsistency === undefined ? {} : { onInconsistency: options.onInconsistency }),
	});
}
