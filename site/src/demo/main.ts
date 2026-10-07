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

// The live demo's controller. It starts a log in the tab, seeds it with the entries the
// static page shows (so that nothing jumps), and from then on redraws the panels from
// the log after every append, with the renderers the build used.
//
// Every listed entry is a field. Changing one changes nothing in the log, which is append-only:
// it changes what the page claims the entry is, as someone who altered a stored entry would.
// The claim is verified at once against the signed checkpoint, with the entry's real inclusion
// proof, and the verifier rejects it. Nothing here says "tampering" unless verifyInclusion threw.

import { renderNoteBody } from "../shared/note.ts";
import { leafHash, renderEntries, renderInclusion, renderTiles } from "../shared/panels.ts";
import { listed } from "./listed.ts";
import { DemoLog, type Snapshot } from "./log.ts";
import { randomEntries } from "./random.ts";

// maxEntries keeps the demo light: a few full tiles are plenty to see the structure.
const maxEntries = 4096n;

type State = "busy" | "ok" | "bad" | "error";

function el<T extends Element>(root: HTMLElement, selector: string, type: new () => T): T {
	const found = root.querySelector(selector);
	if (!(found instanceof type)) {
		throw new Error(`demo markup has no ${type.name} matching ${selector}`);
	}
	return found;
}

