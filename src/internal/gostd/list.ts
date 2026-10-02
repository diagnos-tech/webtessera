// Copyright 2009 The Go Authors. All rights reserved.
// Copyright 2026 MedDeck. All Rights Reserved.
//
// Use of this source code is governed by a BSD-style license, reproduced here
// because this file is a derivative work of Go's standard library
// `container/list` and this repository is otherwise Apache-2.0:
//
// Copyright 2009 The Go Authors.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//    * Redistributions of source code must retain the above copyright
// notice, this list of conditions and the following disclaimer.
//    * Redistributions in binary form must reproduce the above
// copyright notice, this list of conditions and the following disclaimer
// in the documentation and/or other materials provided with the
// distribution.
//    * Neither the name of Google LLC nor the names of its
// contributors may be used to endorse or promote products derived from
// this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//
// Ported from container/list (Go standard library) @ Go 1.25.5
//
// This file is not a port of a Tessera file -- Tessera itself imports
// `container/list` for `fsck/status.go`'s rangeTracker, which has no TypeScript
// equivalent, so it lives here alongside the other src/internal/gostd/ shims
// rather than under src/vendor/ (which is reserved for Tessera's own external
// dependencies -- merkle, note, formats/log).
//
// Port note: Go's `Value any` becomes a type parameter `T` here rather than
// TypeScript's `any`, which AGENTS.md §7 bans in donatable code. `container/list`
// predates Go generics; its `any` plays exactly the role a type parameter plays in
// a generic container, so `List<T>`/`Element<T>` is the faithful rendering of "a
// list that holds values of a caller-chosen type", not an invented API. See
// docs/decisions/0090-list-generics-reserved-word-and-package-private-fields.md.
//
// Port note: `next`, `prev` and `list` are unexported in Go, and `list_test.ts`
// (mirroring `list_test.go`, an in-package test) reads `next`/`prev` directly, and
// every method on List needs cross-class access to Element's `list` field (Go's
// same-package field access has no direct TypeScript equivalent). All three are
// therefore `_`-prefixed public members marked `@internal`, exactly as
// compact.Range's `_begin`/`_end` are, per
// docs/decisions/0010-package-private-members.md. `len` is touched only by List's
// own methods, so it stays genuinely private (`#len`).
//
// Port note: package-level `New` collides with the reserved word `new` once
// camelCased (ADR-0002's mechanical mapping). Renamed `newList`, matching this
// codebase's existing `new<Type>` factory-function convention (`newNodeID`,
// `newVerifier`, `newRangeTracker`, ...). See ADR-0090.

// Package list implements a doubly linked list.
//
// To iterate over a list (where l is a List):
//
//	for (let e = l.front(); e !== null; e = e.next()) {
//		// do something with e.value
//	}

/**
 * Element is an element of a linked list.
 */
export class Element<T> {
	/**
	 * @internal Next and previous pointers in the doubly-linked list of elements.
	 * To simplify the implementation, internally a list l is implemented as a
	 * ring, such that l._root is both the next element of the last list element
	 * (l.back()) and the previous element of the first list element (l.front()).
	 *
	 * Port note: Go's zero-value Element has nil next/prev until inserted. A
	 * freshly constructed Element<T> instead self-loops (`_next = _prev = this`)
	 * so the fields can stay non-nullable; `#insert` unconditionally overwrites
	 * both before the element is reachable from any List, so the initial value is
	 * never otherwise observed.
	 */
	_next: Element<T>;
	/** @internal */
	_prev: Element<T>;

	/** @internal The list to which this element belongs. */
	_list: List<T> | null;

	/** The value stored with this element. */
	value: T;

	/** @internal Stands in for Go's `&Element{Value: v}` composite literal. */
	constructor(value: T) {
		this.value = value;
		this._next = this;
		this._prev = this;
		this._list = null;
	}

	/** next returns the next list element or null. */
	next(): Element<T> | null {
		const p = this._next;
		if (this._list !== null && p !== this._list._root) {
			return p;
		}
		return null;
	}

	/** prev returns the previous list element or null. */
	prev(): Element<T> | null {
		const p = this._prev;
		if (this._list !== null && p !== this._list._root) {
			return p;
		}
		return null;
	}
}

/**
 * List represents a doubly linked list.
 * The zero value for List is an empty list ready to use.
 *
 * Port note: TypeScript has no zero-value struct the way Go does -- `new List()`
 * always runs the constructor below, which performs the same work `Init()` does.
 * `#lazyInit` is therefore, after construction, permanently a no-op; it is kept
 * anyway, called from the exact same call sites Go calls it from, purely for
 * structural fidelity with the upstream source (see TestZeroList in
 * list_test.ts, ported unchanged).
 */
export class List<T> {
	/** @internal sentinel list element, only _root, _root._prev, and _root._next are used. */
	_root: Element<T>;
	/** current list length excluding (this) sentinel element */
	#len: number;

	constructor() {
		// Port note: stands in for Go's implicit zero value (`var l List`) followed
		// by whatever first touches it triggering lazyInit -- see the class doc
		// comment above.
		this._root = new Element<T>(undefined as unknown as T);
		this.#len = 0;
		this.init();
	}

	/** init initializes or clears list l. */
	init(): this {
		this._root._next = this._root;
		this._root._prev = this._root;
		this.#len = 0;
		return this;
	}

	/**
	 * len returns the number of elements of list l.
	 * The complexity is O(1).
	 */
	len(): number {
		return this.#len;
	}

	/** front returns the first element of list l or null if the list is empty. */
	front(): Element<T> | null {
		if (this.#len === 0) {
			return null;
		}
		return this._root._next;
	}

	/** back returns the last element of list l or null if the list is empty. */
	back(): Element<T> | null {
		if (this.#len === 0) {
			return null;
		}
		return this._root._prev;
	}

