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

// This file is not a port of a Tessera file. It stands in for the one `fmt` verb the port
// needs beyond `%v`, `%q` and `%d`, which have their own helpers: `%T`, which Tessera uses to
// name a driver that does not implement a lifecycle.

/**
 * formatType renders v's dynamic type the way Go's `%T` renders an interface value, as closely
 * as JavaScript allows: `<nil>` for a nil interface, which null and undefined both stand for;
 * otherwise the name of the value's constructor, or its `typeof` when it has none (an object
 * with a null prototype, say, or a primitive).
 */
export function formatType(v: unknown): string {
	if (v === null || v === undefined) {
		return "<nil>";
	}
	if (typeof v === "object" || typeof v === "function") {
		const name: unknown = (v as { constructor?: { name?: unknown } }).constructor?.name;
		if (typeof name === "string" && name !== "") {
			return name;
		}
	}
	return typeof v;
}
