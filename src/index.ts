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

/**
 * webtessera is a TypeScript port of Tessera (https://github.com/transparency-dev/tessera), the
 * tile-based transparency log framework, for browsers and edge runtimes. It reads and writes
 * logs in the C2SP tlog-tiles format (https://c2sp.org/tlog-tiles), compatibly with Tessera.
 *
 * This module is the counterpart of Tessera's root Go package, `tessera`. It is the API of a
 * personality: the application that owns a log and decides what goes into it. Everything a
 * personality needs to append to a log, wait for entries to be published, migrate an existing log
 * in, and configure witnessing lives here. The rest of the package is split across subpaths, as
 * Tessera splits it across Go packages.
 *
 * # Writing to a log
 *
 * A personality picks a storage driver, configures an {@link AppendOptions}, and starts an
 * {@link Appender} on the driver with {@link newAppender}:
 *
 * ```ts
 * const opts = newAppendOptions().withCheckpointSigner(signer);
 * const { appender, shutdown, reader } = await newAppender(driver, opts, signal);
 *
 * const future = appender.add(newEntry(data), signal);
 * const { index, isDup } = await future();
 * ```
 *
 * The future resolves once the entry has been durably assigned an index, not once it is visible to
 * clients of the log. A {@link PublicationAwaiter} bridges that gap by resolving once a published
 * checkpoint commits to the entry, which is what a personality that returns an inclusion proof
 * needs. Call the returned `shutdown` before aborting the signal, so that every entry the
 * appender accepted is integrated and published.
 *
 * Logs that must keep the Static CT API layout (CT logs participating in the CT ecosystem, and
 * only those) use {@link newCertificateTransparencyAppender} and {@link withCTLayout}.
 *
 * Logs are not only created: {@link newMigrationTarget} imports an existing tlog-tiles or Static
 * CT log, and {@link newWitnessGroupFromPolicy} turns a witness policy into the
 * {@link WitnessGroup} that {@link AppendOptions.withWitnesses} takes.
 *
 * # Other entry points
 *
 * Reading and verifying a log is a separate concern and has its own subpath, as it has its own
 * package in Tessera:
 *
 *   - `webtessera/client`: fetchers, proof building and entry streaming (Go: `client`).
 *   - `webtessera/storage/*`: the storage drivers to hand to {@link newAppender}, one subpath per
 *     backend (in-memory, IndexedDB, any SQLite engine, or an object store of your own).
 *   - `webtessera/api`, `webtessera/api/layout`: the tlog-tiles resource formats and paths.
 *   - `webtessera/ctonly`: the Static CT API entry type that
 *     {@link newCertificateTransparencyAppender} accepts.
 *   - `webtessera/fsck`: whole-log verification.
 *   - `webtessera/note`, `webtessera/formats/log`, `webtessera/merkle/*`: ports of the Go
 *     libraries that Tessera's own API is expressed in (signed notes and signers, checkpoints, the
 *     RFC 6962 hasher and compact ranges), for the types this module's functions take.
 *
 * # Conventions
 *
 * Names are Go's, with functions camelCased (`NewAppender` is {@link newAppender}); a Go method
 * that is declared in a different file from its type (`WithCTLayout`) is a free function. `uint64`
 * is `bigint`, `time.Duration` is a number of milliseconds, returned errors are thrown with the same
 * message text, and `context.Context` is an optional trailing `AbortSignal`. The reasoning is in
 * docs/decisions/, starting at ADR-0002, ADR-0003 and ADR-0004.
 *
 * What this module exports is exactly what Tessera's root package exports, plus a few names
 * TypeScript needs to express the same contract (docs/decisions/0133-package-root-barrel.md).
 * Helpers that exist only so that this repository's tests can reach what Go's in-package tests
 * reach are deliberately absent, whatever their file says about being exported.
 *
 * @module
 */

export {
	type AddFn,
	Appender,
	type AppenderInit,
	type AppendLifecycle,
	AppendOptions,
	DefaultAntispamInMemorySize,
	DefaultBatchMaxAge,
	DefaultBatchMaxSize,
	DefaultCheckpointInterval,
	DefaultCheckpointRepublishInterval,
	DefaultGarbageCollectionInterval,
	DefaultPushbackMaxOutstanding,
	DefaultWitnessTimeout,
	type Index,
	type IndexFuture,
	type NewAppenderResult,
	newAppender,
	newAppendOptions,
	WitnessOptions,
} from "./append_lifecycle.ts";
export { newPublicationAwaiter, PublicationAwaiter } from "./await.ts";
export { newCertificateTransparencyAppender, withCTLayout } from "./ct_only.ts";
export { Entry, newEntry } from "./entry.ts";
export { ErrNotExist, errorIs } from "./internal/gostd/errors.ts";
export type { Antispam, Follower, LogReader } from "./lifecycle.ts";
export { type Driver, ErrPushback, ErrPushbackAntispam, ErrPushbackIntegration } from "./log.ts";
export { MigrationOptions, MigrationTarget, newMigrationOptions, newMigrationTarget } from "./migrate_lifecycle.ts";
export { newWitness, newWitnessGroup, newWitnessGroupFromPolicy, Witness, WitnessGroup } from "./witness.ts";
