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

// Runs the golden compatibility suite (../objectstore/testing/golden.ts) over MemoryObjectStore
// inside workerd. The memory backend itself is proven on Node by
// ../objectstore/driver_fixtures_test.ts; what this adds is evidence that the suite, its
// fixture loading and the driver run unchanged on the Workers runtime, which the SQLite engines
// that live there (D1, Durable Object SQL) depend on when they call the same suite.

import { describeGoldenCompatibility } from "../objectstore/testing/golden.ts";
import { MemoryObjectStore } from "./memory.ts";

describeGoldenCompatibility("memory (workerd)", () => new MemoryObjectStore(), { listKeys: (s) => s.keys() });
