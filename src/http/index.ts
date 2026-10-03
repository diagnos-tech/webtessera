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
 * webtessera/http serves a transparency log over HTTP, as the C2SP tlog-tiles read API
 * (https://c2sp.org/tlog-tiles) specifies it, from any `LogReader`.
 *
 * It has no Tessera counterpart: upstream leaves serving to each personality, and its
 * conformance servers each carry a copy of the same routing (see
 * docs/decisions/0170-http-log-handler.md). Here the routing is one fetch-style
 * {@link Handler} that runs unchanged wherever the Fetch API's `Request` and `Response`
 * do.
 *
 * # Serving a log
 *
 * ```ts
 * const { reader } = await newAppender(driver, opts);
 * const log = newLogHandler({ reader, cors: true });
 * ```
 *
 * A Handler resolves to undefined for requests that are not its own, so handlers compose
 * with each other and with an application's routes. {@link combineHandlers} turns a list of
 * them into the `(request) => Promise<Response>` every runtime expects, answering 404 when
 * none matches:
 *
 * ```ts
 * const serve = combineHandlers(log, witness.handle);
 *
 * Deno.serve(serve);                                   // Deno
 * Bun.serve({ fetch: serve });                         // Bun
 * export default { fetch: serve };                     // Cloudflare Workers, and other
 *                                                      // runtimes with the same module shape
 * createServer(toNodeListener(serve)).listen(8080);    // Node, with node:http's createServer
 * ```
 *
 * In a service worker, which must answer every request it intercepts, fall back to the
 * network:
 *
 * ```ts
 * self.addEventListener("fetch", (event) => {
 *   event.respondWith(log(event.request).then((r) => r ?? fetch(event.request)));
 * });
 * ```
 *
 * # What the handler guarantees
 *
 *   - `GET` and `HEAD` on `checkpoint`, `tile/<L>/<N>[.p/<W>]` and `tile/entries/<N>[.p/<W>]`
 *     under an optional mount prefix, with the spec's content types, long-lived immutable
 *     caching for full tiles and bundles and short caching for the checkpoint and partials
 *     ({@link DefaultCacheControl}), an `ETag`, and opt-in CORS.
 *   - Only canonical paths: 400 with the canonical spelling for anything else under `tile/`.
 *   - 404 when the reader throws `ErrNotExist`, 405 for other methods, never a redirect.
 *   - A partial tile or bundle is exactly as wide as its path says, even when the reader
 *     substitutes the full resource for a garbage-collected partial.
 *
 * Entry bundles "SHOULD be compressed at the HTTP layer"; that is left to the runtime or a
 * CDN in front of it (Deno, Bun and most edge platforms compress automatically; behind
 * Node, use a reverse proxy).
 *
 * # Writing
 *
 * tlog-tiles specifies no write API, and adding entries is the personality's business. The
 * convention Tessera's personalities follow, and its tooling expects, is `POST /add` with
 * the entry as the body, answered by the assigned index as a bare decimal;
 * {@link addResponse} and {@link addErrorResponse} produce exactly those answers, and
 * {@link readEntryBody} reads the entry while capping it at the 65535 bytes an entry bundle
 * can hold, so that an oversized upload is refused while it streams rather than buffered.
 *
 * @module
 */

export { addErrorResponse, addResponse, MaxEntryBytes, readEntryBody } from "./add.ts";
export type { CorsOptions } from "./cors.ts";
export { combineHandlers, type Handler } from "./handler.ts";
export { type LogHandlerOptions, type LogResourceReader, newLogHandler } from "./log_handler.ts";
export {
	type NodeIncomingMessage,
	type NodeListenerOptions,
	type NodeServerResponse,
	toNodeListener,
} from "./node.ts";
export {
	type CacheControlPolicy,
	CheckpointContentType,
	DefaultCacheControl,
	type LogResource,
	type MalformedPath,
	MaxResourcePathLength,
	parseLogPath,
	resourceHeaders,
	resourcePath,
	TileContentType,
} from "./resources.ts";
