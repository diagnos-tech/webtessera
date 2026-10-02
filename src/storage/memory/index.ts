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

// Package memory keeps a Tessera log in memory: the browser's counterpart of the POSIX
// driver, and the reference backend for the ObjectStore driver. See
// docs/decisions/0104-objectstore-public-api.md.

export { type MemoryDriverConfig, MemoryObjectStore, newMemoryDriver } from "./memory.ts";
