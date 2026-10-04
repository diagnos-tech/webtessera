// Copyright 2025 The Tessera authors. All Rights Reserved.
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
//
// Ported from tessera/append_lifecycle_test.go @ 4a6d9f9

import { describe, expect, it } from "vitest";
import {
	type AddFn,
	Appender,
	type AppenderInit,
	type AppendOptions,
	type Index,
	type IndexFuture,
	memoizeFuture,
	newAppender,
	newAppendOptions,
	WitnessOptions,
} from "./append_lifecycle.ts";
import type { FetchFn } from "./client/fetcher.ts";
import { type Entry, newEntry } from "./entry.ts";
import { fromUTF8, toUTF8 } from "./internal/gostd/bytes.ts";
import { ErrNotExist } from "./internal/gostd/errors.ts";
import { sleep } from "./internal/gostd/sync.ts";
import type { Follower, LogReader } from "./lifecycle.ts";
import { newSignerForCosignatureV1, newVerifierForCosignatureV1 } from "./vendor/formats/note/note_cosigv1.ts";
import {
	generateKey,
	newSigner,
	newVerifier,
	open,
	type Signer,
	sign,
	type Verifier,
	verifierList,
} from "./vendor/note/note.ts";
import { newWitness, newWitnessGroup, WitnessGroup } from "./witness.ts";

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

it("TestMemoize", async () => {
	// Set up an AddFn which will increment a counter every time it's called, and return that in the Index.
	let i = 0n;
	const deleg: IndexFuture = async (): Promise<Index> => {
		i++;
		return { index: i, isDup: false };
	};
	let add = (_e: Entry | null, _signal?: AbortSignal): IndexFuture => {
		return deleg;
	};

	// Create a single future (for a single Entry), and convince ourselves that the counter is being incremented
	// each time the future is being invoked.
	const f1 = add(null);
	const a = await f1();
	const b = await f1();
	expect(a.index, `a(=${a.index}) == b(=${b.index})`).not.toBe(b.index);

	// Now create an AddFn which memoizes the result of the delegate, like we do in newAppender, and assert that
	// repeated calls to the future work as expected; only incrementing the counter once.
	add = (_e: Entry | null, _signal?: AbortSignal): IndexFuture => {
		return memoizeFuture(deleg);
	};
	const f2 = add(null);
	const c = await f2();
	const d = await f2();

	expect(c.index, `c(=${c.index}) != d(=${d.index})`).toBe(d.index);
});

// Port addition: the memoization is a caching wrapper whose whole point is that repeated and
// concurrent callers share a single resolution of the delegate. TestMemoize covers "called twice";
// these pin the two properties the port note on memoizeFuture claims explicitly.
describe("memoizeFuture (port additions)", () => {
	it("calls the delegate at most once across repeated calls", async () => {
		let calls = 0;
		const delegate: IndexFuture = async (): Promise<Index> => {
			calls++;
			return { index: BigInt(calls), isDup: false };
		};
		const f = memoizeFuture(delegate);
		await f();
		await f();
		await f();
		expect(calls).toBe(1);
	});

	it("caches a synchronous throw from the delegate and rethrows it on every call, as sync.OnceValues re-panics", () => {
		let calls = 0;
		const boom = new Error("boom");
		const delegate: IndexFuture = (): Promise<Index> => {
			calls++;
			throw boom;
		};
		const f = memoizeFuture(delegate);
		expect(() => f()).toThrow(boom);
		expect(() => f()).toThrow(boom);
		expect(calls).toBe(1);
	});

	it("gives concurrent callers the same result and calls the delegate once", async () => {
		let calls = 0;
		const delegate: IndexFuture = async (): Promise<Index> => {
			calls++;
			// Yield so both callers are in-flight before the delegate resolves.
			await Promise.resolve();
			return { index: 42n, isDup: false };
		};
		const f = memoizeFuture(delegate);
		const [a, b] = await Promise.all([f(), f()]);
		expect(calls).toBe(1);
		expect(a.index).toBe(42n);
		expect(b.index).toBe(42n);
	});
});

const testSignerKey = "PRIVATE+KEY+example.com/log/testdata+33d7b496+AeymY/SZAX0jZcJ8enZ5FY1Dz+wTML2yWSkK+9DSF3eg";

