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

// Serves the built site (dist/) under its base path the way GitHub Pages does: a directory is
// served by its index.html, a directory asked for without its trailing slash is redirected to
// it, and anything else that does not exist gets 404.html with status 404. The smoke test uses
// it; run on its own (`bun run preview`), it serves dist/ at http://localhost:4173/<base>.

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

/** siteDir is the site package's directory, and distDir its build output. */
export const siteDir = fileURLToPath(new URL("..", import.meta.url));
export const distDir = join(siteDir, "dist");

const types: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff2": "font/woff2",
	".xml": "application/xml",
	".txt": "text/plain; charset=utf-8",
	".json": "application/json",
};

/** Served is a running server: the URL of the site's home page, and how to stop it. */
export interface Served {
	readonly url: string;
	close(): Promise<void>;
}

/** serve starts the server on a port (0 for any free one) and resolves once it listens. */
export function serve(base: string, port = 0, dir = distDir): Promise<Served> {
	const server = createServer((req, res) => {
		const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
		const send = (status: number, file: string) => {
			res.writeHead(status, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
			res.end(readFileSync(file));
		};
		const notFound = () => send(404, join(dir, "404.html"));
		if (!path.startsWith(base)) {
			notFound();
			return;
		}
		const file = normalize(join(dir, path.slice(base.length)));
		if (!file.startsWith(dir)) {
			notFound();
		} else if (existsSync(file) && statSync(file).isFile()) {
			send(200, file);
		} else if (existsSync(join(file, "index.html"))) {
			if (path.endsWith("/")) {
				send(200, join(file, "index.html"));
			} else {
				res.writeHead(301, { Location: `${path}/` });
				res.end();
			}
		} else {
			notFound();
		}
	});
	return new Promise((resolve) => {
		server.listen(port, "127.0.0.1", () => {
			const address = server.address();
			const actual = typeof address === "object" && address !== null ? address.port : port;
			resolve({
				url: `http://127.0.0.1:${actual}${base}`,
				close: () => new Promise((done) => server.close(() => done())),
			});
		});
	});
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
	const { siteConfig } = await import("../src/lib/url.ts");
	const served = await serve(siteConfig().base, 4173);
	process.stdout.write(`Serving ${distDir} at ${served.url}\n`);
}
