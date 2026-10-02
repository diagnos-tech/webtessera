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

// This file is not a port of a Tessera file. It stands in for the parts of Go's
// standard library that the port relies on and TypeScript does not provide:
// `errors.Is`, `errors.As`, `fmt.Errorf("%w")` wrapping, and the `os.ErrNotExist`
// sentinel that several Tessera interfaces are specified in terms of.
//
// Port note: Go returns errors, TypeScript throws them. Upstream's
// `return nil, fmt.Errorf(...)` becomes `throw new Error(...)` carrying the same
// message text, because upstream tests assert on message content.

/**
 * SentinelError is the class used for Go's package-level `var ErrFoo = errors.New(...)`
 * values. Identity is what matters: `errorIs` compares by reference, exactly as
 * `errors.Is` does for sentinels.
 */
export class SentinelError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "SentinelError";
	}
}

/**
 * ErrNotExist stands in for `os.ErrNotExist`.
 *
 * Several Tessera interfaces are specified in terms of it — e.g. `LogReader.readCheckpoint`
 * must report this when no checkpoint is available, and drivers must report it for absent
 * tiles and entry bundles. Callers check for it with `errorIs(e, ErrNotExist)`.
 */
export const ErrNotExist = new SentinelError("file does not exist");

/**
 * wrapError is the equivalent of `fmt.Errorf("...: %w", err)`.
 *
 * The returned error carries `cause`, which is the chain `errorIs` and `errorAs` walk.
 * The message is formatted as Go's `%w` would render it: the wrapping text, then the
 * wrapped error's message.
 */
export function wrapError(message: string, cause: unknown): Error {
	const causeMessage = cause instanceof Error ? cause.message : String(cause);
	return new Error(`${message}: ${causeMessage}`, { cause });
}

/**
 * errorIs reports whether any error in err's chain matches target, mirroring `errors.Is`.
 *
 * The chain is `err` followed by the errors obtained by repeatedly reading `cause`. An
 * error matches target if it is identical to it, or if it implements `is(target)` and that
 * returns true — the equivalent of Go's optional `Is(error) bool` method.
 */
export function errorIs(err: unknown, target: unknown): boolean {
	if (target === undefined || target === null) {
		return err === target;
	}
	// Guard against cycles in a hand-built cause chain; Go's errors.Is has the same
	// hazard and simply documents it, but an infinite loop in a browser tab is worse
	// than a bounded one.
	const seen = new Set<unknown>();
	let current: unknown = err;
	while (current !== undefined && current !== null && !seen.has(current)) {
		if (current === target) {
			return true;
		}
		seen.add(current);
		const maybeIs: ((t: unknown) => boolean) | undefined = (current as { is?: (t: unknown) => boolean }).is;
		if (typeof maybeIs === "function" && maybeIs.call(current, target)) {
			return true;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/**
 * errorAs finds the first error in err's chain that is an instance of ctor and returns it,
 * or undefined if there is none. It mirrors `errors.As`.
 */
export function errorAs<T extends Error>(err: unknown, ctor: new (...args: never[]) => T): T | undefined {
	const seen = new Set<unknown>();
	let current: unknown = err;
	while (current !== undefined && current !== null && !seen.has(current)) {
		if (current instanceof ctor) {
			return current;
		}
		seen.add(current);
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

/**
 * throwIfAborted reports a cancelled `AbortSignal` the way a Go function returns
 * `ctx.Err()`. Ports call this at the points where upstream checks `ctx.Done()`.
 */
export function throwIfAborted(signal?: AbortSignal): void {
	signal?.throwIfAborted();
}

/**
 * JoinError is what joinErrors returns for more than zero non-nullish errors, mirroring
 * the unexported `*joinError` that `errors.Join` returns in Go.
 */
export class JoinError extends Error {
	/** errors is the list this error joins, mirroring Go's `Unwrap() []error`. */
	readonly errors: readonly unknown[];

	constructor(errors: readonly unknown[]) {
		super(errors.map((e) => (e instanceof Error ? e.message : String(e))).join("\n"));
		this.name = "JoinError";
		this.errors = errors;
	}
}

/**
 * joinErrors mirrors `errors.Join`: it returns an error that wraps the given errors, or
 * undefined if every one of them is undefined/null (Go's nil). The message is the
 * concatenation of each wrapped error's message, one per line, exactly as Go's
 * `(*joinError).Error` builds it.
 */
export function joinErrors(errs: readonly unknown[]): Error | undefined {
	const filtered = errs.filter((e) => e !== undefined && e !== null);
	if (filtered.length === 0) {
		return undefined;
	}
	return new JoinError(filtered);
}
