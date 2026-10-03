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
 * webtessera/mirror copies a tlog-tiles log from wherever it is served into storage you
 * control: an S3-compatible bucket, any webtessera ObjectStore, or anything else with a `put`.
 *
 * {@link Mirror} is the port of Tessera's experimental mirror
 * (`cmd/experimental/mirror/internal/mirror.go`): it copies the tiles and entry bundles the
 * target does not have yet, in parallel, and writes the source's checkpoint last, so the
 * target only ever publishes a checkpoint whose resources are all in place, and a run that
 * stops halfway resumes from the last checkpoint written. Like upstream's, it copies bytes
 * without checking them.
 *
 * # Mirroring someone else's log
 *
 * A mirror publishes whatever its source serves, so a log you do not operate should be
 * mirrored with {@link newVerifiedMirror}, which puts a {@link VerifyingSource} in front of
 * the copy: the source's checkpoint must carry the log's signature and extend what was
 * mirrored before, and each tile and bundle must be proven part of the tree that checkpoint
 * commits to before it is written. URL sources are read without following redirects and with
 * bounded responses ({@link newSourceFetch}).
 *
 * ```ts
 * import { newVerifier } from "webtessera/note";
 * import { newS3Sink, newVerifiedMirror } from "webtessera/mirror";
 *
 * const mirror = newVerifiedMirror({
 *   source: "https://log.example/",
 *   origin: "log.example",
 *   verifier: newVerifier(logVkey),
 *   target: newS3Sink({ endpoint, bucket, region, accessKeyId, secretAccessKey }),
 * });
 * await mirror.run(signal);          // run again on a schedule to follow the log
 * ```
 *
 * # Where it can go
 *
 * A {@link Sink} is anything with `put(key, bytes)`, and optionally `get(key)` to resume:
 *
 *   - {@link newS3Sink}: any S3-compatible service (AWS S3, Cloudflare R2, Google Cloud
 *     Storage's XML API, Backblaze B2, MinIO, Ceph, ...), over fetch, signed with AWS
 *     Signature Version 4, storing each object with the `Content-Type` and `Cache-Control`
 *     tlog-tiles prescribes so that the bucket can be served publicly as it is;
 *   - any webtessera `ObjectStore` (memory, IndexedDB, SQLite, Durable Object storage);
 *   - object-storage bindings with the same shape, such as a Cloudflare Workers R2 binding,
 *     or a two-line wrapper around another SDK.
 *
 * {@link newSinkTarget} adapts a Sink into the mirror's {@link Target}, under an optional key
 * prefix; the result can also be read back, as a fetcher for `webtessera/fsck`.
 *
 * @module
 */

export { MaxResourceBytes, newSourceFetch, type SourceFetchOptions } from "./fetch.ts";
export { Mirror, type MirrorProgress, type Source, type Target } from "./mirror.ts";
export { isRecoverable, RetryError, unrecoverable } from "./retry.ts";
export { newS3Sink, S3Error, S3Sink, type S3SinkOptions } from "./s3.ts";
export { type AwsCredentials, type SignedV4, type SignV4Input, signV4 } from "./sigv4.ts";
export { newSinkTarget, type Sink, type SinkObject, SinkTarget, type SinkTargetOptions } from "./sink.ts";
export {
	MaxCheckpointBytes,
	newVerifiedMirror,
	newVerifyingSource,
	type VerifiedMirrorOptions,
	VerifyingSource,
	type VerifyingSourceOptions,
} from "./verify.ts";
