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
// Records the browser's exchanges with the server in the session's log: every call to the
// application goes through recordedFetch, which appends a record of the request and the answer
// and hands back the receipt, cosigned by the server.

import type { Receipt } from "webtessera/browser";
import { bodyDigest, encodeInteraction, type Interaction } from "../../shared/interaction.ts";
import type { Session } from "./session.ts";

/** Recorded is one exchange with the server, and the receipt that it was recorded. */
export interface Recorded {
	readonly status: number;
	readonly body: string;
	readonly interaction: Interaction;
	/** receipt proves offline that the interaction is in the log, as the server cosigned it. */
	readonly receipt: Receipt;
}

/** recordedFetch calls the server's application as the session, and records the exchange. */
export async function recordedFetch(
	session: Session,
	path: string,
	init: { readonly method: string; readonly body?: string },
): Promise<Recorded> {
	const requestBody = new TextEncoder().encode(init.body ?? "");
	const res = await session.fetch(new URL(path, session.server).href, {
		method: init.method,
		...(init.body === undefined ? {} : { body: init.body }),
		headers: { Authorization: `Bearer ${session.token}`, "Session-Origin": session.origin },
	});
	const responseBody = new Uint8Array(await res.arrayBuffer());
	const interaction: Interaction = {
		at: new Date().toISOString(),
		method: init.method,
		path,
		status: res.status,
		request: await bodyDigest(requestBody),
		response: await bodyDigest(responseBody),
	};
	// Resolves once a checkpoint covering the record is published, which means once the server
	// has cosigned it: the receipt cannot exist without the server's agreement.
	const receipt = await session.log.append(encodeInteraction(interaction));
	return { status: res.status, body: new TextDecoder().decode(responseBody), interaction, receipt };
}
