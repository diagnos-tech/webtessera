// Copyright 2025 The Tessera authors. All Rights Reserved.
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
// Ported from tessera/internal/migrate/migrate.go @ 4a6d9f9
//
// Port note: this file is not part of the witness/migrate work package's assigned file
// list, but src/migrate_lifecycle.ts (which is) cannot compile without it -- Go's
// `migrate_lifecycle.go` imports `internal/migrate` directly for the `MigrationWriter`
// interface a storage `Driver` must implement to support `NewMigrationTarget`. It is a
// three-method interface with no logic of its own and no upstream test file, so it is
// ported alongside the rest of this package rather than left as a placeholder -- the same
// judgement call docs/decisions/0056-future-ported-ahead-of-schedule.md made for
// `internal/future/future.go` when a different work package needed it early. See
// docs/decisions/0076-internal-migrate-ported-ahead-of-schedule.md.

// Package migrate contains internal implementations for migration.

/**
 * MigrationWriter is the interface a storage `Driver` must implement in order to act as
 * the target of a log migration (see `NewMigrationTarget` in src/migrate_lifecycle.ts).
 *
 * Port note: every method's `ctx context.Context` moves to an optional trailing `signal`
 * parameter, per docs/decisions/0004-errors-context-and-concurrency.md.
 */
export interface MigrationWriter {
	/**
	 * setEntryBundle stores the provided serialised entry bundle at the location implied by the provided
	 * entry bundle index and partial size.
	 *
	 * Bundles may be set in any order (not just consecutively), and the implementation should integrate
	 * them into the local tree in the most efficient way possible.
	 *
	 * Writes should be idempotent; repeated calls to set the same bundle with the same data should not
	 * throw an error.
	 */
	setEntryBundle(idx: bigint, partial: number, bundle: Uint8Array, signal?: AbortSignal): Promise<void>;

	/**
	 * awaitIntegration should block until the local integrated tree has grown to the provided size,
	 * and should return the locally calculated root hash derived from the integration of the contents of
	 * entry bundles set using setEntryBundle above.
	 */
	awaitIntegration(size: bigint, signal?: AbortSignal): Promise<Uint8Array>;

	/** integratedSize returns the current size of the locally integrated log. */
	integratedSize(signal?: AbortSignal): Promise<bigint>;
}
