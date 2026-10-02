// Copyright 2009 The Go Authors. All rights reserved.
// Copyright 2026 MedDeck LTDA. All Rights Reserved.
//
// Use of this source code is governed by a BSD-style
// license that can be found in LICENSES/BSD-3-Clause-Go.txt.
//
// Ported from container/list/list_test.go (Go standard library) @ Go 1.25.5

import { expect, it } from "vitest";
import { Element, List, newList } from "./list.ts";

// checkListLen mirrors Go's checkListLen, returning whether the length matched so
// callers can early-return the way `if !checkListLen(t, l, len(es)) { return }` does.
function checkListLen<T>(l: List<T>, wantLen: number): boolean {
	const n = l.len();
	expect(n, "l.len()").toBe(wantLen);
	return n === wantLen;
}

function checkListPointers<T>(l: List<T>, es: readonly Element<T>[]): void {
	const root = l._root;

	if (!checkListLen(l, es.length)) {
		return;
	}

	// zero length lists must be the zero value or properly initialized (sentinel circle)
	if (es.length === 0) {
		// Port note: Go's check tolerates either a properly initialized sentinel
		// ring OR an untouched Go zero-value (nil next/prev): `l.root.next != nil
		// && l.root.next != root || ...`. This port's `_next`/`_prev` are never
		// nil (list.ts's class doc comment), so the only valid state is the
		// initialized ring, which is what this asserts.
		expect(l._root._next, "l._root._next").toBe(root);
		expect(l._root._prev, "l._root._prev").toBe(root);
		return;
	}
	// len(es) > 0

	// check internal and external prev/next connections
	for (let i = 0; i < es.length; i++) {
		const e = es[i] as Element<T>;

		let prev: Element<T> = root;
		let wantPrev: Element<T> | null = null;
		if (i > 0) {
			prev = es[i - 1] as Element<T>;
			wantPrev = prev;
		}
		expect(e._prev, `elt[${i}]._prev`).toBe(prev);
		expect(e.prev(), `elt[${i}].prev()`).toBe(wantPrev);

		let next: Element<T> = root;
		let wantNext: Element<T> | null = null;
		if (i < es.length - 1) {
			next = es[i + 1] as Element<T>;
			wantNext = next;
		}
		expect(e._next, `elt[${i}]._next`).toBe(next);
		expect(e.next(), `elt[${i}].next()`).toBe(wantNext);
	}
}

it("TestList", () => {
	const l = newList<number | string>();
	checkListPointers(l, []);

	// Single element list
	const e = l.pushFront("a");
	checkListPointers(l, [e]);
	l.moveToFront(e);
	checkListPointers(l, [e]);
	l.moveToBack(e);
	checkListPointers(l, [e]);
	l.remove(e);
	checkListPointers(l, []);

	// Bigger list
	let e2 = l.pushFront(2);
	const e1 = l.pushFront(1);
	const e3 = l.pushBack(3);
	const e4 = l.pushBack("banana");
	checkListPointers(l, [e1, e2, e3, e4]);

	l.remove(e2);
	checkListPointers(l, [e1, e3, e4]);

	l.moveToFront(e3); // move from middle
	checkListPointers(l, [e3, e1, e4]);

	l.moveToFront(e1);
	l.moveToBack(e3); // move from middle
	checkListPointers(l, [e1, e4, e3]);

	l.moveToFront(e3); // move from back
	checkListPointers(l, [e3, e1, e4]);
	l.moveToFront(e3); // should be no-op
	checkListPointers(l, [e3, e1, e4]);

	l.moveToBack(e3); // move from front
	checkListPointers(l, [e1, e4, e3]);
	l.moveToBack(e3); // should be no-op
	checkListPointers(l, [e1, e4, e3]);

	e2 = l.insertBefore(2, e1)!; // insert before front
	checkListPointers(l, [e2, e1, e4, e3]);
	l.remove(e2);
	e2 = l.insertBefore(2, e4)!; // insert before middle
	checkListPointers(l, [e1, e2, e4, e3]);
	l.remove(e2);
	e2 = l.insertBefore(2, e3)!; // insert before back
	checkListPointers(l, [e1, e4, e2, e3]);
	l.remove(e2);

	e2 = l.insertAfter(2, e1)!; // insert after front
	checkListPointers(l, [e1, e2, e4, e3]);
	l.remove(e2);
	e2 = l.insertAfter(2, e4)!; // insert after middle
	checkListPointers(l, [e1, e4, e2, e3]);
	l.remove(e2);
	e2 = l.insertAfter(2, e3)!; // insert after back
	checkListPointers(l, [e1, e4, e3, e2]);
	l.remove(e2);

	// Check standard iteration.
	let sum = 0;
	for (let it2 = l.front(); it2 !== null; it2 = it2.next()) {
		if (typeof it2.value === "number") {
			sum += it2.value;
		}
	}
	expect(sum, "sum over l").toBe(4);

	// Clear all elements by iterating
	let next: Element<number | string> | null;
	for (let it2 = l.front(); it2 !== null; it2 = next) {
		next = it2.next();
		l.remove(it2);
	}
	checkListPointers(l, []);
});

function checkList<T>(l: List<T>, es: readonly T[]): void {
	if (!checkListLen(l, es.length)) {
		return;
	}

	let i = 0;
	for (let e = l.front(); e !== null; e = e.next()) {
		expect(e.value, `elt[${i}].value`).toBe(es[i]);
		i++;
	}
}

