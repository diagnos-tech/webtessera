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

// Package testonly holds helpers for testing personalities built on webtessera, as
// Tessera's `testonly` package does for Go. Published as `webtessera/testonly`.
//
// The golden-fixture loader in fixtures.ts is this repository's own test support and is
// deliberately not exported.

export { type NewTestLogResult, newTestLog, type TestLog } from "./testlog.ts";
