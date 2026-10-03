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
// The page: it opens this device's log, logs what the user types, shows each receipt verified,
// and lists the log's events, which other tabs may be adding to as well.

import "./style.css";
import type { BrowserLog } from "webtessera/browser";
import { type DeviceLog, deviceOrigin, forgetDevice, openDeviceLog, webLocksAvailable } from "./device_log.ts";
import { encodeEvent } from "./events.ts";
import { readHistory, verifyByHand } from "./history.ts";
import { element, listItem, toBase64 } from "./ui.ts";

const ui = {
	refusal: element("refusal", HTMLDivElement),
	refusalText: element("refusal-text", HTMLParagraphElement),
	singleWriter: element("single-writer", HTMLButtonElement),
	banner: element("banner", HTMLParagraphElement),
	form: element("add-form", HTMLFormElement),
	input: element("event", HTMLInputElement),
	add: element("add", HTMLButtonElement),
	receipt: element("receipt", HTMLDetailsElement),
	receiptSummary: element("receipt-summary", HTMLElement),
	receiptText: element("receipt-text", HTMLPreElement),
	events: element("events", HTMLOListElement),
	hood: element("hood", HTMLDetailsElement),
	hoodText: element("hood-text", HTMLPreElement),
	origin: element("origin", HTMLElement),
	vkey: element("vkey", HTMLElement),
	custody: element("custody", HTMLElement),
	locking: element("locking", HTMLElement),
	persistence: element("persistence", HTMLElement),
	persist: element("persist", HTMLButtonElement),
	forget: element("forget", HTMLButtonElement),
};

/**
 * open opens the log. Without Web Locks it is refused, since other tabs could write it at the
 * same time, and the page offers to open it as this tab's alone. Secure contexts (HTTPS and
 * localhost) have Web Locks; `?no-web-locks` hides them, to show the refusal.
 */
async function open(): Promise<DeviceLog> {
	if (new URLSearchParams(location.search).has("no-web-locks")) {
		Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
	}
	const origin = deviceOrigin();
	try {
		return await openDeviceLog({ origin });
	} catch (err) {
		if (webLocksAvailable()) {
			throw err;
		}
		ui.refusalText.textContent = `The log refused to open: ${err instanceof Error ? err.message : String(err)}`;
		ui.refusal.hidden = false;
		await new Promise((resolve) => ui.singleWriter.addEventListener("click", resolve, { once: true }));
		ui.refusal.hidden = true;
		return openDeviceLog({ origin, singleWriter: true });
	}
}

async function append(log: BrowserLog, text: string): Promise<void> {
	const data = encodeEvent({ at: new Date().toISOString(), text });
	const receipt = await log.append(data);
	const { index, checkpoint } = log.verify(receipt, data);
	ui.receiptSummary.textContent = `Event ${index + 1n}: receipt verified against a signed checkpoint of ${checkpoint.size} events`;
	ui.receiptText.textContent = receipt.text;
	ui.receipt.hidden = false;
}

let shownSize = -1n;

/** refresh lists the newest events when the log has grown, here or in another tab. */
async function refresh(log: BrowserLog): Promise<void> {
	const { size } = await log.latestCheckpoint().catch(() => ({ size: 0n }));
	if (size === shownSize) {
		return;
	}
	shownSize = size;
	const history = await readHistory(log);
	ui.events.replaceChildren(...history.map((e) => listItem(e.index, e.event.text, "✓ receipt verified")));
	const newest = history[0];
	if (newest !== undefined) {
		const proof = await verifyByHand(log, newest);
		ui.hoodText.textContent = [
			`entry ${newest.index} of a tree of ${newest.receipt.checkpoint.size}, leaf hash and root checked`,
			`inclusion proof rebuilt from the log's tiles (${proof.length} hashes), identical to the receipt's:`,
			...proof.map((h, i) => `  ${toBase64(h)} ${toBase64(newest.receipt.proof.hashes[i] ?? new Uint8Array())}`),
		].join("\n");
		ui.hood.hidden = false;
	}
}

async function showDevice(d: DeviceLog): Promise<void> {
	ui.origin.textContent = d.log.origin;
	ui.vkey.textContent = d.log.vkey;
	ui.custody.textContent = `${d.key.backend}, ${d.key.extractable ? "extractable" : "cannot be exported, by any script"}`;
	ui.locking.textContent =
		d.log.lockScope === "origin"
			? "Shared: every tab of this page writes the log, taking turns through Web Locks."
			: "This tab only: without Web Locks, nothing keeps other tabs from writing at the same time.";
	const persisted = (await navigator.storage?.persisted?.()) ?? false;
	ui.persistence.textContent = persisted
		? "granted"
		: "not granted: the browser may evict the log under storage pressure";
	ui.persist.hidden = persisted;
}

async function main(): Promise<void> {
	const device = await open();
	const { log } = device;
	await showDevice(device);
	ui.persist.addEventListener("click", () => void navigator.storage.persist().then(() => showDevice(device)));
	ui.forget.addEventListener("click", () => {
		if (confirm("Delete this device's log and its key? Other tabs using it must reload.")) {
			void forgetDevice(log).then(() => location.reload(), fatal);
		}
	});
	ui.form.addEventListener("submit", (event) => {
		event.preventDefault();
		ui.add.disabled = true;
		append(log, ui.input.value)
			.then(() => {
				ui.input.value = "";
				return refresh(log);
			})
			.catch(fatal)
			.finally(() => {
				ui.add.disabled = false;
			});
	});
	ui.input.disabled = false;
	ui.add.disabled = false;
	// Polling is how this tab sees the events other tabs add.
	for (;;) {
		await refresh(log);
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}

function fatal(err: unknown): void {
	ui.banner.textContent = err instanceof Error ? err.message : String(err);
	ui.banner.hidden = false;
}

main().catch(fatal);
