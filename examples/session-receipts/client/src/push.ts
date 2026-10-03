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
// Uploads the session's log to the server, which commits it once it has verified it. The copy is
// made by webtessera/mirror's Mirror (the port of Tessera's) into a sink whose writes are HTTP
// PUTs: the Mirror writes tiles and entry bundles first and the checkpoint last, and the
// checkpoint is what tells the server to commit. Mirroring is not part of the safe API; the
// Mirror reads the log through `log.reader`, the safe API's way down to the ported one.

import { parseCheckpoint } from "webtessera/formats/log";
import { Mirror, newSinkTarget, type Sink, unrecoverable } from "webtessera/mirror";
import type { Session } from "./session.ts";

/** pushLog uploads what the server has not committed yet, and returns the committed size. */
export async function pushLog(session: Session, signal?: AbortSignal): Promise<bigint> {
	const base = new URL(session.uploads, session.server);
	const headers = { Authorization: `Bearer ${session.token}` };
	let committed = 0n;

	const sink: Sink = {
		async get(key) {
			const res = await session.fetch(new URL(key, base).href, { headers });
			if (res.status === 404) {
				return undefined;
			}
			const body = new Uint8Array(await res.arrayBuffer());
			if (!res.ok) {
				throw new Error(`reading ${key} failed (${res.status})`);
			}
			if (key === "checkpoint") {
				// The Mirror asks for the committed checkpoint to know what to upload. It must be this
				// log's own, signed by the device key.
				committed = parseCheckpoint(body, session.origin, session.log.verifier).checkpoint.size;
			}
			return body;
		},
		async put(key, data) {
			const res = await session.fetch(new URL(key, base).href, { method: "PUT", body: data.slice(), headers });
			const answer = (await res.text()).trim();
			if (!res.ok) {
				const err = new Error(`the server refused ${key} (${res.status}): ${answer}`);
				// A refusal will not change on retry; an outage might.
				throw res.status < 500 ? unrecoverable(err) : err;
			}
			committed = key === "checkpoint" ? BigInt(/^committed (\d+)$/.exec(answer)?.[1] ?? committed) : committed;
		},
	};
	await new Mirror({ source: session.log.reader, target: newSinkTarget(sink), numWorkers: 4 }).run(signal);
	return committed;
}
