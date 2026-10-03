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

// Tests for runtime detection. Each fake global object below carries the globals that the
// runtime it stands for really defines (and that matter to detectRuntime), including the
// misleading ones: Bun, Deno and workerd under nodejs_compat all define a Node-like
// `process`, and Node running jsdom defines `window` and `document`. The real runtimes
// are checked by the Chromium (*_browser_test.ts) and workerd (*_workers_test.ts) suites,
// and by scripts/smoke-runtimes.mjs on Node, Bun and Deno.

import { describe, expect, it } from "vitest";
import { assertServerRuntime, detectRuntime, isPublicRuntime, type RuntimeKind, ServerOnlyMessage } from "./runtime.ts";

class WorkerGlobalScope {}
class DedicatedWorkerGlobalScope extends WorkerGlobalScope {
	readonly WorkerGlobalScope = WorkerGlobalScope;
	importScripts(): void {}
	readonly navigator = { userAgent: "Mozilla/5.0" };
}
class ServiceWorkerGlobalScope extends WorkerGlobalScope {
	readonly WorkerGlobalScope = WorkerGlobalScope;
	importScripts(): void {}
}

const nodeProcess = { versions: { node: "22.22.0" }, release: { name: "node" } };
const windowLike = (): object => {
	const w: Record<string, unknown> = { document: {}, navigator: { userAgent: "Mozilla/5.0" } };
	w.window = w;
	return w;
};

const cases: { name: string; g: object; want: RuntimeKind }[] = [
	{ name: "Node", g: { process: nodeProcess, navigator: { userAgent: "Node.js/22" } }, want: "node" },
	{ name: "Node with jsdom", g: { process: nodeProcess, window: {}, document: {} }, want: "node" },
	{ name: "Deno", g: { Deno: { version: { deno: "2.5.0" } }, process: nodeProcess, navigator: {} }, want: "deno" },
	{ name: "Bun", g: { Bun: { version: "1.3.14" }, process: nodeProcess }, want: "bun" },
	{
		name: "workerd with nodejs_compat",
		g: { navigator: { userAgent: "Cloudflare-Workers" }, process: nodeProcess, WebSocketPair: class {} },
		want: "workerd",
	},
	{ name: "workerd without the navigator global", g: { WebSocketPair: class {} }, want: "workerd" },
	{
		name: "workerd, whose global scope is a WorkerGlobalScope",
		g: Object.assign(new ServiceWorkerGlobalScope(), { WebSocketPair: class {} }),
		want: "workerd",
	},
	{ name: "Vercel Edge Runtime", g: { EdgeRuntime: "edge-runtime" }, want: "edge-light" },
	{ name: "a browser window", g: windowLike(), want: "browser" },
	{ name: "a dedicated worker", g: new DedicatedWorkerGlobalScope(), want: "browser-worker" },
	{ name: "a service worker", g: new ServiceWorkerGlobalScope(), want: "browser-worker" },
	{
		name: "a browser with a polyfilled process",
		g: { ...windowLike(), process: { env: {}, versions: {} } },
		want: "browser",
	},
	{ name: "React Native", g: { navigator: { product: "ReactNative" }, window: {} }, want: "react-native" },
	{ name: "an unknown runtime", g: {}, want: "unknown" },
	{
		name: "a worker-like scope without importScripts",
		g: new (class extends WorkerGlobalScope {
			readonly WorkerGlobalScope = WorkerGlobalScope;
		})(),
		want: "unknown",
	},
];

describe("detectRuntime", () => {
	for (const c of cases) {
		it(`detects ${c.name}`, () => {
			expect(detectRuntime(c.g)).toBe(c.want);
		});
	}

	it("detects this suite's runtime as Node", () => {
		expect(detectRuntime()).toBe("node");
	});
});

describe("assertServerRuntime", () => {
	for (const c of cases) {
		const pub = isPublicRuntime(c.want);
		it(`${pub ? "refuses" : "allows"} ${c.name}`, () => {
			if (pub) {
				expect(() => assertServerRuntime(c.g)).toThrow(ServerOnlyMessage);
			} else {
				expect(() => assertServerRuntime(c.g)).not.toThrow();
			}
		});
	}

	it("says what to do instead", () => {
		expect(() => assertServerRuntime(windowLike())).toThrow(
			/running in a browser window, .*verify receipts with webtessera\/browser .*openBrowserLog and openDeviceKey/,
		);
	});

	it("allows this suite's runtime", () => {
		expect(() => assertServerRuntime()).not.toThrow();
	});
});
