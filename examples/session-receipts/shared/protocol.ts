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
// What the browser and the server say to each other, besides the witness protocol itself
// (https://c2sp.org/tlog-witness), which webtessera speaks on both sides.

/** Routes are the server's paths. */
export const Routes = {
	/** register: POST a Registration, get a RegistrationAnswer. */
	register: "/session",
	/** witness: the tlog-witness submission prefix (POST <witness>add-checkpoint). */
	witness: "/witness/",
	/** sessions: <sessions><origin hash>/<tlog-tiles path>, where a session's log is uploaded. */
	sessions: "/sessions/",
	/** notes: <notes><name>, the application under audit. */
	notes: "/api/notes/",
} as const;

/** Registration announces a new browser log to the server, which will witness it. */
export interface Registration {
	/** origin is the browser log's origin: `<host>/session/<32 hex digits>`, chosen by the browser. */
	readonly origin: string;
	/** vkey is the browser log's verifier key, made from its device key. */
	readonly vkey: string;
}

/** RegistrationAnswer is the server's answer to a Registration. */
export interface RegistrationAnswer {
	/** token authenticates the session's requests: the application's, and its log uploads. */
	readonly token: string;
	/** witness is the verifier key of the server's witness, which cosigns the log's checkpoints. */
	readonly witness: string;
	/** uploads is the path the session's log is uploaded under, with a trailing slash. */
	readonly uploads: string;
}

/** OriginPattern is the shape of a session log's origin. */
export const OriginPattern = /^[a-z0-9.-]+(?::[0-9]{1,5})?\/session\/[0-9a-f]{32}$/;

/** newSessionOrigin returns a fresh origin for a session log of the page served at host. */
export function newSessionOrigin(host: string): string {
	const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
	return `${host.toLowerCase()}/session/${id}`;
}
