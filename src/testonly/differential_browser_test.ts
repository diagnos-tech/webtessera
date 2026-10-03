// Copyright 2026 MedDeck. All Rights Reserved.
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

// Runtime parity: replays every differential corpus (fixtures/data/differential_*.json) inside
// Chromium (vitest.browser.config.ts). Several stand-ins depend on the runtime rather than on the port's own code:
// validUTF8 and fromUTF8 on TextDecoder, quote on the runtime's Unicode property tables, the
// witness URL checks on the platform URL parser. On Node the same suites run from the
// `*_differential_test.ts` files next to the code they cover. See docs/compatibility.md
// ("Differential tests").

import { describeAPIDifferential } from "./testing/differential/api.ts";
import { describeCheckpointDifferential } from "./testing/differential/checkpoint.ts";
import { describeCosigDifferential } from "./testing/differential/cosig.ts";
import { describeCTLogDifferential } from "./testing/differential/ctlog.ts";
import { describeEd25519Differential } from "./testing/differential/ed25519.ts";
import { describeGoStdDifferential, describeUnicodeDifferential } from "./testing/differential/gostd.ts";
import { describeLayoutDifferential } from "./testing/differential/layout.ts";
import { describeMerkleDifferential } from "./testing/differential/merkle.ts";
import { describeNoteDifferential } from "./testing/differential/note.ts";
import { describeRootDifferential } from "./testing/differential/root.ts";

describeUnicodeDifferential("Chromium");
describeGoStdDifferential();
describeCheckpointDifferential();
describeNoteDifferential();
describeEd25519Differential();
describeCosigDifferential();
describeLayoutDifferential();
describeMerkleDifferential();
describeRootDifferential();
describeAPIDifferential();
describeCTLogDifferential();
