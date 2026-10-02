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

// Lets the backend-independent suites, which drive an ObjectStore from the test's own
// context, exercise a store that lives inside a Durable Object. Test-only.

import { runInDurableObject } from "cloudflare:test";
import type { ObjectStore } from "../../objectstore/objectstore.ts";
import type { TestObject } from "./worker.ts";

/** TestNamespace is the namespace of a test Durable Object class. */
export type TestNamespace = DurableObjectNamespace<TestObject>;

type testStub = DurableObjectStub<TestObject>;

/** StoreFactory makes stores for the shared suites. */
export interface StoreFactory {
	/** newStore returns a store over the storage of a fresh Durable Object. */
	newStore(): Promise<ObjectStore>;
	/**
	 * reopen returns a second store over the same Durable Object's storage, as a
	 * second driver in the same object would build it.
	 */
	reopen(store: ObjectStore): Promise<ObjectStore>;
}

/**
 * storeFactory returns the factories the shared suites take. Each store is built by
 * build, inside its Durable Object, over that object's storage.
 */
export function storeFactory(ns: TestNamespace, build: (storage: DurableObjectStorage) => ObjectStore): StoreFactory {
	const stubs = new WeakMap<ObjectStore, testStub>();
	const open = async (stub: testStub): Promise<ObjectStore> => {
		const store = await runInDurableObject(stub, (_, state) => build(state.storage));
		const proxy = inDurableObject(stub, store);
		stubs.set(proxy, stub);
		return proxy;
	};
	return {
		newStore: () => open(ns.get(ns.newUniqueId())),
		reopen: (store) => {
			const stub = stubs.get(store);
			if (stub === undefined) {
				throw new Error("reopen: store was not made by this factory");
			}
			return open(stub);
		},
	};
}

/**
 * inDurableObject returns an ObjectStore that forwards every call to store inside
 * the Durable Object stub points to.
 *
 * Durable Object storage may only be used from within its object, so a store built
 * there cannot be called from the test directly. runInDurableObject runs each call
 * in the object as a request of its own, which is also how concurrent calls from the
 * suites reach a real object: as separate, interleaving requests.
 *
 * lock holds the lock inside the object but runs fn back in the caller's context,
 * where fn's own calls to the store are forwarded in turn.
 */
function inDurableObject(stub: testStub, store: ObjectStore): ObjectStore {
	const run = <R>(fn: () => Promise<R>): Promise<R> => runInDurableObject(stub, fn);
	return {
		get: (key) => run(() => store.get(key)),
		stat: (key) => run(() => store.stat(key)),
		put: (key, data) => run(() => store.put(key, data)),
		create: (key, data) => run(() => store.create(key, data)),
		deletePrefix: (prefix) => run(() => store.deletePrefix(prefix)),
		lock: async (name, fn, signal) => {
			const abort = abortOf(signal);
			let waited = (_acquired: boolean): void => {};
			const acquiredOrFailed = new Promise<boolean>((r) => {
				waited = r;
			});
			let release = (): void => {};
			const released = new Promise<void>((r) => {
				release = r;
			});
			const holding = run(async () => {
				try {
					await store.lock(
						name,
						async () => {
							waited(true);
							await released;
						},
						bridge(abort),
					);
				} catch (err) {
					waited(false);
					throw err;
				}
			});
			// The outcome is read from holding below, once known; until then, keep its
			// rejection from being reported as unhandled.
			holding.catch(() => {});
			// workerd resumes an awaiting function in the context that resolved the promise
			// it awaits, so learning the outcome straight from acquiredOrFailed would run fn
			// inside the object. A response from the object resumes it here instead.
			if (!(await run(() => acquiredOrFailed))) {
				await holding;
				throw new Error("lock: waiting failed without an error");
			}
			try {
				return await fn();
			} finally {
				release();
				await holding;
			}
		},
	};
}

/**
 * abortOf captures signal as plain values: its reason if it has already aborted, or a
 * promise for its reason if it has not.
 *
 * An AbortSignal is an I/O object in workerd, usable only in the context that created
 * it, so a signal from the test cannot be handed to code running inside a Durable
 * Object. Plain values and promises can carry its state across instead.
 */
function abortOf(signal: AbortSignal | undefined): { reason: unknown } | Promise<unknown> | undefined {
	if (signal === undefined) {
		return undefined;
	}
	if (signal.aborted) {
		return { reason: signal.reason };
	}
	return new Promise((resolve) => {
		signal.addEventListener("abort", () => resolve(signal.reason), { once: true });
	});
}

/**
 * bridge rebuilds the signal abortOf captured, owned by the current context. It must
 * be called inside the Durable Object.
 */
function bridge(abort: { reason: unknown } | Promise<unknown> | undefined): AbortSignal | undefined {
	if (abort === undefined) {
		return undefined;
	}
	if (!(abort instanceof Promise)) {
		return AbortSignal.abort(abort.reason);
	}
	const ac = new AbortController();
	void abort.then((reason) => ac.abort(reason));
	return ac.signal;
}

/** inFreshObject runs fn inside a fresh Durable Object of ns, with its storage. */
export function inFreshObject<R>(ns: TestNamespace, fn: (storage: DurableObjectStorage) => Promise<R>): Promise<R> {
	return runInDurableObject(ns.get(ns.newUniqueId()), (_, state) => fn(state.storage));
}
