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

// The only script every visitor downloads: copy buttons, the package-manager switchers kept
// in step, the current section in the navigation, and the live demo, which is fetched only
// when its section approaches the viewport. The page is complete without it.

function copyTextFor(button: HTMLElement): string {
	const scope = button.closest(".install, .code");
	// An install switcher has one command per package manager; copy the one on show.
	const candidates = [...(scope?.querySelectorAll<HTMLElement>("[data-copy-text], pre") ?? [])];
	const source = candidates.find((el) => el.offsetParent !== null) ?? candidates[0];
	return source?.textContent?.trim() ?? "";
}

const pmKey = "webtessera-site:package-manager";

/** syncPackageManagers keeps every switcher on the last package manager chosen, and remembers it. */
function syncPackageManagers(): void {
	const radios = [...document.querySelectorAll<HTMLInputElement>("input.pm-radio")];
	const choose = (value: string) => {
		for (const r of radios) {
			r.checked = r.value === value;
		}
	};
	try {
		const saved = localStorage.getItem(pmKey);
		if (saved !== null && radios.some((r) => r.value === saved)) {
			choose(saved);
		}
	} catch {
		// Storage can be unavailable (private windows, blocked site data); the default stays.
	}
	for (const r of radios) {
		r.addEventListener("change", () => {
			choose(r.value);
			try {
				localStorage.setItem(pmKey, r.value);
			} catch {
				// Not remembered; the choice still applies to this page.
			}
		});
	}
}

function wireCopyButtons(): void {
	for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
		const label = button.getAttribute("aria-label") ?? "Copy";
		button.hidden = false;
		button.addEventListener("click", () => {
			navigator.clipboard.writeText(copyTextFor(button)).then(
				() => {
					button.classList.add("done");
					button.setAttribute("aria-label", "Copied");
					setTimeout(() => {
						button.classList.remove("done");
						button.setAttribute("aria-label", label);
					}, 1600);
				},
				() => {
					button.setAttribute("aria-label", "Copying is not available here");
				},
			);
		});
	}
}

function trackCurrentSection(): void {
	const links = new Map<string, HTMLAnchorElement>();
	for (const a of document.querySelectorAll<HTMLAnchorElement>(".site-nav a[href^='#']")) {
		links.set(a.hash.slice(1), a);
	}
	const observer = new IntersectionObserver(
		(entries) => {
			for (const e of entries) {
				const link = links.get(e.target.id);
				if (link !== undefined && e.isIntersecting) {
					for (const l of links.values()) {
						l.removeAttribute("aria-current");
					}
					link.setAttribute("aria-current", "true");
				}
			}
		},
		{ rootMargin: "-45% 0px -50% 0px" },
	);
	for (const id of links.keys()) {
		const section = document.getElementById(id);
		if (section !== null) {
			observer.observe(section);
		}
	}
}

function loadDemoWhenNear(): void {
	const root = document.querySelector<HTMLElement>("[data-demo]");
	if (root === null) {
		return;
	}
	let started = false;
	const start = () => {
		if (started) {
			return;
		}
		started = true;
		observer.disconnect();
		import("./demo/main.ts")
			.then((demo) => demo.start(root))
			.catch((err: unknown) => {
				const status = root.querySelector("[data-demo-status]");
				if (status !== null) {
					status.textContent = `The live demo could not start: ${String(err)}`;
				}
			});
	};
	const observer = new IntersectionObserver(
		(entries) => {
			if (entries.some((e) => e.isIntersecting)) {
				start();
			}
		},
		{ rootMargin: "320px 0px" },
	);
	observer.observe(root);
	root.addEventListener("pointerenter", start, { once: true });
	root.addEventListener("focusin", start, { once: true });
}

wireCopyButtons();
syncPackageManagers();
trackCurrentSection();
loadDemoWhenNear();
