#!/usr/bin/env node
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

// Decides whether this workflow run may release, and as what. Called first by
// .github/workflows/release.yml, before any build, so that a mistake costs seconds rather
// than a full CI run.
//
// It fails unless all of these hold:
//
//   - package.json "version" is a plain semantic version (X.Y.Z or X.Y.Z-prerelease);
//   - the Git tag is exactly v<version>, and CHANGELOG.md has a "## [<version>]" section;
//   - when triggered by a published GitHub Release, the Release's pre-release flag agrees
//     with the version (a pre-release version must be marked as one and vice versa), because
//     the flag is what a human sees and the version is what picks the npm dist-tag;
//   - a real publish, as opposed to a dry run, starts from a tag.
//
// A dry run applies the same rules wherever it starts from, so that it fails exactly where
// the real run would; on a branch the tag is taken to be v<version>.
//
// Inputs, all from the environment the workflow already has:
//
//     GITHUB_EVENT_NAME, GITHUB_REF_TYPE, GITHUB_REF_NAME   set by Actions
//     RELEASE_TAG, RELEASE_PRERELEASE                       github.event.release.{tag_name,prerelease}
//     DRY_RUN                                               "true" or "false" (workflow_dispatch input)
//
// Outputs, written to $GITHUB_OUTPUT when set and always printed: version, tag, dist-tag,
// dry-run. Zero dependencies; needs Node >= 20.

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const env = process.env;

const problems = [];
const fail = (message) => problems.push(message);

const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
// Semantic Versioning without build metadata: "+" is not allowed in a Git tag name used here
// and npm ignores it for ordering anyway.
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
if (typeof version !== "string" || !semver.test(version)) {
	fail(`package.json version ${JSON.stringify(version)} is not X.Y.Z or X.Y.Z-prerelease`);
}
const isPrerelease = typeof version === "string" && version.includes("-");
const expectedTag = `v${version}`;

const event = env.GITHUB_EVENT_NAME ?? "";
const refType = env.GITHUB_REF_TYPE ?? "";
const refName = env.GITHUB_REF_NAME ?? "";

let dryRun;
let tag;
if (event === "release") {
	dryRun = false;
	tag = env.RELEASE_TAG ?? "";
	if (refType !== "tag" || refName !== tag) {
		fail(`the run is on ${refType} ${JSON.stringify(refName)}, not on the release tag ${JSON.stringify(tag)}`);
	}
	const flagged = env.RELEASE_PRERELEASE === "true";
	if (flagged !== isPrerelease) {
		fail(
			isPrerelease
				? `version ${version} is a pre-release but the GitHub Release is not marked "pre-release"`
				: `the GitHub Release is marked "pre-release" but version ${version} is not a pre-release version`,
		);
	}
} else if (event === "workflow_dispatch") {
	dryRun = env.DRY_RUN !== "false";
	if (refType === "tag") {
		tag = refName;
	} else {
		tag = expectedTag;
		if (!dryRun) {
			fail(`a real publish must run from a version tag, not from ${refType} ${JSON.stringify(refName)}`);
		}
	}
} else {
	fail(`unsupported event ${JSON.stringify(event)}; releases run on "release" and "workflow_dispatch"`);
	dryRun = true;
	tag = "";
}

if (tag !== "" && tag !== expectedTag) {
	fail(`tag ${tag} does not match package.json version ${version} (expected ${expectedTag})`);
}

const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
if (!changelog.split("\n").some((line) => line.startsWith(`## [${version}]`))) {
	fail(`CHANGELOG.md has no "## [${version}]" section: rename "## [Unreleased]" before releasing`);
}

if (problems.length > 0) {
	for (const p of problems) {
		process.stderr.write(`::error title=Release check failed::${p}\n`);
	}
	process.stderr.write(`\ncheck-release: ${problems.length} problem(s)\n`);
	process.exit(1);
}

const outputs = {
	version,
	tag,
	// Pre-releases must not become `latest`, or `npm install webtessera` would pick them up.
	"dist-tag": isPrerelease ? "next" : "latest",
	"dry-run": String(dryRun),
};
for (const [key, value] of Object.entries(outputs)) {
	process.stdout.write(`${key}=${value}\n`);
	if (env.GITHUB_OUTPUT) {
		appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
	}
}
