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

// This file has no upstream counterpart. It stands in for `retry.Do` from
// github.com/avast/retry-go/v4 (v4.7.0, the version Tessera pins), which mirror.go calls with
// no options, so its defaults are what this reproduces: up to 10 attempts, and between them a
// delay of 100ms doubled after every attempt plus up to 100ms of random jitter
// (`CombineDelay(BackOffDelay, RandomDelay)`). Like ADR-0073's backoff for migrate, it is a
// reimplementation of a third-party library's documented behaviour, not a port of its code.
// See docs/decisions/0173-mirror-port.md.

import { errorAs, errorIs } from "../internal/gostd/errors.ts";
import { sleep } from "../internal/gostd/sync.ts";

/** RetryOptions overrides retry-go's defaults, which retry uses when they are omitted. */
export interface RetryOptions {
	/** attempts is the number of times fn is called at most. Defaults to 10. */
	readonly attempts?: number;
	/** delayMs is the delay after the first failure, doubled after each further one. Defaults to 100. */
	readonly delayMs?: number;
	/** maxJitterMs bounds the random delay added to each wait. Defaults to 100. */
	readonly maxJitterMs?: number;
	/**
	 * retryIf decides whether an error is worth another attempt. Defaults to retry-go's
	 * `IsRecoverable`: every error except one marked with {@link unrecoverable}.
	 */
	readonly retryIf?: (err: unknown) => boolean;
	/** signal aborts the waits between attempts. */
	readonly signal?: AbortSignal;
}

/**
 * RetryError is what retry throws once every attempt has failed: the port of retry-go's
 * `Error` (a `[]error`), with the same message, and the same `Is`, which matches if any
 * attempt's error does.
 */
export class RetryError extends Error {
	/** errors holds the error of each attempt, in order. */
	readonly errors: readonly unknown[];

	constructor(errors: readonly unknown[]) {
		const lines = errors.map((e, i) => `#${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
		super(`All attempts fail:\n${lines.join("\n")}`);
		this.name = "RetryError";
		this.errors = errors;
	}

	/** is lets errorIs match any attempt's error, as retry-go's `Error.Is` does. */
	is(target: unknown): boolean {
		return this.errors.some((e) => errorIs(e, target));
	}
}

/** UnrecoverableError marks an error that no further attempt can fix. */
class UnrecoverableError extends Error {
	constructor(err: unknown) {
		super(err instanceof Error ? err.message : String(err), { cause: err });
		this.name = "UnrecoverableError";
	}
}

/**
 * unrecoverable marks err as one retry must not retry, the counterpart of retry-go's
 * `retry.Unrecoverable`: a verification failure, say, which would only fail again.
 */
export function unrecoverable(err: unknown): Error {
	return new UnrecoverableError(err);
}

/** isRecoverable reports whether err was not marked with unrecoverable, like retry-go's `IsRecoverable`. */
export function isRecoverable(err: unknown): boolean {
	return errorAs(err, UnrecoverableError) === undefined;
}

/** retry calls fn until it succeeds or the attempts run out, waiting between attempts. */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
	const attempts = options.attempts ?? 10;
	const delayMs = options.delayMs ?? 100;
	const maxJitterMs = options.maxJitterMs ?? 100;
	const errors: unknown[] = [];
	for (let n = 0; ; n++) {
		try {
			return await fn();
		} catch (err) {
			// retry-go records an unrecoverable error unwrapped, stops at once for an error
			// retryIf rejects, and does not wait after the last attempt.
			errors.push(err instanceof UnrecoverableError ? err.cause : err);
			if (!(options.retryIf ?? isRecoverable)(err) || n === attempts - 1) {
				throw new RetryError(errors);
			}
		}
		try {
			await sleep(delayMs * 2 ** n + Math.random() * maxJitterMs, options.signal);
		} catch (err) {
			throw new RetryError([...errors, err]);
		}
	}
}
