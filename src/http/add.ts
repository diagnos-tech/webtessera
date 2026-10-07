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

// This file has no upstream counterpart. It reproduces, as two response builders, the answer
// Tessera's own personalities give to `POST /add` (tessera/cmd/conformance/*/main.go), so that
// upstream tooling such as the hammer load tester can drive a webtessera log unmodified.
// tlog-tiles specifies only the read API; how entries get in is each personality's business,
// which is why this module offers the answer and not the endpoint.
// See docs/decisions/0170-http-log-handler.md.

import { errorIs, SentinelError } from "../internal/gostd/errors.ts";
import { ErrPushback } from "../log.ts";
import { errorText, methodNotAllowed, positiveInteger, readBodyCapped, textResponse } from "./handler.ts";

/**
 * MaxEntryBytes is the largest entry a tlog-tiles log can hold: entry bundles prefix each
 * entry with its length as a big-endian uint16, which a larger entry would overflow.
 */
export const MaxEntryBytes = 0xffff;

/**
 * ErrMethodNotAllowed is the cause of the error readEntryBody throws for a request that is
 * not a POST. addErrorResponse answers it with 405 Method Not Allowed and `Allow: POST`.
 *
 * ```ts
 * if (errorIs(err, ErrMethodNotAllowed)) { … }
 * ```
 */
export const ErrMethodNotAllowed = new SentinelError("method not allowed");

/**
 * readEntryBody reads the entry a `POST /add` request carries, streaming it and giving up as
 * soon as it exceeds maxBytes (MaxEntryBytes by default, and never more), so that an
 * oversized upload is never buffered. It resolves to undefined when the entry is too large;
 * answer that with 413. It throws a RangeError if maxBytes is not a positive integer.
 *
 * It refuses any request that is not a POST, throwing an error caused by
 * ErrMethodNotAllowed, which addErrorResponse answers with 405: a GET, HEAD or OPTIONS
 * request carries no entry, and treating one as an empty entry would let crawlers, link
 * previews and prefetchers write to the log. Answer a CORS preflight (OPTIONS) before
 * calling it.
 *
 * ```ts
 * if (request.method !== "POST") {
 *   return new Response("method not allowed\n", { status: 405, headers: { Allow: "POST" } });
 * }
 * try {
 *   const entry = await readEntryBody(request);
 *   if (entry === undefined) {
 *     return new Response("entry too large\n", { status: 413 });
 *   }
 *   return addResponse(await appender.add(newEntry(entry))());
 * } catch (err) {
 *   return addErrorResponse(err); // 405 for a method readEntryBody refused, 503 for pushback
 * }
 * ```
 */
export async function readEntryBody(
	request: Request,
	maxBytes: number = MaxEntryBytes,
): Promise<Uint8Array | undefined> {
	const max = Math.min(positiveInteger("readEntryBody: maxBytes", maxBytes), MaxEntryBytes);
	if (request.method !== "POST") {
		throw new Error(
			"readEntryBody: only a POST request carries an entry, as its body; answer other methods with 405 Method " +
				"Not Allowed",
			{ cause: ErrMethodNotAllowed },
		);
	}
	return readBodyCapped(request, max);
}

/**
 * addResponse is the conventional successful answer to `POST /add`: 200 OK with the
 * assigned index as a bare decimal and no trailing newline, which is what upstream's
 * personalities write with `fmt.Fprintf(w, "%d", idx.Index)`.
 *
 * ```ts
 * const index = await appender.add(newEntry(body))();
 * return addResponse(index);
 * ```
 */
export function addResponse(index: bigint | { readonly index: bigint }): Response {
	const i = typeof index === "bigint" ? index : index.index;
	return new Response(i.toString(), { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/** AddErrorResponseOptions configures addErrorResponse. */
export interface AddErrorResponseOptions {
	/**
	 * detail sends the error's own text as the body of a 500 response, as upstream's
	 * personalities do. It is off by default: the text of a storage or network error can
	 * name files, hosts, tables or keys, which the client has no business seeing. Log the
	 * error yourself either way.
	 */
	readonly detail?: boolean;
}

/**
 * addErrorResponse is the conventional failed answer to `POST /add`: 503 Service
 * Unavailable with `Retry-After: 1` when the appender pushes back (`ErrPushback`, which
 * tells the client to slow down rather than give up), as upstream's personalities answer,
 * 405 Method Not Allowed with `Allow: POST` when readEntryBody refused a request that was
 * not a POST (`ErrMethodNotAllowed`), and 500 otherwise.
 *
 * The body of a 500 says only that the log failed, unless options.detail is set, in which
 * case it is the error's text, as upstream sends it. The error itself is the caller's to
 * log:
 *
 * ```ts
 * } catch (err) {
 *   console.error("add failed", err);
 *   return addErrorResponse(err);
 * }
 * ```
 */
export function addErrorResponse(err: unknown, options: AddErrorResponseOptions = {}): Response {
	if (errorIs(err, ErrPushback)) {
		return textResponse(503, "the log is overloaded; retry later", { "Retry-After": "1" });
	}
	if (errorIs(err, ErrMethodNotAllowed)) {
		return methodNotAllowed("POST");
	}
	if (options.detail === true) {
		return new Response(errorText(err), { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
	}
	return textResponse(500, "internal server error");
}
