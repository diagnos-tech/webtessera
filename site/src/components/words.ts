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

// Counted nouns and lists in prose, since the numbers on the page are computed.

const small = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** count renders "two dependencies": small numbers in words, the noun pluralised with s. */
export function count(n: number, noun: string, plural = `${noun}s`): string {
	return `${small[n] ?? String(n)} ${n === 1 ? noun : plural}`;
}

/** list joins items as prose: "a, b and c". */
export function list(items: readonly string[]): string {
	return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
