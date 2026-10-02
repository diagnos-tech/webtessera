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

// Creates the S3 bucket that the services tests use, retrying until the server accepts
// requests. Configuration comes from the same S3_* variables the tests read (services.env).
//
// It signs the request with aws4fetch, a devDependency the repository already has, so the
// job needs no S3 client image or CLI. aws4fetch itself retries 5xx answers and network errors
// for a few seconds; the loop below is the patient layer on top, for a container that is still
// starting. Creating a bucket that already exists counts as success, which keeps a re-run of
// the job on a reused machine harmless.

import { AwsClient } from "aws4fetch";

const attempts = 15;
const delayMs = 2000;

function required(name) {
	const value = process.env[name];
	if (!value) {
		process.stderr.write(`create-bucket: ${name} is not set (see services.env)\n`);
		process.exit(2);
	}
	return value;
}

const endpoint = required("S3_ENDPOINT").replace(/\/+$/, "");
const bucket = required("S3_BUCKET");
const client = new AwsClient({
	accessKeyId: required("S3_ACCESS_KEY_ID"),
	secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
	region: required("S3_REGION"),
	service: "s3",
});

let lastError = "";
for (let attempt = 1; attempt <= attempts; attempt++) {
	try {
		const res = await client.fetch(`${endpoint}/${bucket}`, { method: "PUT" });
		// 200: created. 409: BucketAlreadyOwnedByYou (or BucketAlreadyExists, which our
		// credentials would not be able to use, and the tests will then say so).
		if (res.ok || res.status === 409) {
			process.stdout.write(`create-bucket: bucket "${bucket}" is ready (HTTP ${res.status})\n`);
			process.exit(0);
		}
		// 4xx other than 409 will not fix itself: stop retrying and show the server's reason.
		const body = (await res.text()).slice(0, 500);
		lastError = `HTTP ${res.status}: ${body}`;
		if (res.status >= 400 && res.status < 500) {
			break;
		}
	} catch (err) {
		lastError = err instanceof Error ? err.message : String(err);
	}
	process.stdout.write(`create-bucket: attempt ${attempt}/${attempts} failed (${lastError}); retrying\n`);
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

process.stderr.write(`create-bucket: could not create bucket "${bucket}" at ${endpoint}: ${lastError}\n`);
process.exit(1);
