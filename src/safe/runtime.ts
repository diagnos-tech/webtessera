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

// This file has no upstream counterpart. It is part of the safe API layered on top of the
// port (src/safe/, src/server/, src/browser/), and tells the JavaScript runtimes apart so
// that webtessera/server can refuse to run where its keys would be public. See
// docs/decisions/0221-guard-the-server-entry-point.md.

import { WebtesseraError } from "./errors.ts";

/**
 * RuntimeKind names the kind of JavaScript runtime the code is running in.
 *
 *   - `node`, `deno`, `bun`: the server runtimes, identified by their own globals.
 *   - `workerd`: Cloudflare Workers, and anything else built on workerd.
 *   - `edge-light`: Vercel's Edge Runtime.
 *   - `browser`: a browser window or frame (the main thread).
 *   - `browser-worker`: a dedicated, shared or service worker in a browser.
 *   - `react-native`: a React Native app, whose code ships to users' devices.
 *   - `unknown`: none of the above, and nothing that looks like a browser.
 *
 * ```ts
 * const where: RuntimeKind = detectRuntime();
 * ```
 */
export type RuntimeKind =
	| "node"
	| "deno"
	| "bun"
	| "workerd"
	| "edge-light"
	| "browser"
	| "browser-worker"
	| "react-native"
	| "unknown";

/** runtimeGlobals is the part of a global object detectRuntime reads. */
interface runtimeGlobals {
	readonly Deno?: { readonly version?: { readonly deno?: unknown } };
	readonly Bun?: { readonly version?: unknown };
	readonly process?: {
		readonly versions?: { readonly node?: unknown };
		readonly release?: { readonly name?: unknown };
	};
	readonly navigator?: { readonly userAgent?: unknown; readonly product?: unknown };
	readonly WebSocketPair?: unknown;
	readonly EdgeRuntime?: unknown;
	readonly window?: unknown;
	readonly document?: unknown;
	readonly WorkerGlobalScope?: unknown;
	readonly importScripts?: unknown;
}

/**
 * detectRuntime reports which kind of runtime `g` (by default `globalThis`) belongs to.
 *
 * Server runtimes are identified first and positively, by globals that only they define:
 * `Deno.version.deno`, `Bun.version`, Node's `process.release.name`, workerd's
 * `navigator.userAgent` of `Cloudflare-Workers` or its `WebSocketPair` class, and the Edge
 * Runtime's `EdgeRuntime` string. Bun, Deno and workerd (under `nodejs_compat`) all define
 * a Node-like `process` too, so they are checked before Node. Only then is the global
 * object checked for a browser: a window has both `window` and `document`, and a worker's
 * global object is a `WorkerGlobalScope` with `importScripts`. So Node running jsdom, which
 * defines `window` and `document`, is still Node, and workerd, which defines neither and
 * is not a browser worker, is never mistaken for one.
 *
 * ```ts
 * if (detectRuntime() === "browser") {
 *   // a window: use webtessera/browser
 * }
 * ```
 */
export function detectRuntime(g: object = globalThis): RuntimeKind {
	const r = g as runtimeGlobals;
	if (typeof r.Deno?.version?.deno === "string") {
		return "deno";
	}
	if (typeof r.Bun?.version === "string") {
		return "bun";
	}
	if (r.navigator?.userAgent === "Cloudflare-Workers" || typeof r.WebSocketPair === "function") {
		return "workerd";
	}
	if (typeof r.EdgeRuntime === "string") {
		return "edge-light";
	}
	if (typeof r.process?.versions?.node === "string" && r.process.release?.name === "node") {
		return "node";
	}
	if (r.navigator?.product === "ReactNative") {
		return "react-native";
	}
	if (typeof r.window === "object" && r.window !== null && typeof r.document === "object" && r.document !== null) {
		return "browser";
	}
	if (
		typeof r.WorkerGlobalScope === "function" &&
		g instanceof (r.WorkerGlobalScope as abstract new () => unknown) &&
		typeof r.importScripts === "function"
	) {
		return "browser-worker";
	}
	return "unknown";
}

/**
 * isPublicRuntime reports whether code running in a runtime of the given kind runs on its
 * users' devices, where anything it holds, a signing key included, is theirs to read.
 */
export function isPublicRuntime(kind: RuntimeKind): boolean {
	return kind === "browser" || kind === "browser-worker" || kind === "react-native";
}

/**
 * ServerOnlyMessage is the first sentence of the error webtessera/server throws when it
 * finds itself in a browser, or when a bundler resolves it with the `browser` condition.
 */
export const ServerOnlyMessage =
	"webtessera/server holds signing keys and must not be bundled for the browser; use webtessera/browser";

/**
 * assertServerRuntime throws a WebtesseraError with the code `WRONG_ENVIRONMENT` unless the
 * current runtime is a private one: a server, an edge runtime, or an unrecognised runtime
 * that does not look like a browser.
 *
 * @internal Called by webtessera/server at import and by each of its key-holding
 * functions, which a bundler that skips the entry module cannot bypass.
 */
export function assertServerRuntime(g: object = globalThis): void {
	const kind = detectRuntime(g);
	if (isPublicRuntime(kind)) {
		throw new WebtesseraError(
			"WRONG_ENVIRONMENT",
			`${ServerOnlyMessage}. This code is running in a ${describe(kind)}, where a signing key is readable by ` +
				"anyone who loads the page. Keep the log's key on your server, and in the browser either verify " +
				"receipts with webtessera/browser or keep a log of the device's own with openBrowserLog and openDeviceKey.",
		);
	}
}

function describe(kind: RuntimeKind): string {
	switch (kind) {
		case "browser":
			return "browser window";
		case "browser-worker":
			return "browser worker";
		case "react-native":
			return "React Native app";
		default:
			return `${kind} runtime`;
	}
}
