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
//
// Golden-fixture coverage for driver.ts: the compatibility proof for the whole driver. See
// the header of api/layout/paths_fixtures_test.ts for why these live outside the
// Go-mirrored test file.
//
// fixtures/data/log_<N>.json is a complete log built by the real Tessera POSIX driver
// (fixtures/gen/log.go). storage/internal/integrate_fixtures_test.ts already shows that the
// tree-building engine computes the same tiles; the shared golden suite
// (testing/golden.ts) goes further and runs the same appends through the public newAppender
// API and this driver, then compares the store with the directory Go left behind. Every
// backend runs that suite; this file runs it over MemoryObjectStore, the reference backend,
// with the store's own key listing as the source of truth for which keys it holds.

import { MemoryObjectStore } from "../memory/memory.ts";
import { describeGoldenCompatibility } from "./testing/golden.ts";

describeGoldenCompatibility("memory", () => new MemoryObjectStore(), { listKeys: (s) => s.keys() });
