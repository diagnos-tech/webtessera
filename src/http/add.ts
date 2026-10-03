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

import { errorIs } from "../internal/gostd/errors.ts";
import { ErrPushback } from "../log.ts";
import { errorText, readBodyCapped, textResponse } from "./handler.ts";

/**
 * MaxEntryBytes is the largest entry a tlog-tiles log can hold: entry bundles prefix each
 * entry with its length as a big-endian uint16, which a larger entry would overflow.
 */
export const MaxEntryBytes = 0xffff;

/**
 * readEntryBody reads the entry a `POST /add` request carries, streaming it and giving up as
 * soon as it exceeds maxBytes (MaxEntryBytes by default), so that an oversized upload is
 * never buffered. It resolves to undefined when the entry is too large; answer that with
 * 413:
 *
 * ```ts
 * const entry = await readEntryBody(request);
 * if (entry === undefined) {
 *   return new Response("entry too large\n", { status: 413 });
 * }
 * try {
 *   return addResponse(await appender.add(newEntry(entry))());
 * } catch (err) {
 *   return addErrorResponse(err);
 * }
 * ```
 */
export function readEntryBody(request: Request, maxBytes: number = MaxEntryBytes): Promise<Uint8Array | undefined> {
	return readBodyCapped(request, Math.min(maxBytes, MaxEntryBytes));
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

/**
 * addErrorResponse is the conventional failed answer to `POST /add`, as upstream's
 * personalities give it: 503 Service Unavailable with `Retry-After: 1` when the appender
 * pushes back (`ErrPushback`, which tells the client to slow down rather than give up), and
 * 500 with the error's text otherwise.
 *
 * The error text is sent to the client as upstream sends it; a personality that considers
 * its errors confidential should answer 500 itself.
 */
export function addErrorResponse(err: unknown): Response {
	if (errorIs(err, ErrPushback)) {
		return textResponse(503, "the log is overloaded; retry later", { "Retry-After": "1" });
	}
	return new Response(errorText(err), { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
