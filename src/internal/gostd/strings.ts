// Copyright 2009 The Go Authors. All rights reserved.
// Copyright 2026 MedDeck LTDA. All Rights Reserved.
//
// This file has mixed provenance. The doc comments of cut, trimSpace and fields (each
// marked below) are taken from Go's standard library package `strings`, so those
// declarations are a derivative work of it and remain subject to the Go project's
// BSD-style licence, which is reproduced further down and in LICENSES/BSD-3-Clause-Go.txt.
// Everything else in this file is original to this project and is licensed under the
// Apache License, Version 2.0:
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
// The following terms apply to the portions of this file derived from Go:
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
// Doc comments taken from strings/strings.go (Go standard library) @ Go 1.25.5

// This file is not a port of a Tessera file. It stands in for the parts of Go's
// `strings` package that the port relies on and TypeScript does not provide.

import { isSpace } from "./unicode.ts";

/**
 * cut slices s around the first instance of sep, returning the text before and after
 * sep. The found result reports whether sep appears in s. If sep does not appear in s,
 * cut returns s, "", false (`strings.Cut`; doc comment derived from Go's).
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

/**
 * trimSpace returns a slice of the string s, with all leading and trailing white space
 * removed, as defined by Unicode (`strings.TrimSpace`; doc comment derived from Go's).
 *
 * Port note: this is deliberately not `String.prototype.trim`. JavaScript's notion of
 * white space differs from Unicode's White_Space property, which is what Go uses
 * (`unicode.IsSpace`, see isSpace in unicode.ts): `trim` strips U+FEFF ZERO WIDTH
 * NO-BREAK SPACE, which Go keeps, and keeps U+0085 NEXT LINE, which Go strips. Text
 * parsed with the wrong one is split differently from the way every Go implementation
 * splits it.
 *
 * Every White_Space code point is in the Basic Multilingual Plane, so walking UTF-16
 * code units is the same as walking code points here: neither half of a surrogate pair
 * is ever white space, so a pair is never split.
 */
export function trimSpace(s: string): string {
	let start = 0;
	while (start < s.length && isSpace(s.charCodeAt(start))) {
		start++;
	}
	let stop = s.length;
	while (stop > start && isSpace(s.charCodeAt(stop - 1))) {
		stop--;
	}
	return s.slice(start, stop);
}

/**
 * fields splits the string s around each instance of one or more consecutive white space
 * characters, as defined by unicode.IsSpace, returning a slice of substrings of s or an
 * empty slice if s contains only white space. Every element of the returned slice is
 * non-empty. Unlike Split, leading and trailing runs runs of white space characters
 * are discarded. (`strings.Fields`; doc comment derived from Go's, its doubled "runs"
 * included.)
 *
 * Port note: not `s.split(/\s+/)`, for the reason given on trimSpace.
 */
export function fields(s: string): string[] {
	const out: string[] = [];
	let fieldStart = -1;
	for (let i = 0; i < s.length; i++) {
		if (isSpace(s.charCodeAt(i))) {
			if (fieldStart >= 0) {
				out.push(s.slice(fieldStart, i));
				fieldStart = -1;
			}
		} else if (fieldStart < 0) {
			fieldStart = i;
		}
	}
	if (fieldStart >= 0) {
		out.push(s.slice(fieldStart));
	}
	return out;
}
