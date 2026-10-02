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

// Package objectstore runs the Tessera storage driver on top of any key/value backend that
// implements the ObjectStore contract. The driver is a port of tessera/storage/posix; see
// docs/decisions/0100-objectstore-driver.md and docs/decisions/0104-objectstore-public-api.md.
//
// This barrel is the package's public surface. The driver's Go-unexported internals
// (appender, logResourceStorage, the state codec) are reachable only by importing
// driver.ts or json.ts directly, per docs/decisions/0010-package-private-members.md.

export {
	MigrationStorage,
	type NewTreeFunc,
	newObjectStoreDriver,
	ObjectStoreDriver,
	type ObjectStoreDriverConfig,
} from "./driver.ts";
export type { ObjectInfo, ObjectStore } from "./objectstore.ts";
