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

import { describe, expect, it } from "vitest";
import {
	ErrNotExist,
	errorAs,
	errorIs,
	JoinError,
	joinErrors,
	SentinelError,
	throwIfAborted,
	wrapError,
} from "./errors.ts";

// errors.ts stands in for errors.Is/As, fmt.Errorf("%w") wrapping and os.ErrNotExist.
// These tests pin the sentinel-identity, chain-walking and cycle-guard behaviour the
// whole port depends on; a subtle bug here surfaces as a mysterious failure elsewhere.
describe("gostd/errors", () => {
	describe("wrapError", () => {
		it("formats the message the way Go's %w renders it", () => {
			const cause = new Error("underlying");
			const err = wrapError("reading checkpoint", cause);
			expect(err.message).toBe("reading checkpoint: underlying");
			expect(err.cause).toBe(cause);
		});

		it("stringifies a non-Error cause", () => {
			const err = wrapError("wrapping", "a plain string");
			expect(err.message).toBe("wrapping: a plain string");
		});
	});

	describe("errorIs", () => {
		it("matches a sentinel by reference", () => {
			expect(errorIs(ErrNotExist, ErrNotExist)).toBe(true);
			expect(errorIs(new Error("nope"), ErrNotExist)).toBe(false);
		});

		it("walks the cause chain, like errors.Is walks the wrap chain", () => {
			const wrapped = wrapError("layer two", wrapError("layer one", ErrNotExist));
			expect(errorIs(wrapped, ErrNotExist)).toBe(true);
		});

		it("honours an optional is() method, like Go's Is(error) bool", () => {
			class KindError extends Error {
				readonly kind: string;
				constructor(kind: string) {
					super(kind);
					this.kind = kind;
				}
				is(target: unknown): boolean {
					return target instanceof KindError && target.kind === this.kind;
				}
			}
			const a = new KindError("pushback");
			const b = new KindError("pushback");
			// Distinct instances, but is() reports them equal.
			expect(a).not.toBe(b);
			expect(errorIs(a, b)).toBe(true);
			expect(errorIs(a, new KindError("other"))).toBe(false);
		});

		it("treats a nil/undefined target the way Go does", () => {
			expect(errorIs(undefined, undefined)).toBe(true);
			expect(errorIs(null, null)).toBe(true);
			expect(errorIs(new Error("x"), undefined)).toBe(false);
			expect(errorIs(undefined, ErrNotExist)).toBe(false);
		});

		it("terminates on a cyclic cause chain instead of looping forever", () => {
			const a = new Error("a");
			const b = new Error("b");
			(a as { cause?: unknown }).cause = b;
			(b as { cause?: unknown }).cause = a;
			expect(errorIs(a, ErrNotExist)).toBe(false);
			expect(errorIs(a, b)).toBe(true);
		});

		it("finds a target among the errors a JoinError joins, like errors.Is on Unwrap() []error", () => {
			const a = new SentinelError("a");
			const b = new SentinelError("b");
			const joined = joinErrors([a, b]);
			expect(errorIs(joined, a)).toBe(true);
			expect(errorIs(joined, b)).toBe(true);
			expect(errorIs(joined, new SentinelError("c"))).toBe(false);
		});

		it("finds a joined target through a wrapping error's cause", () => {
			const a = new SentinelError("a");
			const b = new SentinelError("b");
			const wrapped = wrapError("context", joinErrors([a, b]));
			expect(errorIs(wrapped, b)).toBe(true);
		});

		it("finds a target joined at any depth", () => {
			const target = new SentinelError("target");
			const inner = joinErrors([new Error("x"), wrapError("deep", target)]);
			const outer = joinErrors([new Error("y"), wrapError("middle", inner)]);
			expect(errorIs(outer, target)).toBe(true);
		});

		it("honours is() on an error that was joined", () => {
			class KindError extends Error {
				is(target: unknown): boolean {
					return target === ErrNotExist;
				}
			}
			expect(errorIs(joinErrors([new Error("x"), new KindError("k")]), ErrNotExist)).toBe(true);
		});

		it("visits err, then each joined error depth-first and in order, as errors.Is does", () => {
			const visited: string[] = [];
			class Probe extends Error {
				constructor(name: string, options?: { cause?: unknown }) {
					super(name, options);
					this.name = name;
				}
				is(): boolean {
					visited.push(this.name);
					return false;
				}
			}
			const first = new Probe("first", { cause: new Probe("first-cause") });
			const second = new Probe("second");
			const root = new Probe("root", { cause: new JoinError([first, second]) });
			expect(errorIs(root, ErrNotExist)).toBe(false);
			expect(visited).toEqual(["root", "first", "first-cause", "second"]);
		});

		it("terminates on a cycle that runs through a JoinError", () => {
			const a = new Error("a");
			const b = new Error("b");
			const joined = joinErrors([a, b]);
			(a as { cause?: unknown }).cause = joined;
			expect(errorIs(joined, ErrNotExist)).toBe(false);
			expect(errorIs(joined, b)).toBe(true);
		});

		it("does not look inside an ordinary error's own errors property", () => {
			const target = new SentinelError("target");
			const err = Object.assign(new Error("not a join"), { errors: [target] });
			expect(errorIs(err, target)).toBe(false);
		});
	});

	describe("errorAs", () => {
		it("finds the first error of the given class in the chain", () => {
			const notExist = ErrNotExist;
			const wrapped = wrapError("context", notExist);
			const got = errorAs(wrapped, SentinelError);
			expect(got).toBe(notExist);
		});

		it("returns undefined when no error in the chain matches", () => {
			expect(errorAs(wrapError("context", new Error("plain")), SentinelError)).toBeUndefined();
			expect(errorAs(undefined, SentinelError)).toBeUndefined();
		});

		it("terminates on a cyclic cause chain", () => {
			const a = new Error("a");
			const b = new Error("b");
			(a as { cause?: unknown }).cause = b;
			(b as { cause?: unknown }).cause = a;
			expect(errorAs(a, SentinelError)).toBeUndefined();
		});

		it("finds an error of the class among the errors a JoinError joins", () => {
			class E1 extends Error {}
			const e1 = new E1("e1");
			expect(errorAs(joinErrors([e1]), E1)).toBe(e1);
			expect(errorAs(joinErrors([new Error("plain"), e1]), E1)).toBe(e1);
			expect(errorAs(wrapError("context", joinErrors([new Error("plain"), e1])), E1)).toBe(e1);
		});

		it("returns the first match in depth-first order", () => {
			class E1 extends Error {}
			const deep = new E1("deep");
			const later = new E1("later");
			const tree = joinErrors([wrapError("a", joinErrors([new Error("x"), deep])), later]);
			expect(errorAs(tree, E1)).toBe(deep);
		});

		it("matches the JoinError itself before looking inside it", () => {
			const joined = joinErrors([new SentinelError("inside")]);
			expect(errorAs(joined, JoinError)).toBe(joined);
		});

		it("terminates on a cycle that runs through a JoinError", () => {
			const a = new Error("a");
			const joined = joinErrors([a]);
			(a as { cause?: unknown }).cause = joined;
			expect(errorAs(joined, SentinelError)).toBeUndefined();
		});
	});

	describe("joinErrors", () => {
		it("returns undefined for no errors, mirroring errors.Join()", () => {
			expect(joinErrors([])).toBeUndefined();
		});

		it("returns undefined when every error is nullish, mirroring Go's nil filtering", () => {
			expect(joinErrors([undefined, null, undefined])).toBeUndefined();
		});

		it("joins messages with a newline between each, like (*joinError).Error", () => {
			const err = joinErrors([new Error("first"), new Error("second")]);
			expect(err?.message).toBe("first\nsecond");
			expect(err).toBeInstanceOf(JoinError);
		});

		it("carries the filtered errors for Unwrap()-style access", () => {
			const a = new Error("a");
			const b = new Error("b");
			const err = joinErrors([undefined, a, null, b]) as JoinError;
			expect(err.errors).toEqual([a, b]);
		});

		it("stringifies a non-Error entry", () => {
			const err = joinErrors(["plain string", new Error("real")]);
			expect(err?.message).toBe("plain string\nreal");
		});

		it("wraps a single error that does not itself wrap several, as Go 1.25.5 does", () => {
			const a = new Error("only");
			const err = joinErrors([a]) as JoinError;
			expect(err).toBeInstanceOf(JoinError);
			expect(err.errors).toEqual([a]);
			expect(err.message).toBe("only");
		});

		it("returns a single JoinError unchanged instead of wrapping it again (Go 1.25)", () => {
			const joined = joinErrors([new Error("a"), new Error("b")]);
			expect(joinErrors([joined])).toBe(joined);
			expect(joinErrors([undefined, joined, null])).toBe(joined);
		});

		it("still wraps a JoinError that is joined with another error", () => {
			const joined = joinErrors([new Error("a"), new Error("b")]);
			const other = new Error("c");
			const err = joinErrors([joined, other]) as JoinError;
			expect(err).not.toBe(joined);
			expect(err.errors).toEqual([joined, other]);
			expect(err.message).toBe("a\nb\nc");
		});
	});

	describe("throwIfAborted", () => {
		it("does nothing for an absent or live signal", () => {
			expect(() => throwIfAborted()).not.toThrow();
			expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
		});

		it("throws the abort reason once the signal is aborted", () => {
			const ctrl = new AbortController();
			ctrl.abort(new Error("cancelled"));
			expect(() => throwIfAborted(ctrl.signal)).toThrow("cancelled");
		});
	});
});
