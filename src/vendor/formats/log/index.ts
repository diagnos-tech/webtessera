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

// This file has no counterpart in Go, where the package itself is the unit of import.
// It is the barrel that `@repo/webtessera/formats/log` resolves to, so that a
// TypeScript caller writes `import { Checkpoint, parseCheckpoint } from
// "@repo/webtessera/formats/log"` where a Go caller writes
// `import "github.com/transparency-dev/formats/log"`.

export { Checkpoint } from "./checkpoint.ts";
export { id } from "./identifier.ts";
export { ParseCheckpointError, type ParsedCheckpoint, parseCheckpoint } from "./note.ts";
