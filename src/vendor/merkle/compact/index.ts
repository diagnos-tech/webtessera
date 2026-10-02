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

// Barrel for the `compact` package: it re-exports exactly what Go exports from
// merkle/compact. Members that are unexported upstream (Range's fields,
// getMergePath) stay reachable only through the individual modules, which is
// this port's stand-in for Go's package-private visibility.
// See docs/decisions/0010-package-private-members.md.

export { NodeID, newNodeID, rangeNodes, rangeSize } from "./nodes.ts";
export { decompose, type HashFn, Range, RangeFactory, type VisitFn } from "./range.ts";
