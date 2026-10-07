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

/**
 * webtessera/server holds signing keys and must not be bundled for the browser; use
 * webtessera/browser.
 *
 * This module is what `webtessera/server` resolves to when a bundler builds for browsers
 * (the `browser` or `react-native` export condition, which Vite, webpack, esbuild, Rollup,
 * Parcel and Bun apply to browser builds). It exports nothing, so a named import from
 * `webtessera/server` fails the build, and it throws as soon as it is evaluated, so a bare
 * import fails the page. Server and edge builds (Node, Deno, Bun, `workerd` for
 * Cloudflare Workers, `edge-light` for Vercel) resolve the real module instead.
 *
 * Its file name is the explanation: a bundler cannot run code at build time, but every one
 * of them names the file that lacks the export, so the error a browser build stops with,
 * such as `"openServerLog" is not exported by
 * ".../webtessera/dist/server/NOT-FOR-BROWSERS--use-webtessera-browser.js"`, says what is
 * wrong and what to do.
 *
 * In the browser, use webtessera/browser: it keeps a log of the device's own, signed by a
 * key that cannot be exported, and verifies receipts from any log.
 *
 * See docs/decisions/0221-guard-the-server-entry-point.md.
 *
 * @module
 */

import { WebtesseraError } from "../safe/errors.ts";

// The text is ServerOnlyMessage from src/safe/runtime.ts, repeated so that this module
// imports nothing but the error class (which imports nothing); server_test.ts checks that
// the two agree.
throw new WebtesseraError(
	"WRONG_ENVIRONMENT",
	"webtessera/server holds signing keys and must not be bundled for the browser; use webtessera/browser",
);

// An explicit, empty export list: without it esbuild takes a module with no exports for one
// whose exports it cannot know, and only warns that a named import "will always be
// undefined", where with it every bundler fails the build. server_test.ts checks it is here.
// biome-ignore lint/complexity/noUselessEmptyExport: it changes esbuild's verdict, as above.
export {};
