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

// A transparency log in a browser tab. The page runs a webtessera appender on an
// IndexedDB database, appends what the user types, waits for a signed checkpoint that
// commits to it, and verifies the entry's inclusion proof against that checkpoint the
// way any client of the log would. Every tab of this origin shares the same log.

import "./style.css";
import {
	type Appender,
	ErrNotExist,
	errorIs,
	type LogReader,
	newAppender,
	newAppendOptions,
	newEntry,
	newPublicationAwaiter,
	type PublicationAwaiter,
} from "webtessera";
import { getEntryBundle, newProofBuilder } from "webtessera/client";
import { type ParsedCheckpoint, parseCheckpoint } from "webtessera/formats/log";
import { verifyInclusion } from "webtessera/merkle/proof";
import { DefaultHasher } from "webtessera/merkle/rfc6962";
import { generateKey, newSigner, newVerifier, type Verifier } from "webtessera/note";
import { ErrClosed, newIndexedDBDriver } from "webtessera/storage/indexeddb";

// databaseName is the IndexedDB database holding the log. Every tab that opens a
// driver with this name appends to the same log.
const databaseName = "webtessera-demo";

// keyStorageKey is where the demo keeps its signing key, and the name of the Web Lock
// that guards creating it.
const keyStorageKey = "webtessera-demo/signing-key";

// recentEntries is how many of the log's latest entries the page lists.
const recentEntries = 8n;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** element returns the element with the given id, which index.html must provide. */
function element<T extends HTMLElement>(id: string, type: new () => T): T {
	const el = document.getElementById(id);
	if (!(el instanceof type)) {
		throw new Error(`index.html has no <${type.name}> with id "${id}"`);
	}
	return el;
}

const ui = {
	banner: element("banner", HTMLParagraphElement),
	form: element("add-form", HTMLFormElement),
	input: element("entry", HTMLInputElement),
	add: element("add", HTMLButtonElement),
	result: element("result", HTMLDivElement),
	checkpoint: element("checkpoint", HTMLPreElement),
	vkey: element("vkey", HTMLElement),
	entries: element("entries", HTMLOListElement),
	database: element("database", HTMLElement),
	locking: element("locking", HTMLElement),
	persistence: element("persistence", HTMLSpanElement),
	persist: element("persist", HTMLButtonElement),
	reset: element("reset", HTMLButtonElement),
};

/** Log is everything the page needs to append to and read from the running log. */
interface Log {
	readonly appender: Appender;
	readonly reader: LogReader;
	readonly awaiter: PublicationAwaiter;
	readonly origin: string;
	readonly verifier: Verifier;
	/** lifetime bounds the appender's background work and the database connection. */
	readonly lifetime: AbortController;
}

/**
 * loadOrCreateKey returns the log's note signing key pair, generating it on first use.
 *
 * Every tab must sign with the same key, since they all publish checkpoints for the
 * same log. The Web Lock keeps two tabs opened at the same moment from each
 * generating a key of its own.
 */
async function loadOrCreateKey(): Promise<{ skey: string; vkey: string }> {
	const loadOrCreate = (): { skey: string; vkey: string } => {
		const saved = localStorage.getItem(keyStorageKey);
		if (saved !== null) {
			const key: unknown = JSON.parse(saved);
			if (typeof key === "object" && key !== null && "skey" in key && "vkey" in key) {
				return { skey: String(key.skey), vkey: String(key.vkey) };
			}
		}
		const key = generateKey(undefined, `${location.host}/webtessera-demo`);
		localStorage.setItem(keyStorageKey, JSON.stringify(key));
		return key;
	};
	if (typeof navigator.locks?.request !== "function") {
		return loadOrCreate();
	}
	return navigator.locks.request(keyStorageKey, loadOrCreate);
}

/** startLog opens the IndexedDB-backed log and starts appending to it. */
async function startLog(): Promise<Log> {
	const { skey, vkey } = await loadOrCreateKey();
	const signer = newSigner(skey);
	const lifetime = new AbortController();

	const driver = await newIndexedDBDriver({ name: databaseName }, lifetime.signal);
	const opts = newAppendOptions()
		.withCheckpointSigner(signer)
		// A demo wants to see its entries published quickly; the defaults suit a busy log.
		.withBatching(64, 50)
		.withCheckpointInterval(500);
	const { appender, reader } = await newAppender(driver, opts, lifetime.signal);
	const awaiter = newPublicationAwaiter((signal) => reader.readCheckpoint(signal), 100, lifetime.signal);

	ui.vkey.textContent = vkey;
	return { appender, reader, awaiter, origin: signer.name(), verifier: newVerifier(vkey), lifetime };
}

/**
 * append adds text to the log, waits for a checkpoint that commits to it, and verifies
 * its inclusion proof against that checkpoint.
 */
async function append(log: Log, text: string): Promise<void> {
	const data = enc.encode(text);
	const [index, raw] = await log.awaiter.await(log.appender.add(newEntry(data)));
	if (raw === undefined) {
		throw new Error("the log published no checkpoint");
	}
	const { checkpoint } = parseCheckpoint(raw, log.origin, log.verifier);
	const pb = await newProofBuilder(checkpoint.size, (level, i, p, signal) => log.reader.readTile(level, i, p, signal));
	const proof = await pb.inclusionProof(index.index);
	verifyInclusion(DefaultHasher, index.index, checkpoint.size, DefaultHasher.hashLeaf(data), proof, checkpoint.hash);

	ui.result.replaceChildren(
		paragraph(
			index.isDup ? "Already in the log at index " : "Appended at index ",
			strong(index.index.toString()),
			`. Inclusion in the tree of size ${checkpoint.size} verified with a ${proof.length}-hash proof.`,
		),
		details(
			"Inclusion proof",
			proof.length === 0 ? ["(empty: the entry is the whole tree)"] : proof.map((h) => toHex(h)),
		),
	);
	ui.result.className = "result ok";
	ui.result.hidden = false;
}

