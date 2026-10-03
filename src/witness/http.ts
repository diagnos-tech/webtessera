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

// This file has no upstream counterpart. It maps the tlog-witness HTTP interface
// (https://c2sp.org/tlog-witness) onto WitnessServer. See docs/decisions/0171-witness-server.md.

import { corsConfig, preflight, withCors } from "../http/cors.ts";
import {
	errorText,
	type Handler,
	methodNotAllowed,
	normalizePrefix,
	readBodyCapped,
	textResponse,
} from "../http/handler.ts";
import { errorIs } from "../internal/gostd/errors.ts";
import {
	ErrInvalidProof,
	ErrMalformedRequest,
	ErrNoValidSignature,
	ErrRootMismatch,
	ErrUnknownLog,
	OldSizeMismatchError,
} from "./errors.ts";
import { parseAddCheckpointRequest } from "./request.ts";
import type { WitnessServer, WitnessServerOptions } from "./server.ts";

/**
 * DefaultMaxBodyBytes is the default cap on add-checkpoint request bodies, as in the Go
 * witness: "16 should be more than enough, even in a PQ world."
 *
 * @internal
 */
export const DefaultMaxBodyBytes = 16 << 10;

// maxErrorBodyChars bounds a refusal's response body, whatever its message.
const maxErrorBodyChars = 512;

/** TlogSizeContentType is the media type of the 409 response that carries the latest size. */
const tlogSizeContentType = "text/x.tlog.size";

const monitoringPath = /^([0-9a-f]{64})\/checkpoint$/;

/**
 * newWitnessHandler returns the HTTP face of a WitnessServer.
 *
 * @internal Use WitnessServer.handle.
 */
export function newWitnessHandler(
	w: WitnessServer,
	options: Pick<WitnessServerOptions, "prefix" | "monitoringPrefix" | "maxBodyBytes" | "cors" | "onError">,
): Handler {
	const addPath = `${normalizePrefix(options.prefix)}add-checkpoint`;
	const monitoring =
		options.monitoringPrefix === false ? undefined : normalizePrefix(options.monitoringPrefix ?? options.prefix);
	const maxBodyBytes = options.maxBodyBytes ?? DefaultMaxBodyBytes;
	const cors = corsConfig(options.cors, []);

	return async (request: Request): Promise<Response | undefined> => {
		const path = new URL(request.url).pathname;
		if (path === addPath) {
			if (request.method === "OPTIONS" && cors !== undefined) {
				return preflight(request, cors, "POST");
			}
			// "The request MUST be an HTTP POST."
			if (request.method !== "POST") {
				return withCors(methodNotAllowed("POST"), cors);
			}
			return withCors(await addCheckpoint(w, request, maxBodyBytes, options.onError), cors);
		}
		if (monitoring !== undefined && path.startsWith(monitoring)) {
			const m = monitoringPath.exec(path.slice(monitoring.length));
			if (m?.[1] === undefined) {
				return undefined;
			}
			if (request.method === "OPTIONS" && cors !== undefined) {
				return preflight(request, cors, "GET, HEAD");
			}
			// "The request MUST be an HTTP GET." HEAD is the same request without the body.
			if (request.method !== "GET" && request.method !== "HEAD") {
				return withCors(methodNotAllowed("GET, HEAD"), cors);
			}
			return withCors(await latestCheckpoint(w, m[1], request, options.onError), cors);
		}
		return undefined;
	};
}

async function addCheckpoint(
	w: WitnessServer,
	request: Request,
	maxBodyBytes: number,
	onError: WitnessServerOptions["onError"],
): Promise<Response> {
	const body = await readBodyCapped(request, maxBodyBytes);
	if (body === undefined) {
		return textResponse(413, `request body exceeds ${maxBodyBytes} bytes`);
	}
	try {
		const signatures = await w.addCheckpoint(parseAddCheckpointRequest(body), request.signal);
		return new Response(signatures as BodyInit, {
			status: 200,
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
	} catch (err) {
		return refusal(err) ?? failure(err, request, onError);
	}
}

/** refusal maps a protocol refusal onto the status the spec assigns it, or returns undefined. */
function refusal(err: unknown): Response | undefined {
	if (err instanceof OldSizeMismatchError) {
		// "The response body MUST consist of the tree size of the latest cosigned checkpoint
		// in decimal, followed by a newline (U+000A). The response MUST have a Content-Type of
		// text/x.tlog.size."
		return new Response(`${err.latestSize}\n`, { status: 409, headers: { "Content-Type": tlogSizeContentType } });
	}
	const statuses: [unknown, number][] = [
		[ErrMalformedRequest, 400],
		[ErrNoValidSignature, 403],
		[ErrUnknownLog, 404],
		[ErrRootMismatch, 409],
		[ErrInvalidProof, 422],
	];
	for (const [sentinel, status] of statuses) {
		if (errorIs(err, sentinel)) {
			return textResponse(status, errorText(err).slice(0, maxErrorBodyChars));
		}
	}
	return undefined;
}

async function latestCheckpoint(
	w: WitnessServer,
	hash: string,
	request: Request,
	onError: WitnessServerOptions["onError"],
): Promise<Response> {
	let cp: Uint8Array | undefined;
	try {
		cp = await w._latestByHash(hash);
	} catch (err) {
		return failure(err, request, onError);
	}
	// "If the witness has never cosigned a checkpoint for that log, it MUST respond with a
	// "404 Not Found" HTTP status code instead."
	if (cp === undefined) {
		return textResponse(404, "not found");
	}
	const headers = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" };
	if (request.method === "HEAD") {
		return new Response(null, { status: 200, headers: { ...headers, "Content-Length": String(cp.length) } });
	}
	return new Response(cp as BodyInit, { status: 200, headers });
}

function failure(err: unknown, request: Request, onError: WitnessServerOptions["onError"]): Response {
	// A request the client abandoned is not a witness failure worth reporting.
	if (!request.signal.aborted) {
		onError?.(err, request);
	}
	return textResponse(500, "internal server error");
}
