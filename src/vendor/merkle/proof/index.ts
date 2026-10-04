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

// Barrel for the `proof` package: it re-exports exactly what Go exports from
// merkle/proof. Members that are unexported upstream (Nodes' begin/end/ephem
// fields, skipFirst, decompInclProof and the chain* helpers) stay reachable
// only through the individual modules, or not at all.
// See docs/decisions/0010-package-private-members.md.
//
// Nodes is exported as Go exports it: its IDs field is `ids`, and `new Nodes(ids)` is
// Go's `proof.Nodes{IDs: ids}`, the literal code outside the package may write.
//
// One deliberate difference, type-only (docs/decisions/0208-merkle-barrels-and-tuple-returns.md):
// LogHasher, which Go declares in the root `merkle` package (merkle/hasher.go), is
// re-exported as a type. The root package has no entry point of its own in this port,
// and every verifier here takes a LogHasher, so this is where a caller implementing
// one finds the interface to implement.

export type { LogHasher } from "../hasher.ts";
export { consistency, inclusion, Nodes } from "./proof.ts";
export { RootMismatchError, rootFromInclusionProof, verifyConsistency, verifyInclusion } from "./verify.ts";
