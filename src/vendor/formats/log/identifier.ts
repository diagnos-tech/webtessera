// Copyright 2021 Google LLC. All Rights Reserved.
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
//
// Ported from github.com/transparency-dev/formats/log/identifier.go
// @ v0.0.0-20251017110053-404c0d5b696c

import { sha256 } from "@noble/hashes/sha2.js";
import { toHex, toUTF8 } from "../../../internal/gostd/bytes.ts";

/**
 * id returns the identifier to use for a log given the Origin. This is the ID
 * used to find checkpoints for this log at distributors, and that will be used
 * to feed checkpoints to witnesses.
 *
 * Port note: Go's `ID` is a func, so it is camelCased to `id` (PORTING.md §3.2).
 */
export function id(origin: string): string {
	const s = sha256.create();
	s.update(toUTF8("o:"));
	s.update(toUTF8(origin));
	return toHex(s.digest());
}
