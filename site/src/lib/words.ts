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

// Counted nouns and lists in prose, since every number on the site is computed.

const small = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** num renders a number for prose: words up to ten, digits with separators above. */
export function num(n: number): string {
	return small[n] ?? n.toLocaleString("en-GB");
}

/** count renders "two dependencies": the number as num renders it, the noun pluralised with s. */
export function count(n: number, noun: string, plural = `${noun}s`): string {
	return `${num(n)} ${n === 1 ? noun : plural}`;
}

/** list joins items as prose, without a serial comma: "a, b and c". */
export function list(items: readonly string[], last = "and"): string {
	return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`;
}

/** capitalise uppercases the first letter of a sentence. */
export function capitalise(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** short abbreviates a commit to seven characters, as git does. */
export function short(sha: string): string {
	return /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : sha;
}