/** join lists indices as prose: "3", "3 and 5", "3, 5 and 8". */
function join(indices: readonly bigint[]): string {
	const names = indices.map(String);
	return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** start runs the live demo in the section rooted at root. */
export async function start(root: HTMLElement): Promise<void> {
	const ui = {
		form: el(root, "[data-demo-form]", HTMLFormElement),
		input: el(root, "#demo-entry", HTMLInputElement),
		mode: el(root, "[data-demo-mode]", HTMLElement),
		origin: el(root, "[data-demo-origin]", HTMLElement),
		status: el(root, "[data-demo-status]", HTMLElement),
		title: el(root, "[data-demo-status-title]", HTMLElement),
		detail: el(root, "[data-demo-status-detail]", HTMLElement),
		entries: el(root, "[data-demo-entries]", HTMLOListElement),
		count: el(root, "[data-demo-count]", HTMLElement),
		note: el(root, "[data-demo-note]", HTMLElement),
		noteMeta: el(root, "[data-demo-note-meta]", HTMLElement),
		tiles: el(root, "[data-demo-tiles]", HTMLElement),
		proof: el(root, "[data-demo-proof]", HTMLElement),
		fill: el(root, "[data-demo-fill]", HTMLButtonElement),
		add: el(root, "[data-demo-add]", HTMLButtonElement),
		reset: el(root, "[data-demo-reset]", HTMLButtonElement),
	};
	const controls = [
		...root.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
			"[data-demo-form] :is(input, button), [data-demo-reset]",
		),
	];
	const seed = JSON.parse(root.dataset.seed ?? "[]") as string[];
	const origin = `${root.dataset.origin ?? "localhost"}/demo`;

	let busy = true;
	const setBusy = (b: boolean) => {
		busy = b;
		for (const c of controls) {
			c.disabled = b;
		}
		root.toggleAttribute("aria-busy", b);
	};
	// The status is a live region: it is only touched when what it says changes.
	const say = (state: State, title: string, detail: string) => {
		if (ui.status.dataset.state !== state) {
			ui.status.dataset.state = state;
		}
		if (ui.title.textContent !== title) {
			ui.title.textContent = title;
		}
		if (ui.detail.textContent !== detail) {
			ui.detail.textContent = detail;
		}
	};
	const fail = (err: unknown) => say("error", "Something went wrong", err instanceof Error ? err.message : String(err));

	say("busy", "Starting a log in this tab", "Generating a key, then appending the entries the page was built with.");
	let log = await DemoLog.open(origin);
	await log.append(seed);

	let shown: Snapshot | undefined;
	let selected = BigInt(Math.max(seed.length - 1, 0));
	// held are the listed entries as the log holds them; edits are the visitor's changes to them;
	// rejected are the changed entries whose proof the verifier has rejected.
	const held = new Map<bigint, string>();
	const edits = new Map<bigint, string>();
	const rejected = new Set<bigint>();
	const size = () => shown?.checkpoint.checkpoint.size ?? 0n;

	// mark shows, in the tiles, the selected entry, the rejected ones, and the range [lo, hi) of
	// the proof hash the reader points at.
	const mark = (lo?: bigint, hi?: bigint) => {
		for (const c of ui.tiles.querySelectorAll<HTMLElement>("[data-level='0'] .c[data-i]")) {
			const i = BigInt(c.dataset.i ?? "-1");
			c.classList.toggle("hit", i === selected);
			c.classList.toggle("bad", rejected.has(i));
			c.classList.toggle("rng", lo !== undefined && hi !== undefined && i >= lo && i < hi);
		}
	};

	// verdict states what the verifier found: tampering if it rejected any changed entry, else that
	// the selected entry verified. `did` is what the last action did, said with it.
	const verdict = (did = "") => {
		const bad = [...rejected].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		if (bad.length === 0) {
			say(
				"ok",
				"Verified",
				did !== ""
					? did
					: `Entry ${selected} is in the tree of ${size()}: its inclusion proof recomputes the root the checkpoint signs.`,
			);
			return;
		}
		const one = bad.length === 1;
		say(
			"bad",
			"Tampering detected",
			`${one ? `Entry ${bad[0]} no longer matches` : `Entries ${join(bad)} no longer match`} the signed checkpoint. ${
				one ? "Its leaf hash changed" : "Their leaf hashes changed"
			}, so the root recomputed from ${one ? "its proof" : "their proofs"} is not the root the log signed.${
				did === "" ? "" : ` ${did}`
			}`,
		);
	};

	// check verifies entry index against the shown checkpoint, as the log holds it or as the
	// visitor changed it, and draws the outcome. A check that a later edit or checkpoint has
	// overtaken draws nothing.
	const check = async (index: bigint, did = ""): Promise<boolean> => {
		const cp = shown?.checkpoint;
		if (cp === undefined) {
			return false;
		}
		const claimed = edits.get(index);
		let p: Awaited<ReturnType<DemoLog["prove"]>>;
		try {
			p = await log.prove(cp, index, claimed);
		} catch (err) {
			// A log that Reset is closing cannot be read: the new log's first check replaces this one.
			if (shown?.checkpoint === cp) {
				fail(err);
			}
			return false;
		}
		if (edits.get(index) !== claimed || shown?.checkpoint !== cp) {
			return false;
		}
		if (p.error !== undefined && claimed !== undefined) {
			rejected.add(index);
		} else {
			rejected.delete(index);
		}
		if (index === selected) {
			ui.proof.innerHTML = renderInclusion(p, claimed !== undefined).value;
		}
		mark();
		if (p.error !== undefined && claimed === undefined) {
			say("error", "Proof rejected", `Entry ${index}’s proof did not verify: ${p.error}`);
		} else {
			verdict(did);
		}
		return p.error === undefined;
	};

	const row = (index: bigint) => ui.entries.querySelector<HTMLElement>(`li[data-index="${index}"]`);

	// updateRow redraws one row in place, so that the field being typed in keeps its caret.
	const updateRow = (index: bigint) => {
		const li = row(index);
		if (li === null) {
			return;
		}
		const claimed = edits.get(index);
		li.classList.toggle("bad", claimed !== undefined);
		const hash = li.querySelector(".lh");
		if (hash !== null) {
			hash.textContent = leafHash(claimed ?? held.get(index) ?? "");
		}
		const undo = li.querySelector<HTMLButtonElement>(".undo");
		if (undo !== null) {
			undo.hidden = claimed === undefined;
		}
		li.querySelector("input")?.setAttribute(
			"aria-label",
			claimed === undefined ? `Entry ${index}` : `Entry ${index}, changed from what the log holds`,
		);
	};

	const select = (index: bigint): Promise<boolean> => {
		selected = index;
		for (const li of ui.entries.querySelectorAll<HTMLElement>("li[data-index]")) {
			li.classList.toggle("sel", li.dataset.index === String(index));
		}
		return check(index);
	};

	// drawList lists the newest entries, and keeps the selected and the changed ones listed when
	// newer entries have pushed them out. A field that had the focus gets it back.
	const drawList = async () => {
		if (shown === undefined) {
			return;
		}
		held.clear();
		for (const e of shown.latest) {
			held.set(e.index, e.text);
		}
		for (const i of [selected, ...edits.keys()]) {
			if (!held.has(i) && i < size()) {
				const [e] = await log.entries(i, i + 1n, size());
				if (e !== undefined) {
					held.set(i, e.text);
				}
			}
		}
		const focused =
			document.activeElement instanceof HTMLInputElement ? document.activeElement.dataset.entry : undefined;
		ui.entries.innerHTML = renderEntries(
			[...held].map(([index, text]) => {
				const claimed = edits.get(index);
				return claimed === undefined ? { index, text } : { index, text, claimed };
			}),
			{ selected, live: true },
		).value;
		for (const index of edits.keys()) {
			updateRow(index);
		}
		if (focused !== undefined) {
			ui.entries.querySelector<HTMLInputElement>(`input[data-entry="${focused}"]`)?.focus();
		}
		ui.count.textContent =
			size() > BigInt(listed)
				? `The newest ${listed} of ${size()} entries. Change any of them.`
				: `All ${size()} entries. Change any of them.`;
	};

	const refresh = async () => {
		const before = size();
		shown = await log.snapshot(listed);
		const { checkpoint, tiles } = shown;
		ui.note.innerHTML = renderNoteBody({ text: checkpoint.note.text, sigs: checkpoint.note.sigs ?? [] }, true).value;
		ui.noteMeta.textContent = "signed in this tab";
		ui.tiles.innerHTML = renderTiles(tiles, selected).value;
		await drawList();
		for (const c of ui.tiles.querySelectorAll<HTMLElement>(".c[data-i]")) {
			if (before > 0n && c.closest("[data-level='0']") !== null && BigInt(c.dataset.i ?? "0") >= before) {
				c.classList.add("new");
			}
		}
		if (size() !== before) {
			ui.note.classList.add("flash");
			requestAnimationFrame(() => requestAnimationFrame(() => ui.note.classList.remove("flash")));
		}
		root.dataset.size = String(size());
	};

	// recheck verifies every changed entry again, then the selected one: a new checkpoint does
	// not make a changed entry match.
	const recheck = async (did = "") => {
		for (const index of [...edits.keys()]) {
			if (index !== selected) {
				await check(index);
			}
		}
		await check(selected, did);
	};

	const run = async (texts: readonly string[], describe: (first: bigint, ms: number) => string) => {
		setBusy(true);
		say(
			"busy",
			texts.length === 1 ? "Appending" : `Appending ${texts.length} entries`,
			"Sequencing, integrating into the tree, and waiting for a checkpoint that commits to it.",
		);
		try {
			const t0 = performance.now();
			const indices = await log.append(texts);
			const ms = Math.round(performance.now() - t0);
			selected = indices[indices.length - 1] ?? selected;
			await refresh();
			await recheck(
				`${describe(indices[0] ?? 0n, ms)} Entry ${selected}’s inclusion proof verifies against the new checkpoint.`,
			);
		} catch (err) {
			fail(err);
		} finally {
			setBusy(false);
			ui.fill.disabled = size() >= maxEntries;
		}
	};

	ui.form.addEventListener("submit", (e) => {
		e.preventDefault();
		const text = ui.input.value.trim();
		if (text === "") {
			return;
		}
		ui.input.value = "";
		void run(
			[text],
			(i, ms) => `Entry ${i} was sequenced, integrated and published in a signed checkpoint in ${ms} ms.`,
		).then(() => ui.input.focus());
	});
	ui.add.addEventListener("click", () => {
		void run(randomEntries(10), (i, ms) => `Entries ${i}–${i + 9n} were appended and published in ${ms} ms.`);
	});
	ui.fill.addEventListener("click", () => {
		const n = 256 - Number(size() % 256n);
		void run(randomEntries(n), (i, ms) => {
			const tile = String((i + BigInt(n)) / 256n - 1n).padStart(3, "0");
			return `${n} entries in ${ms} ms: tile ${tile} is full, and level 1 holds its hash.`;
		}).then(() => {
			// Show the store once the appender's garbage collection has removed the partial tiles.
			setTimeout(() => {
				if (!busy && shown !== undefined) {
					void log.snapshot(listed).then((s) => {
						if (!busy && s.checkpoint.checkpoint.size === size()) {
							ui.tiles.innerHTML = renderTiles(s.tiles, selected).value;
							mark();
						}
					});
				}
			}, 2000);
		});
	});
	ui.reset.addEventListener("click", () => {
		setBusy(true);
		say("busy", "Starting over", "A new log and a new key, with the entries the page was built with.");
		void (async () => {
			try {
				shown = undefined;
				edits.clear();
				rejected.clear();
				await log.close();
				log = await DemoLog.open(origin);
				await log.append(seed);
				selected = BigInt(Math.max(seed.length - 1, 0));
				await refresh();
				await check(selected, "A new log, signed by a new key, holds the page’s entries again.");
			} catch (err) {
				fail(err);
			} finally {
				setBusy(false);
			}
		})();
	});

	const entryOf = (target: EventTarget | null): { input: HTMLInputElement; index: bigint } | undefined => {
		const li = target instanceof Element ? target.closest<HTMLElement>("li[data-index]") : null;
		const input = li?.querySelector("input");
		return li === null || input === null || input === undefined
			? undefined
			: { input, index: BigInt(li.dataset.index ?? "0") };
	};
	const restore = (input: HTMLInputElement, index: bigint) => {
		edits.delete(index);
		input.value = held.get(index) ?? "";
		updateRow(index);
		input.focus();
		void check(index);
	};
	ui.entries.addEventListener("input", (e) => {
		const entry = entryOf(e.target);
		if (entry === undefined || e.target !== entry.input) {
			return;
		}
		if (entry.input.value === held.get(entry.index)) {
			edits.delete(entry.index);
		} else {
			edits.set(entry.index, entry.input.value);
		}
		updateRow(entry.index);
		void check(entry.index);
	});
	ui.entries.addEventListener("focusin", (e) => {
		const entry = entryOf(e.target);
		if (entry !== undefined && entry.index !== selected) {
			void select(entry.index);
		}
	});
	ui.entries.addEventListener("click", (e) => {
		const entry = entryOf(e.target);
		if (entry === undefined) {
			return;
		}
		if (e.target instanceof Element && e.target.closest("[data-restore]") !== null) {
			restore(entry.input, entry.index);
		} else if (e.target !== entry.input) {
			entry.input.focus();
		}
	});
	ui.entries.addEventListener("keydown", (e) => {
		const entry = entryOf(e.target);
		if (entry !== undefined && e.key === "Escape" && edits.has(entry.index)) {
			restore(entry.input, entry.index);
		}
	});

	const showRange = (e: Event) => {
		const sibling = e.target instanceof Element ? e.target.closest<HTMLElement>(".row[data-lo]") : null;
		mark(
			sibling === null ? undefined : BigInt(sibling.dataset.lo ?? "0"),
			sibling === null ? undefined : BigInt(sibling.dataset.hi ?? "0"),
		);
	};
	ui.proof.addEventListener("pointerover", showRange);
	ui.proof.addEventListener("focusin", showRange);
	ui.proof.addEventListener("pointerleave", () => mark());
	ui.proof.addEventListener("focusout", () => mark());

	await refresh();
	await check(
		selected,
		"This log runs in your tab, signed by a key generated here. Add an entry, or change one and watch its proof fail.",
	);
	setBusy(false);
	ui.mode.textContent = "Live in this tab";
	ui.origin.textContent = origin;
	root.dataset.live = "true";
}
