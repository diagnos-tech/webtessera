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

// What the site's scripts share: serving the built site with Vite's preview server, and
// launching the Chromium that Playwright drives. Playwright is the workspace root's
// development dependency (the library's browser tests use it); set
// PLAYWRIGHT_CHROMIUM_EXECUTABLE to use a Chromium installed elsewhere.

import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { preview } from "vite";

/** siteDir is the site package's directory. */
export const siteDir = fileURLToPath(new URL("..", import.meta.url));

/** Served is a running preview server. */
export interface Served {
	/** url is the page's URL, base path included. */
	readonly url: string;
	close(): Promise<void>;
}

/** serve starts Vite's preview server on the built site (dist/) on a free port. */
export async function serve(): Promise<Served> {
	const server = await preview({
		root: siteDir,
		logLevel: "error",
		preview: { port: 0, host: "127.0.0.1", open: false },
	});
	const url = server.resolvedUrls?.local[0];
	if (url === undefined) {
		throw new Error("the preview server did not report a URL");
	}
	return { url, close: () => server.close() };
}

/** launch starts a headless Chromium. */
export function launch(): Promise<Browser> {
	const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
	return chromium.launch(executablePath === undefined || executablePath === "" ? {} : { executablePath });
}
