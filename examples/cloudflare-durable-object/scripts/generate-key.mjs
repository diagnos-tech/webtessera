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

// Generates a signing key for the log: `bun run keygen <origin>`, where origin names the
// log, conventionally the URL it is served at without the scheme
// (`log.example.com/v1`). The private key is the LOG_PRIVATE_KEY secret; the public
// key is what clients verify checkpoints with.

import { generateKey } from "webtessera/note";

const origin = process.argv[2];
if (origin === undefined || origin === "") {
	process.stderr.write("usage: bun run keygen <origin>, e.g. bun run keygen log.example.com/v1\n");
	process.exit(2);
}

const { skey, vkey } = generateKey(undefined, origin);
process.stdout.write(
	[
		`Private key (keep it secret; pass it to \`wrangler secret put LOG_PRIVATE_KEY\` and put it in .dev.vars):`,
		`  ${skey}`,
		"",
		"Public key (publish it; clients verify checkpoints with it):",
		`  ${vkey}`,
		"",
		"For local development:",
		`  echo 'LOG_PRIVATE_KEY=${skey}' > .dev.vars`,
		"",
	].join("\n"),
);