describe("TestAppendOptionsValid", () => {
	const tests: { name: string; opts: () => AppendOptions; wantErrContains: string }[] = [
		{
			name: "Valid",
			opts: () => newAppendOptions().withCheckpointSigner(mustCreateSigner(testSignerKey)),
			wantErrContains: "",
		},
		{
			name: "Valid: CheckpointRepublishInterval == CheckpointInterval",
			opts: () =>
				newAppendOptions()
					.withCheckpointSigner(mustCreateSigner(testSignerKey))
					.withCheckpointInterval(10_000)
					.withCheckpointRepublishInterval(10_000),
			wantErrContains: "",
		},
		{
			name: "Error: CheckpointRepublishInterval < CheckpointInterval",
			opts: () =>
				newAppendOptions()
					.withCheckpointSigner(mustCreateSigner(testSignerKey))
					.withCheckpointInterval(10_000)
					.withCheckpointRepublishInterval(9_000),
			wantErrContains: "WithCheckpointRepublishInterval",
		},
		{
			name: "Error: No CheckpointSigner",
			opts: () => newAppendOptions(),
			wantErrContains: "WithCheckpointSigner",
		},
	];
	for (const test of tests) {
		it(test.name, () => {
			let err: unknown;
			try {
				test.opts().valid();
			} catch (e) {
				err = e;
			}
			const gotErr = err !== undefined;
			const wantErr = test.wantErrContains !== "";
			if (gotErr && !wantErr) {
				throw new Error(`Got unexpected error ${quoteish(err)}, want no error`);
			}
			if (!gotErr && wantErr) {
				throw new Error("Got no error, expected error");
			}
			if (gotErr) {
				expect(messageOf(err)).toContain(test.wantErrContains);
			}
		});
	}
});

// Port addition: TestAppendOptionsValid only checks that the message contains the option name.
// The port converts its millisecond intervals back to Go's nanosecond time.Duration for `%d`, so
// pin the whole text against what Go prints for the same options.
it("AppendOptions.valid renders intervals as Go's time.Duration nanoseconds (port addition)", () => {
	const o = newAppendOptions()
		.withCheckpointSigner(mustCreateSigner(testSignerKey))
		.withCheckpointInterval(10_000)
		.withCheckpointRepublishInterval(9_000);
	expect(() => o.valid()).toThrow(
		new Error(
			"invalid AppendOptions: WithCheckpointRepublishInterval (9000000000) is smaller than WithCheckpointInterval (10000000000)",
		),
	);
});

// Port addition: the accessors are the contract storage drivers rely on; pin the defaults from
// newAppendOptions and that the with* setters change them.
describe("AppendOptions accessors (port additions)", () => {
	it("returns the documented defaults", () => {
		const o = newAppendOptions();
		expect(o.batchMaxSize()).toBe(256);
		expect(o.batchMaxAge()).toBe(250);
		expect(o.checkpointInterval()).toBe(10_000);
		expect(o.checkpointRepublishInterval()).toBe(600_000);
		expect(o.pushbackMaxOutstanding()).toBe(4096);
		expect(o.garbageCollectionInterval()).toBe(60_000);
	});

	it("with* setters update the accessors", () => {
		const o = newAppendOptions()
			.withBatching(10, 20)
			.withPushback(99)
			.withCheckpointInterval(5_000)
			.withCheckpointRepublishInterval(6_000)
			.withGarbageCollectionInterval(0);
		expect(o.batchMaxSize()).toBe(10);
		expect(o.batchMaxAge()).toBe(20);
		expect(o.pushbackMaxOutstanding()).toBe(99);
		expect(o.checkpointInterval()).toBe(5_000);
		expect(o.checkpointRepublishInterval()).toBe(6_000);
		expect(o.garbageCollectionInterval()).toBe(0);
	});
});