	/**
	 * @internal lazyInit lazily initializes a zero List value.
	 * Always a no-op in this port; see the class doc comment.
	 */
	#lazyInit(): void {
		// Port note: Go checks `l.root.next == nil`, which can never be true here --
		// the constructor always establishes the ring. Kept for structural parity
		// with every Go call site that calls lazyInit before a Push*.
	}

	/** @internal insert inserts e after at, increments l.len, and returns e. */
	#insert(e: Element<T>, at: Element<T>): Element<T> {
		e._prev = at;
		e._next = at._next;
		e._prev._next = e;
		e._next._prev = e;
		e._list = this;
		this.#len++;
		return e;
	}

	/** @internal insertValue is a convenience wrapper for insert(new Element(v), at). */
	#insertValue(v: T, at: Element<T>): Element<T> {
		return this.#insert(new Element<T>(v), at);
	}

	/** @internal remove removes e from its list, decrements l.len */
	#remove(e: Element<T>): void {
		e._prev._next = e._next;
		e._next._prev = e._prev;
		// Port note: Go sets `e.next = nil; e.prev = nil` to avoid memory leaks.
		// Self-looping instead of nulling keeps the fields non-nullable; a removed
		// element is identified by `_list === null`, exactly as Go's Remove checks
		// `e.list == l` rather than looking at next/prev.
		e._next = e;
		e._prev = e;
		e._list = null;
		this.#len--;
	}

	/** @internal move moves e to next to at. */
	#move(e: Element<T>, at: Element<T>): void {
		if (e === at) {
			return;
		}
		e._prev._next = e._next;
		e._next._prev = e._prev;

		e._prev = at;
		e._next = at._next;
		e._prev._next = e;
		e._next._prev = e;
	}

	/**
	 * remove removes e from l if e is an element of list l.
	 * It returns the element value e.Value.
	 * The element must not be null.
	 */
	remove(e: Element<T>): T {
		if (e._list === this) {
			// if e.list == l, l must have been initialized when e was inserted
			// in l or l == nil (e is a zero Element) and l.remove will crash
			this.#remove(e);
		}
		return e.value;
	}

	/** pushFront inserts a new element e with value v at the front of list l and returns e. */
	pushFront(v: T): Element<T> {
		this.#lazyInit();
		return this.#insertValue(v, this._root);
	}

	/** pushBack inserts a new element e with value v at the back of list l and returns e. */
	pushBack(v: T): Element<T> {
		this.#lazyInit();
		return this.#insertValue(v, this._root._prev);
	}

	/**
	 * insertBefore inserts a new element e with value v immediately before mark and returns e.
	 * If mark is not an element of l, the list is not modified.
	 * The mark must not be null.
	 */
	insertBefore(v: T, mark: Element<T>): Element<T> | null {
		if (mark._list !== this) {
			return null;
		}
		// see comment in List.Remove about initialization of l
		return this.#insertValue(v, mark._prev);
	}

	/**
	 * insertAfter inserts a new element e with value v immediately after mark and returns e.
	 * If mark is not an element of l, the list is not modified.
	 * The mark must not be null.
	 */
	insertAfter(v: T, mark: Element<T>): Element<T> | null {
		if (mark._list !== this) {
			return null;
		}
		// see comment in List.Remove about initialization of l
		return this.#insertValue(v, mark);
	}

	/**
	 * moveToFront moves element e to the front of list l.
	 * If e is not an element of l, the list is not modified.
	 * The element must not be null.
	 */
	moveToFront(e: Element<T>): void {
		if (e._list !== this || this._root._next === e) {
			return;
		}
		// see comment in List.Remove about initialization of l
		this.#move(e, this._root);
	}

	/**
	 * moveToBack moves element e to the back of list l.
	 * If e is not an element of l, the list is not modified.
	 * The element must not be null.
	 */
	moveToBack(e: Element<T>): void {
		if (e._list !== this || this._root._prev === e) {
			return;
		}
		// see comment in List.Remove about initialization of l
		this.#move(e, this._root._prev);
	}

	/**
	 * moveBefore moves element e to its new position before mark.
	 * If e or mark is not an element of l, or e == mark, the list is not modified.
	 * The element and mark must not be null.
	 */
	moveBefore(e: Element<T>, mark: Element<T>): void {
		if (e._list !== this || e === mark || mark._list !== this) {
			return;
		}
		this.#move(e, mark._prev);
	}

	/**
	 * moveAfter moves element e to its new position after mark.
	 * If e or mark is not an element of l, or e == mark, the list is not modified.
	 * The element and mark must not be null.
	 */
	moveAfter(e: Element<T>, mark: Element<T>): void {
		if (e._list !== this || e === mark || mark._list !== this) {
			return;
		}
		this.#move(e, mark);
	}

	/**
	 * pushBackList inserts a copy of another list at the back of list l.
	 * The lists l and other may be the same. They must not be null.
	 */
	pushBackList(other: List<T>): void {
		this.#lazyInit();
		let i = other.len();
		let e = other.front();
		for (; i > 0 && e !== null; i--, e = e.next()) {
			this.#insertValue(e.value, this._root._prev);
		}
	}

	/**
	 * pushFrontList inserts a copy of another list at the front of list l.
	 * The lists l and other may be the same. They must not be null.
	 */
	pushFrontList(other: List<T>): void {
		this.#lazyInit();
		let i = other.len();
		let e = other.back();
		for (; i > 0 && e !== null; i--, e = e.prev()) {
			this.#insertValue(e.value, this._root);
		}
	}
}

/** newList returns an initialized list. Port of Go's `New`; see the file header. */
export function newList<T>(): List<T> {
	return new List<T>();
}
