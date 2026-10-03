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
// The sessions the server witnesses: one browser log each, registered when the browser starts
// the session. A registration binds the log's origin to its verifier key for good, first come,
// first served, so nobody can later claim someone else's log, or replace its key.

import type { Handler } from "webtessera/http";
import { newVerifier } from "webtessera/note";
import type { ObjectStore } from "webtessera/storage/objectstore";
import { originHash } from "webtessera/witness";
import { OriginPattern, type Registration, type RegistrationAnswer, Routes } from "../shared/protocol.ts";

/** Session is a registered browser log. */
export interface Session {
	readonly origin: string;
	readonly vkey: string;
	/** hash is the origin's SHA-256, hex: how URLs and storage keys name the session. */
	readonly hash: string;
}

/** stored is what the registry keeps per session: never the token itself, only its hash. */
interface stored extends Session {
	readonly tokenHash: string;
}

/** Sessions is the registry, kept in any ObjectStore. */
export class Sessions {
	readonly #store: ObjectStore;

	constructor(store: ObjectStore) {
		this.#store = store;
	}

	/** register records a new session and returns its token, or undefined if the origin is taken. */
	async register(r: Registration): Promise<string | undefined> {
		const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
		const record: stored = {
			origin: r.origin,
			vkey: r.vkey,
			hash: originHash(r.origin),
			tokenHash: await sha256(token),
		};
		// create is atomic create-if-absent: of two registrations racing for one origin, one wins.
		const created = await this.#store.create(key(record.hash), new TextEncoder().encode(JSON.stringify(record)));
		return created ? token : undefined;
	}

	/** byOrigin returns the session whose log has this origin. */
	async byOrigin(origin: string): Promise<Session | undefined> {
		return this.#read(originHash(origin));
	}

	/** authorize returns the session a request's bearer token belongs to, if it belongs to one. */
	async authorize(request: Request, hash: string): Promise<Session | undefined> {
		const token = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("Authorization") ?? "")?.[1];
		const session = token === undefined ? undefined : await this.#read(hash);
		// Hashes are compared, not tokens, so the comparison's timing tells nothing useful.
		return session !== undefined && session.tokenHash === (await sha256(token ?? "")) ? session : undefined;
	}

	async #read(hash: string): Promise<stored | undefined> {
		const data = await this.#store.get(key(hash));
		return data === undefined ? undefined : (JSON.parse(new TextDecoder().decode(data)) as stored);
	}
}

/** newRegistrationHandler answers `POST /session` with a token and the witness's key. */
export function newRegistrationHandler(sessions: Sessions, witnessVkey: string): Handler {
	return async (request) => {
		if (new URL(request.url).pathname !== Routes.register) {
			return undefined;
		}
		if (request.method !== "POST") {
			return new Response("method not allowed\n", { status: 405, headers: { Allow: "POST" } });
		}
		const r = parseRegistration(await request.text().catch(() => ""));
		if (typeof r === "string") {
			return new Response(`${r}\n`, { status: 400 });
		}
		const token = await sessions.register(r);
		if (token === undefined) {
			return new Response("this origin is already registered\n", { status: 409 });
		}
		const answer: RegistrationAnswer = {
			token,
			witness: witnessVkey,
			uploads: `${Routes.sessions}${originHash(r.origin)}/`,
		};
		return Response.json(answer, { status: 201 });
	};
}

/** parseRegistration returns the registration a body holds, or what is wrong with it. */
function parseRegistration(body: string): Registration | string {
	let r: Partial<Registration>;
	try {
		r = JSON.parse(body) as Partial<Registration>;
	} catch {
		return "the body must be JSON: { origin, vkey }";
	}
	if (typeof r.origin !== "string" || !OriginPattern.test(r.origin)) {
		return "origin must look like <host>/session/<32 hex digits>";
	}
	try {
		// The key must be the log's own: its name is the origin every checkpoint starts with.
		if (typeof r.vkey !== "string" || newVerifier(r.vkey).name() !== r.origin) {
			return "vkey must be a verifier key named after the origin";
		}
	} catch {
		return "vkey is not a note verifier key";
	}
	return { origin: r.origin, vkey: r.vkey };
}

function key(hash: string): string {
	return `sessions/${hash}`;
}

async function sha256(text: string): Promise<string> {
	return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

function toHex(b: Uint8Array): string {
	return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