/**
 * refresh shows the log's latest checkpoint and most recent entries. Entries other
 * tabs appended show up here too, since they read the same database.
 */
async function refresh(log: Log): Promise<void> {
	let parsed: ParsedCheckpoint;
	try {
		parsed = parseCheckpoint(await log.reader.readCheckpoint(), log.origin, log.verifier);
	} catch (err) {
		if (errorIs(err, ErrNotExist)) {
			ui.checkpoint.textContent = "No checkpoint published yet.";
			return;
		}
		throw err;
	}
	ui.checkpoint.textContent = parsed.note.text + signatureLines(parsed);

	const size = parsed.checkpoint.size;
	const first = size > recentEntries ? size - recentEntries : 0n;
	const items: HTMLLIElement[] = [];
	for (let b = first / 256n; b * 256n < size; b++) {
		const bundle = await getEntryBundle((i, p, signal) => log.reader.readEntryBundle(i, p, signal), b, size);
		for (const [j, entry] of bundle.entries.entries()) {
			const index = b * 256n + BigInt(j);
			if (index >= first) {
				const li = document.createElement("li");
				li.value = Number(index);
				li.textContent = dec.decode(entry);
				items.push(li);
			}
		}
	}
	ui.entries.replaceChildren(...items.reverse());
}

/** signatureLines renders the signature block of a checkpoint note. */
function signatureLines(parsed: ParsedCheckpoint): string {
	const sigs = parsed.note.sigs ?? [];
	return `\n${sigs.map((s) => `— ${s.name} ${s.base64}`).join("\n")}`;
}

/** showFatal reports an error that stops this tab from using the log. */
function showFatal(err: unknown): void {
	ui.banner.textContent = errorIs(err, ErrClosed)
		? "Another tab deleted or upgraded the log, so this tab let go of it. Reload the page to continue."
		: `The log stopped: ${String(err)}`;
	ui.banner.hidden = false;
	ui.input.disabled = true;
	ui.add.disabled = true;
}

async function showStorageFacts(): Promise<void> {
	ui.database.textContent = databaseName;
	ui.locking.textContent =
		typeof navigator.locks?.request === "function"
			? "Web Locks: tabs and workers of this origin take turns writing the log."
			: "Unavailable (Web Locks need a secure context). Use the log from one tab at a time.";

	if (typeof navigator.storage?.persisted !== "function") {
		ui.persistence.textContent = "Not supported by this browser.";
		return;
	}
	const persisted = await navigator.storage.persisted();
	ui.persistence.textContent = persisted
		? "Granted: the browser will not evict the log."
		: "Not granted: the browser may evict the log when it runs short of space.";
	ui.persist.hidden = persisted;
}

function deleteDatabase(name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.deleteDatabase(name);
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
	});
}

function paragraph(...children: (string | Node)[]): HTMLParagraphElement {
	const p = document.createElement("p");
	p.append(...children);
	return p;
}

function strong(text: string): HTMLElement {
	const s = document.createElement("strong");
	s.textContent = text;
	return s;
}

function details(summary: string, lines: string[]): HTMLDetailsElement {
	const d = document.createElement("details");
	const s = document.createElement("summary");
	s.textContent = summary;
	const pre = document.createElement("pre");
	pre.textContent = lines.join("\n");
	d.append(s, pre);
	return d;
}

function toHex(b: Uint8Array): string {
	return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function main(): Promise<void> {
	void showStorageFacts();
	ui.persist.addEventListener("click", () => {
		void navigator.storage.persist().then(showStorageFacts);
	});

	let log: Log | undefined;
	ui.reset.addEventListener("click", () => {
		if (!confirm("Delete this log and its signing key? Other tabs using it will need to reload.")) {
			return;
		}
		// Aborting the lifetime closes this tab's connection; other tabs close theirs
		// when the deletion reaches them, so nothing blocks it.
		log?.lifetime.abort();
		localStorage.removeItem(keyStorageKey);
		void deleteDatabase(databaseName).then(() => location.reload(), showFatal);
	});

	try {
		log = await startLog();
	} catch (err) {
		showFatal(err);
		return;
	}
	const running = log;

	ui.input.disabled = false;
	ui.add.disabled = false;
	ui.input.focus();
	ui.form.addEventListener("submit", (event) => {
		event.preventDefault();
		const text = ui.input.value;
		ui.add.disabled = true;
		ui.result.className = "result pending";
		ui.result.replaceChildren(paragraph("Waiting for a checkpoint that includes the entry…"));
		ui.result.hidden = false;
		append(running, text)
			.then(() => {
				ui.input.value = "";
				return refresh(running);
			})
			.catch((err: unknown) => {
				if (errorIs(err, ErrClosed)) {
					showFatal(err);
					return;
				}
				ui.result.className = "result error";
				ui.result.replaceChildren(paragraph(`Could not append: ${String(err)}`));
			})
			.finally(() => {
				ui.add.disabled = ui.input.disabled;
				ui.input.focus();
			});
	});

	// Poll for checkpoints, which is how this tab sees entries other tabs append.
	for (;;) {
		try {
			await refresh(running);
		} catch (err) {
			showFatal(err);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}

void main();