it("TestExtending", () => {
	const l1 = newList<number>();
	const l2 = newList<number>();

	l1.pushBack(1);
	l1.pushBack(2);
	l1.pushBack(3);

	l2.pushBack(4);
	l2.pushBack(5);

	let l3 = newList<number>();
	l3.pushBackList(l1);
	checkList(l3, [1, 2, 3]);
	l3.pushBackList(l2);
	checkList(l3, [1, 2, 3, 4, 5]);

	l3 = newList<number>();
	l3.pushFrontList(l2);
	checkList(l3, [4, 5]);
	l3.pushFrontList(l1);
	checkList(l3, [1, 2, 3, 4, 5]);

	checkList(l1, [1, 2, 3]);
	checkList(l2, [4, 5]);

	l3 = newList<number>();
	l3.pushBackList(l1);
	checkList(l3, [1, 2, 3]);
	l3.pushBackList(l3);
	checkList(l3, [1, 2, 3, 1, 2, 3]);

	l3 = newList<number>();
	l3.pushFrontList(l1);
	checkList(l3, [1, 2, 3]);
	l3.pushFrontList(l3);
	checkList(l3, [1, 2, 3, 1, 2, 3]);

	l3 = newList<number>();
	l1.pushBackList(l3);
	checkList(l1, [1, 2, 3]);
	l1.pushFrontList(l3);
	checkList(l1, [1, 2, 3]);
});

it("TestRemove", () => {
	const l = newList<number>();
	const e1 = l.pushBack(1);
	const e2 = l.pushBack(2);
	checkListPointers(l, [e1, e2]);
	const e = l.front() as Element<number>;
	l.remove(e);
	checkListPointers(l, [e2]);
	l.remove(e);
	checkListPointers(l, [e2]);
});

it("TestIssue4103", () => {
	const l1 = newList<number>();
	l1.pushBack(1);
	l1.pushBack(2);

	const l2 = newList<number>();
	l2.pushBack(3);
	l2.pushBack(4);

	const e = l1.front() as Element<number>;
	l2.remove(e); // l2 should not change because e is not an element of l2
	expect(l2.len(), "l2.len()").toBe(2);

	l1.insertBefore(8, e);
	expect(l1.len(), "l1.len()").toBe(3);
});

it("TestIssue6349", () => {
	const l = newList<number>();
	l.pushBack(1);
	l.pushBack(2);

	const e = l.front() as Element<number>;
	l.remove(e);
	expect(e.value, "e.value").toBe(1);
	expect(e.next(), "e.next()").toBeNull();
	expect(e.prev(), "e.prev()").toBeNull();
});

it("TestMove", () => {
	const l = newList<number>();
	let e1 = l.pushBack(1);
	let e2 = l.pushBack(2);
	let e3 = l.pushBack(3);
	let e4 = l.pushBack(4);

	l.moveAfter(e3, e3);
	checkListPointers(l, [e1, e2, e3, e4]);
	l.moveBefore(e2, e2);
	checkListPointers(l, [e1, e2, e3, e4]);

	l.moveAfter(e3, e2);
	checkListPointers(l, [e1, e2, e3, e4]);
	l.moveBefore(e2, e3);
	checkListPointers(l, [e1, e2, e3, e4]);

	l.moveBefore(e2, e4);
	checkListPointers(l, [e1, e3, e2, e4]);
	// Port note: Go's `e2, e3 = e3, e2` (and the multi-variable swaps below) are
	// local-variable relabelling only -- they do not touch the list -- so a JS
	// destructuring assignment, evaluated right-to-left exactly as Go's
	// multi-assignment is, is the direct equivalent.
	[e2, e3] = [e3, e2];

	l.moveBefore(e4, e1);
	checkListPointers(l, [e4, e1, e2, e3]);
	[e1, e2, e3, e4] = [e4, e1, e2, e3];

	l.moveAfter(e4, e1);
	checkListPointers(l, [e1, e4, e2, e3]);
	[e2, e3, e4] = [e4, e2, e3];

	l.moveAfter(e2, e3);
	checkListPointers(l, [e1, e3, e2, e4]);
});

it("TestZeroList", () => {
	// Port note: Go's `new(List)` zero-value is `new List<number>()` here -- see
	// list.ts's class doc comment on why the two are equivalent in this port.
	const l1 = new List<number>();
	l1.pushFront(1);
	checkList(l1, [1]);

	const l2 = new List<number>();
	l2.pushBack(1);
	checkList(l2, [1]);

	const l3 = new List<number>();
	l3.pushFrontList(l1);
	checkList(l3, [1]);

	const l4 = new List<number>();
	l4.pushBackList(l2);
	checkList(l4, [1]);
});

it("TestInsertBeforeUnknownMark", () => {
	const l = new List<number>();
	l.pushBack(1);
	l.pushBack(2);
	l.pushBack(3);
	// Port note: `new(Element)` in Go is a zero-value Element belonging to no
	// list; the value carried is irrelevant since insertBefore only inspects
	// mark._list, which is null for a freshly constructed Element.
	l.insertBefore(1, new Element<number>(0));
	checkList(l, [1, 2, 3]);
});

it("TestInsertAfterUnknownMark", () => {
	const l = new List<number>();
	l.pushBack(1);
	l.pushBack(2);
	l.pushBack(3);
	l.insertAfter(1, new Element<number>(0));
	checkList(l, [1, 2, 3]);
});

it("TestMoveUnknownMark", () => {
	const l1 = new List<number>();
	const e1 = l1.pushBack(1);

	const l2 = new List<number>();
	const e2 = l2.pushBack(2);

	l1.moveAfter(e1, e2);
	checkList(l1, [1]);
	checkList(l2, [2]);

	l1.moveBefore(e1, e2);
	checkList(l1, [1]);
	checkList(l2, [2]);
});
