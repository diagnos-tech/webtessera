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

// This file is not a port of a Tessera file. It stands in for the parts of Go's
// `strings` package that the port relies on and TypeScript does not provide.

/**
 * cut slices s around the first instance of sep, returning the text before and after
 * sep, and whether sep appears in s (`strings.Cut`).
 *
 * If sep does not appear in s, cut returns s, "", false.
 *
 * `sumdb/note` leans on the exact "not found" behaviour in several places: the parsers
 * of both verifier and signer keys cut repeatedly on "+" and let the resulting empty
 * fields fail validation, rather than counting the separators up front.
 */
export function cut(s: string, sep: string): [before: string, after: string, found: boolean] {
	const i = s.indexOf(sep);
	if (i < 0) {
		return [s, "", false];
	}
	return [s.slice(0, i), s.slice(i + sep.length), true];
}