// Port addition: newAppender's decoration order is a stated sharp edge (Go applies addDecorators
// in reverse so decorators[0] is the outermost wrapper). Verify it with a fake driver.
describe("newAppender (port additions)", () => {
	function fakeReader(cp?: Uint8Array): LogReader {
		return {
			readCheckpoint: async (): Promise<Uint8Array> => {
				if (cp === undefined) {
					throw ErrNotExist;
				}
				return cp;
			},
			readTile: async (): Promise<Uint8Array> => new Uint8Array(0),
			readEntryBundle: async (): Promise<Uint8Array> => new Uint8Array(0),
			nextIndex: async (): Promise<bigint> => 0n,
			integratedSize: async (): Promise<bigint> => 0n,
		};
	}

	function fakeDriver(
		rawAdd: AddFn,
		reader: LogReader,
	): { appender(opts: AppendOptions, signal?: AbortSignal): Promise<AppenderInit> } {
		return {
			appender: async (): Promise<AppenderInit> => ({ appender: new Appender(rawAdd), reader }),
		};
	}

	it("applies addDecorators in reverse so decorators[0] is outermost", async () => {
		const order: string[] = [];
		const mkDec =
			(id: string) =>
			(fn: AddFn): AddFn =>
			(entry: Entry, signal?: AbortSignal): IndexFuture => {
				order.push(id);
				return fn(entry, signal);
			};

		const rawAdd: AddFn = (): IndexFuture => async (): Promise<Index> => ({ index: 1n, isDup: false });
		const reader = fakeReader();
		const opts = newAppendOptions().withCheckpointSigner(mustCreateSigner(testSignerKey));
		opts.addDecorators = [mkDec("A"), mkDec("B")];

		const ctrl = new AbortController();
		try {
			const { appender } = await newAppender(fakeDriver(rawAdd, reader), opts, ctrl.signal);
			await appender.add(newEntry(toUTF8("data")))();
			// A is decorators[0] -> outermost -> invoked before B.
			expect(order).toEqual(["A", "B"]);
		} finally {
			ctrl.abort();
		}
	});

	it("rejects adds after shutdown, and no-work shutdown returns promptly", async () => {
		const rawAdd: AddFn = (): IndexFuture => async (): Promise<Index> => ({ index: 1n, isDup: false });
		const opts = newAppendOptions().withCheckpointSigner(mustCreateSigner(testSignerKey));

		const ctrl = new AbortController();
		try {
			const { appender, shutdown } = await newAppender(fakeDriver(rawAdd, fakeReader()), opts, ctrl.signal);
			// No add has resolved, so largestIssued is 0 and shutdown returns via the special case.
			await shutdown();
			await expect(appender.add(newEntry(toUTF8("data")))()).rejects.toThrow("appender has been shut down");
		} finally {
			ctrl.abort();
		}
	});

	it("makes an add that arrives during shutdown wait for shutdown to finish, then fail without reaching the driver", async () => {
		let rawCalls = 0;
		const rawAdd: AddFn = (): IndexFuture => {
			rawCalls++;
			return async (): Promise<Index> => ({ index: 5n, isDup: false });
		};
		let published = false;
		const reader: LogReader = {
			...fakeReader(),
			readCheckpoint: async (): Promise<Uint8Array> => {
				if (!published) {
					throw ErrNotExist;
				}
				return toUTF8("origin\n6\nqINS1GRFhWHwdkUeqLEoP4yEMkTBBzxBkGwGQlVlVcs=\n");
			},
		};
		const opts = newAppendOptions().withCheckpointSigner(mustCreateSigner(testSignerKey));

		const ctrl = new AbortController();
		try {
			const { appender, shutdown } = await newAppender(fakeDriver(rawAdd, reader), opts, ctrl.signal);
			await appender.add(newEntry(toUTF8("first")))();
			expect(rawCalls).toBe(1);

			// Shutdown now waits for a checkpoint covering index 5, which is not published yet.
			const shutdownDone = shutdown();
			await sleep(20);
			let outcome: string | undefined;
			const late = appender
				.add(newEntry(toUTF8("late")))()
				.then(
					() => "resolved",
					(err: unknown) => messageOf(err),
				)
				.then((o) => {
					outcome = o;
				});
			await sleep(150);
			// Go's Add would still be blocked on the read lock that Shutdown's write lock excludes.
			expect(outcome).toBeUndefined();

			published = true;
			await shutdownDone;
			await late;
			expect(outcome).toBe("appender has been shut down");
			expect(rawCalls).toBe(1);
		} finally {
			ctrl.abort();
		}
	});

	it("starts each follower as a detached task that newAppender does not wait for", async () => {
		const rawAdd: AddFn = (): IndexFuture => async (): Promise<Index> => ({ index: 1n, isDup: false });
		const reader = fakeReader();
		let gotReader: LogReader | undefined;
		let gotSignal: AbortSignal | undefined;
		const follower: Follower = {
			name: () => "never-finishes",
			follow: (r: LogReader, signal?: AbortSignal): Promise<void> => {
				gotReader = r;
				gotSignal = signal;
				// Like a real follower, it runs until its signal is aborted, and newAppender must
				// not wait for it.
				return new Promise<void>(() => {});
			},
			entriesProcessed: async (): Promise<bigint> => 0n,
		};
		const opts = newAppendOptions().withCheckpointSigner(mustCreateSigner(testSignerKey));
		opts.followers.push(follower);

		const ctrl = new AbortController();
		try {
			await newAppender(fakeDriver(rawAdd, reader), opts, ctrl.signal);
			await sleep(0);
			expect(gotReader).toBe(reader);
			expect(gotSignal?.aborted).toBe(false);
			ctrl.abort();
			expect(gotSignal?.aborted).toBe(true);
		} finally {
			ctrl.abort();
		}
	});

	it("throws when the driver does not implement the Appender lifecycle", async () => {
		await expect(
			newAppender({}, newAppendOptions().withCheckpointSigner(mustCreateSigner(testSignerKey))),
		).rejects.toThrow("does not implement Appender lifecycle");
		// Port addition: a nil driver is named "<nil>", as Go's %T names a nil interface.
		await expect(
			newAppender(undefined, newAppendOptions().withCheckpointSigner(mustCreateSigner(testSignerKey))),
		).rejects.toThrow("driver <nil> does not implement Appender lifecycle");
	});

	it("throws when opts is null", async () => {
		const rawAdd: AddFn = (): IndexFuture => async (): Promise<Index> => ({ index: 1n, isDup: false });
		await expect(newAppender(fakeDriver(rawAdd, fakeReader()), null)).rejects.toThrow("opts cannot be nil");
	});
});

