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
// Where the server commits what it witnessed: a bucket on any S3-compatible service (AWS S3,
// Cloudflare R2, MinIO, ...) when the S3_* variables say which, and otherwise an ObjectStore of
// the server's own. Both are webtessera/mirror sinks, so nothing else changes.

import { newS3Sink, type Sink } from "webtessera/mirror";
import type { ObjectStore } from "webtessera/storage/objectstore";

/** S3Variables are the environment variables that select a bucket, as the library's own S3 tests name them. */
export const S3Variables = [
	"S3_ENDPOINT",
	"S3_BUCKET",
	"S3_REGION",
	"S3_ACCESS_KEY_ID",
	"S3_SECRET_ACCESS_KEY",
] as const;

/** CommitSink is the chosen sink, and a description of it for the logs. */
export interface CommitSink {
	readonly sink: Sink;
	readonly description: string;
}

/**
 * chooseSink returns the S3 bucket env names, or fallback if it names none. Naming only some is
 * an error: a server that silently fell back to local storage would not commit where its
 * operator thinks it does.
 */
export function chooseSink(env: Readonly<Record<string, string | undefined>>, fallback: ObjectStore): CommitSink {
	const set = S3Variables.filter((name) => (env[name] ?? "") !== "");
	if (set.length === 0) {
		return { sink: fallback, description: "the server's own database (set the S3_* variables to use a bucket)" };
	}
	if (set.length < S3Variables.length) {
		const missing = S3Variables.filter((name) => !set.includes(name));
		throw new Error(`set all of ${S3Variables.join(", ")}, or none; missing ${missing.join(", ")}`);
	}
	const value = (name: (typeof S3Variables)[number]): string => env[name] ?? "";
	return {
		sink: newS3Sink({
			endpoint: value("S3_ENDPOINT"),
			bucket: value("S3_BUCKET"),
			region: value("S3_REGION"),
			accessKeyId: value("S3_ACCESS_KEY_ID"),
			secretAccessKey: value("S3_SECRET_ACCESS_KEY"),
			prefix: env.S3_PREFIX ?? "session-receipts/",
		}),
		description: `bucket ${value("S3_BUCKET")} at ${value("S3_ENDPOINT")}`,
	};
}
