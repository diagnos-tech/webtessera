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

import { renderNoteBody } from "../shared/note.ts";
import { renderEntries, renderInclusion, renderTiles } from "../shared/panels.ts";
import { listed } from "./listed.ts";
import { DemoLog, type Snapshot } from "./log.ts";
import { randomEntries } from "./random.ts";

// maxEntries keeps the demo light: a few full tiles are plenty to see the structure.
const maxEntries = 4096n;

function el<T extends Element>(root: HTMLElement, selector: string, type: new () => T): T {
	const found = root.querySelector(selector);
	if (!(found instanceof type)) {
		throw new Error(`demo markup has no ${type.name} matching ${selector}`);
	}
	return found;
}

/** start runs the live demo in the section rooted at root. */
export async function start(root: HTMLElement): Promise<void> {
	const ui = {
		form: el(root, "[data-demo-form]", HTMLFormElement),
		input: el(root, "#demo-entry", HTMLInputElement),
		status: el(root, "[data-demo-status]", HTMLElement),
		entries: el(root, "[data-demo-entries]", HTMLOListElement),
		note: el(root, "[data-demo-note]", HTMLElement),
		noteMeta: el(root, "[data-demo-note-meta]", HTMLElement),
		tiles: el(root, "[data-demo-tiles]", HTMLElement),
		proof: el(root, "[data-demo-proof]", HTMLElement),
		tamper: el(root, "[data-demo-tamper]", HTMLInputElement),
		fill: el(root, "[data-demo-fill]", HTMLButtonElement),
	};
	const controls = [
		...root.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
			"[data-demo-form] :is(input, button), [data-demo-tamper]",
		),
	];
	let busy = true;
	const setBusy = (b: boolean) => {
		busy = b;
		for (const c of controls) {
			c.disabled = b;
		}
		root.toggleAttribute("aria-busy", b);
	};
	const say = (text: string, bad = false) => {
		ui.status.textContent = text;
		ui.status.classList.toggle("bad", bad);
	};

	say("Starting a log in this tab…");
	const seed = JSON.parse(root.dataset.seed ?? "[]") as string[];
	const log = await DemoLog.open(`${root.dataset.origin ?? "localhost"}/demo`, new AbortController().signal);
	await log.append(seed);

	let shown: Snapshot | undefined;
	let selected = BigInt(Math.min(5, Math.max(seed.length - 1, 0)));

	const highlight = (lo?: bigint, hi?: bigint) => {
		for (const c of ui.tiles.querySelectorAll<HTMLElement>("[data-level='0'] .c[data-i]")) {
			const i = BigInt(c.dataset.i ?? "-1");
			c.classList.toggle("hit", i === selected);
			c.classList.toggle("rng", lo !== undefined && hi !== undefined && i >= lo && i < hi);
		}
	};

	const prove = async (index: bigint): Promise<boolean> => {
		if (shown === undefined) {
			return false;
		}
		selected = index;
		const p = await log.prove(shown.checkpoint, index, ui.tamper.checked);
		ui.proof.innerHTML = renderInclusion(p, ui.tamper.checked).value;
		for (const li of ui.entries.querySelectorAll("li")) {
			li.classList.toggle("sel", li.querySelector(`[data-prove="${index}"]`) !== null);
		}
		highlight();
		return p.error === undefined;
	};

	const refresh = async () => {
		const before = shown?.checkpoint.checkpoint.size ?? 0n;
		shown = await log.snapshot(listed);
		const { checkpoint, tiles, latest } = shown;
		const size = checkpoint.checkpoint.size;
		ui.note.innerHTML = renderNoteBody({ text: checkpoint.note.text, sigs: checkpoint.note.sigs ?? [] }).value;
		ui.noteMeta.textContent = "signed in this tab, just now";
		ui.tiles.innerHTML = renderTiles(tiles, selected).value;
		ui.entries.innerHTML = renderEntries(latest, selected).value;
		for (const c of ui.tiles.querySelectorAll<HTMLElement>(".c[data-i]")) {
			if (before > 0n && c.closest("[data-level='0']") !== null && BigInt(c.dataset.i ?? "0") >= before) {
				c.classList.add("new");
			}
		}
		if (size !== before) {
			ui.note.classList.add("flash");
			requestAnimationFrame(() => requestAnimationFrame(() => ui.note.classList.remove("flash")));
		}
		ui.fill.disabled = size >= maxEntries;
	};

	const run = async (texts: readonly string[], describe: (first: bigint, ms: number) => string) => {
		setBusy(true);
		say(
			texts.length === 1
				? "Appending, then waiting for a checkpoint that commits to it…"
				: `Appending ${texts.length} entries…`,
		);
		try {
			const t0 = performance.now();
			const indices = await log.append(texts);
			const ms = Math.round(performance.now() - t0);
			await refresh();
			const last = indices[indices.length - 1] ?? 0n;
			const ok = await prove(last);
			say(
				`${describe(indices[0] ?? 0n, ms)} ${ok ? `Entry ${last}’s inclusion proof verified against the new checkpoint.` : ""}`,
			);
		} catch (err) {
			say(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`, true);
		} finally {
			setBusy(false);
			ui.fill.disabled = (shown?.checkpoint.checkpoint.size ?? 0n) >= maxEntries;
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
	root.querySelector("[data-demo-add]")?.addEventListener("click", () => {
		void run(randomEntries(10), (i, ms) => `Entries ${i}–${i + 9n} were appended and published in ${ms} ms.`);
	});
	ui.fill.addEventListener("click", () => {
		const size = shown?.checkpoint.checkpoint.size ?? 0n;
		const n = 256 - Number(size % 256n);
		void run(randomEntries(n), (i, ms) => {
			const tile = String((i + BigInt(n)) / 256n - 1n).padStart(3, "0");
			return `${n} entries in ${ms} ms: tile ${tile} is full, and level 1 holds its hash. Its partial versions are garbage-collected in the background.`;
		}).then(() => {
			// Show the store after the appender's garbage collection has removed the partial tiles.
			setTimeout(() => {
				if (!busy) {
					void refresh().then(() => highlight());
				}
			}, 2000);
		});
	});
	ui.tamper.addEventListener("change", () => {
		void prove(selected).then((ok) =>
			say(
				ok
					? `Entry ${selected} verified again with its real contents.`
					: `With one byte changed, entry ${selected} no longer matches the checkpoint: the proof is rejected.`,
				!ok,
			),
		);
	});
	ui.entries.addEventListener("click", (e) => {
		const target = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-prove]") : null;
		if (target !== null) {
			void prove(BigInt(target.dataset.prove ?? "0")).then((ok) =>
				say(
					ok ? `Entry ${selected} is in the log: its proof verified.` : `Entry ${selected}’s proof was rejected.`,
					!ok,
				),
			);
		}
	});
	const showRange = (e: Event) => {
		const row = e.target instanceof Element ? e.target.closest<HTMLElement>(".row[data-lo]") : null;
		highlight(
			row === null ? undefined : BigInt(row.dataset.lo ?? "0"),
			row === null ? undefined : BigInt(row.dataset.hi ?? "0"),
		);
	};
	ui.proof.addEventListener("pointerover", showRange);
	ui.proof.addEventListener("focusin", showRange);
	ui.proof.addEventListener("pointerleave", () => highlight());
	ui.proof.addEventListener("focusout", () => highlight());

	await refresh();
	await prove(selected);
	setBusy(false);
	root.dataset.live = "true";
	say("Live: this log runs in your tab, with a key generated here. Append something, or pick an entry to prove.");
}