// Port additions: checkpointPublisher's snapshot of the options (Go's value receiver) and its
// fail-open behaviour for errors other than a policy failure (ADR-0183).
describe("AppendOptions.checkpointPublisher (port additions)", () => {
	const testVerifierKey = "example.com/log/testdata+33d7b496+AeHTu4Q3hEIMHNqc6fASMsq3rKNx280NI+oO5xCFkkSx";
	const witnessVkey = "Wit1+55ee4561+AVhZSmQj9+SoL+p/nN0Hh76xXmF7QcHfytUrI1XfSClk";
	const witnessSkey = "PRIVATE+KEY+Wit1+55ee4561+AeadRiG7XM4XiieCHzD8lxysXMwcViy5nYsoXURWGrlE";
	const root = new Uint8Array(32).fill(7);

	function reader(): LogReader {
		return {
			readCheckpoint: async (): Promise<Uint8Array> => {
				throw ErrNotExist;
			},
			readTile: async (): Promise<Uint8Array> => {
				throw new Error("no tiles here");
			},
			readEntryBundle: async (): Promise<Uint8Array> => new Uint8Array(0),
			nextIndex: async (): Promise<bigint> => 0n,
			integratedSize: async (): Promise<bigint> => 0n,
		};
	}

	const noFetch: FetchFn = async (): Promise<Response> => {
		throw new Error("unexpected witness request");
	};

	function oneWitness(): WitnessGroup {
		return newWitnessGroup(1, newWitness(witnessVkey, new URL("https://witness.example/")));
	}

	async function signedOnly(size: bigint): Promise<Uint8Array> {
		const o = newAppendOptions().withCheckpointSigner(mustCreateSigner(testSignerKey));
		return o.checkpointPublisher(reader(), noFetch)(size, root);
	}

	it("keeps using the options it was created with when they are changed later", async () => {
		const o = newAppendOptions().withCheckpointSigner(mustCreateSigner(testSignerKey));
		const publish = o.checkpointPublisher(reader(), noFetch);
		// Neither a new signer nor a witness policy reaches a publisher that already exists.
		o.withCheckpointSigner(newSigner(generateKey(undefined, "other.example/log").skey));
		o.withWitnesses(oneWitness(), new WitnessOptions({ failOpen: false }));

		const cp = await publish(5n, root);
		const n = open(cp, verifierList(newVerifier(testVerifierKey)));
		expect(n.sigs).toHaveLength(1);
		expect(cp).toEqual(await signedOnly(5n));
	});

	it("publishes the partial checkpoint when failing open on a policy failure, as Go does", async () => {
		const o = newAppendOptions()
			.withCheckpointSigner(mustCreateSigner(testSignerKey))
			.withWitnesses(oneWitness(), new WitnessOptions({ failOpen: true }));

		// The only witness cannot be reached, so the partial checkpoint carries no cosignature.
		const cp = await o.checkpointPublisher(reader(), noFetch)(5n, root);

		expect(cp).toEqual(await signedOnly(5n));
	});

	// A witness that cosigns, and a policy whose evaluation throws: the gateway then fails with an
	// error that is not a PolicyNotSatisfiedError, the case for which Go's Witness returns nil.
	const cosigner = newSignerForCosignatureV1(witnessSkey);
	const cosigningFetch: FetchFn = async (_url: string, init?: RequestInit): Promise<Response> => {
		const req = fromUTF8(init?.body as Uint8Array);
		const cp = req.slice(req.indexOf("\n\n") + 2);
		const text = cp.slice(0, cp.indexOf("\n\n") + 1);
		const cosigned = fromUTF8(sign({ text }, cosigner));
		return new Response(cosigned.slice(text.length + 1), { status: 200 });
	};
	function explodingPolicy(): WitnessGroup {
		const component = {
			satisfied: (): boolean => {
				throw new Error("policy evaluation failed");
			},
			endpoints: () => new Map([["https://witness.example/add-checkpoint", newVerifierForCosignatureV1(witnessVkey)]]),
		};
		return new WitnessGroup([component], 1);
	}

	it("publishes the log-signed checkpoint when failing open on an error other than a policy failure", async () => {
		const o = newAppendOptions()
			.withCheckpointSigner(mustCreateSigner(testSignerKey))
			.withWitnesses(explodingPolicy(), new WitnessOptions({ failOpen: true }));

		const cp = await o.checkpointPublisher(reader(), cosigningFetch)(5n, root);

		expect(cp.length).toBeGreaterThan(0);
		expect(cp).toEqual(await signedOnly(5n));
	});

	it("still fails on that error when not failing open", async () => {
		const o = newAppendOptions()
			.withCheckpointSigner(mustCreateSigner(testSignerKey))
			.withWitnesses(explodingPolicy(), new WitnessOptions({ failOpen: false }));

		await expect(o.checkpointPublisher(reader(), cosigningFetch)(5n, root)).rejects.toThrow("policy evaluation failed");
	});

	// Go builds the witness gateway, which reads Endpoints, before the error handling that
	// fails open, and Endpoints cannot fail there. The port keeps that structure, so a
	// component whose endpoints throws rejects the publication even when failing open.
	it("rejects when a policy component's endpoints throws, even when failing open", async () => {
		const component = {
			satisfied: (): boolean => false,
			endpoints: (): Map<string, Verifier> => {
				throw new Error("endpoints failed");
			},
		};
		const o = newAppendOptions()
			.withCheckpointSigner(mustCreateSigner(testSignerKey))
			.withWitnesses(new WitnessGroup([component], 1), new WitnessOptions({ failOpen: true }));

		await expect(o.checkpointPublisher(reader(), cosigningFetch)(5n, root)).rejects.toThrow("endpoints failed");
	});
});

function mustCreateSigner(k: string): Signer {
	// Port note: Go's t.Fatalf on error becomes newSigner's own throw, which fails the test.
	return newSigner(k);
}

/** quoteish renders a caught value roughly the way Go's `%q` would for the test's own messages. */
function quoteish(err: unknown): string {
	return `"${messageOf(err)}"`;
}
