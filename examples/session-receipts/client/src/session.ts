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
// A session, from the browser's side: a log of everything the browser does with the server, kept
// on the device, signed by a key that cannot leave it, and witnessed by the server. Nothing here
// touches the DOM, so the tests run this exact code in Node.

import { newWitness, newWitnessGroup } from "webtessera";
import { type BrowserLog, type BrowserStorage, type LogKey, openBrowserLog } from "webtessera/browser";
import type { FetchFn } from "webtessera/client";
import { type Registration, type RegistrationAnswer, Routes } from "../../shared/protocol.ts";

/** SessionInfo is what the browser remembers about a session between page loads. */
export interface SessionInfo extends RegistrationAnswer {
	readonly origin: string;
}

/** Session is an open session: its log, and how to reach the server. */
export interface Session extends SessionInfo {
	readonly log: BrowserLog;
	readonly server: URL;
	readonly fetch: FetchFn;
}

/** SessionOptions says where the server is, and with what the log is kept. */
export interface SessionOptions {
	readonly server: URL;
	/** key signs the log: openDeviceKey(origin) in a browser, so that it cannot be exported. */
	readonly key: LogKey;
	/** storage keeps the log: IndexedDB by default. */
	readonly storage?: BrowserStorage;
	readonly fetch?: FetchFn;
}

/** registerSession announces the key's log to the server, which answers with its witness's key. */
export async function registerSession(options: SessionOptions): Promise<SessionInfo> {
	const fetch = options.fetch ?? globalThis.fetch;
	const registration: Registration = { origin: options.key.origin, vkey: options.key.vkey };
	const res = await fetch(new URL(Routes.register, options.server).href, {
		method: "POST",
		body: JSON.stringify(registration),
	});
	if (res.status !== 201) {
		throw new Error(`the server refused the session (${res.status}): ${(await res.text()).trim()}`);
	}
	return { origin: registration.origin, ...((await res.json()) as RegistrationAnswer) };
}

/**
 * openSession opens a registered session's log with the server as its witness. Every
 * checkpoint must carry the server's cosignature before it is published (witnesses fail
 * closed), so every receipt the log hands back is cosigned, and the server has checked that
 * each checkpoint extends the last.
 */
export async function openSession(info: SessionInfo, options: SessionOptions): Promise<Session> {
	if (options.key.origin !== info.origin) {
		throw new Error(`the key is for ${options.key.origin}, not this session's log ${info.origin}`);
	}
	// Wrapped, not stored as is: browsers refuse a fetch called as a method of another object
	// ("Illegal invocation"), and the session calls it as session.fetch(...).
	const fetch: FetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
	const log = await openBrowserLog({
		key: options.key,
		witnesses: newWitnessGroup(1, newWitness(info.witness, new URL(Routes.witness, options.server))),
		...(options.storage === undefined ? {} : { storage: options.storage }),
		fetch,
	});
	return { ...info, log, server: options.server, fetch };
}

/** witnessPolicy is what a session's receipts must satisfy: the server's cosignature. */
export function witnessPolicy(session: SessionInfo): { threshold: number; witnesses: string[] } {
	return { threshold: 1, witnesses: [session.witness] };
}
