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
// The page: it opens (or starts) the session, sends every call to the application through the
// recorder, shows each interaction with the verdict on its receipt, and uploads the log for the
// server to commit after each one.

import "./style.css";
import { openDeviceKey, type Receipt, verifyReceipt } from "webtessera/browser";
import { getEntryBundle } from "webtessera/client";
import { decodeInteraction, encodeInteraction, type Interaction } from "../../shared/interaction.ts";
import { newSessionOrigin, Routes } from "../../shared/protocol.ts";
import { pushLog } from "./push.ts";
import { recordedFetch } from "./recorder.ts";
import { openSession, registerSession, type Session, type SessionInfo, witnessPolicy } from "./session.ts";
import { element, interactionRow } from "./ui.ts";

const ui = {
	banner: element("banner", HTMLParagraphElement),
	name: element("name", HTMLInputElement),
	text: element("text", HTMLTextAreaElement),
	answer: element("answer", HTMLPreElement),
	committed: element("committed", HTMLParagraphElement),
	rows: element("rows", HTMLTableSectionElement),
	origin: element("origin", HTMLElement),
	vkey: element("vkey", HTMLElement),
	witness: element("witness", HTMLElement),
	buttons: ["save", "load", "delete", "verify"].map((id) => element(id, HTMLButtonElement)),
};

// sessionKey is where the page remembers its session: the log's origin, the session token and the
// witness key it pinned at registration. The device key and the log themselves are in IndexedDB.
const sessionKey = "session-receipts/session";

/** start opens the session this browser already has, or registers a new one. */
async function start(): Promise<Session> {
	const server = new URL(location.origin);
	const saved = localStorage.getItem(sessionKey);
	const known = saved === null ? undefined : (JSON.parse(saved) as SessionInfo);
	const key = await openDeviceKey(known?.origin ?? newSessionOrigin(location.host));
	const info = known ?? (await registerSession({ server, key }));
	localStorage.setItem(sessionKey, JSON.stringify(info));
	return openSession(info, { server, key });
}

/** verdict checks a receipt as anyone could: the device's signature, the server's cosignature, inclusion. */
function verdict(session: Session, i: Interaction, receipt: Receipt): { ok: boolean; text: string } {
	try {
		const v = verifyReceipt(receipt, {
			vkey: session.log.vkey,
			data: encodeInteraction(i),
			witnesses: witnessPolicy(session),
		});
		return { ok: true, text: `✓ in a tree of ${v.checkpoint.size}, cosigned by ${v.cosignedBy.join(", ")}` };
	} catch (err) {
		return { ok: false, text: `✗ ${err instanceof Error ? err.message : String(err)}` };
	}
}

/** showHistory lists every interaction in the log, proving each against the latest checkpoint. */
async function showHistory(session: Session): Promise<void> {
	const { size } = await session.log.latestCheckpoint();
	const rows: HTMLTableRowElement[] = [];
	// The safe API has no way to read entries back, so this reads entry bundles through
	// log.reader with webtessera/client, the ported API underneath.
	for (let b = 0n; b * 256n < size; b++) {
		const bundle = await getEntryBundle((i, p, s) => session.log.reader.readEntryBundle(i, p, s), b, size);
		for (const [j, entry] of bundle.entries.entries()) {
			const index = b * 256n + BigInt(j);
			const i = decodeInteraction(entry);
			rows.push(interactionRow(index, i, verdict(session, i, await session.log.prove(index))));
		}
	}
	ui.rows.replaceChildren(...rows);
}

let pushing = Promise.resolve();

/** push uploads the log for the server to commit, one upload at a time, retrying once. */
function push(session: Session): void {
	pushing = pushing.then(async () => {
		const committed = await pushLog(session).catch(() => pushLog(session));
		ui.committed.textContent = `The server has committed the first ${committed} interactions to its bucket.`;
	});
	pushing = pushing.catch((err: unknown) => {
		ui.committed.textContent = `Not committed yet: ${err instanceof Error ? err.message : String(err)}`;
	});
}

async function call(session: Session, method: string): Promise<void> {
	const r = await recordedFetch(session, `${Routes.notes}${encodeURIComponent(ui.name.value)}`, {
		method,
		...(method === "PUT" ? { body: ui.text.value } : {}),
	});
	ui.answer.textContent = `${method} → ${r.status} ${r.body}`;
	if (method === "GET" && r.status === 200) {
		ui.text.value = r.body.replace(/\n$/, "");
	}
	ui.rows.append(interactionRow(r.receipt.index, r.interaction, verdict(session, r.interaction, r.receipt)));
	push(session);
}

async function main(): Promise<void> {
	element("new-session", HTMLButtonElement).addEventListener("click", () => {
		localStorage.removeItem(sessionKey);
		location.reload();
	});
	const session = await start();
	ui.origin.textContent = session.origin;
	ui.vkey.textContent = session.log.vkey;
	ui.witness.textContent = session.witness;
	await showHistory(session);
	push(session);

	const [save, load, del, verify] = ui.buttons;
	const actions = new Map([
		[save, () => call(session, "PUT")],
		[load, () => call(session, "GET")],
		[del, () => call(session, "DELETE")],
		[verify, () => showHistory(session)],
	]);
	for (const [button, action] of actions) {
		button?.addEventListener("click", () => {
			for (const b of ui.buttons) b.disabled = true;
			action()
				.catch(fatal)
				.finally(() => {
					for (const b of ui.buttons) b.disabled = false;
				});
		});
		if (button !== undefined) button.disabled = false;
	}
}

function fatal(err: unknown): void {
	ui.banner.textContent = err instanceof Error ? err.message : String(err);
	ui.banner.hidden = false;
}

main().catch(fatal);
