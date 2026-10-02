import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// The main suite runs on plain Node. Almost all of webtessera is pure code
// (Merkle, note, layout, integration, client) with no runtime dependency beyond
// @noble/*, and Node runs a suite of this size far faster than a browser or
// workerd would.
//
// Runtime-specific storage drivers have their own configs:
//   - vitest.workers.config.ts runs the Durable Object driver inside workerd.
//   - vitest.browser.config.ts runs the IndexedDB driver inside real Chromium.
//
// Test files are named `*_test.ts`, not `*.test.ts`, mirroring upstream's
// `*_test.go` so that a side-by-side diff against the Go original stays trivial
// (see PORTING.md §3.1).
export default defineConfig({
	resolve: { alias: selfAliases() },
	test: {
		include: ["src/**/*_test.ts"],
		exclude: ["src/storage/durableobject/**", "src/**/*_browser_test.ts", "**/node_modules/**"],
		testTimeout: 20_000,
	},
});

/**
 * selfAliases lets tests import the package by its published name
 * (`import { newAppender } from "webtessera"`), resolved to the TypeScript
 * sources rather than to dist/. It is derived from package.json's exports map,
 * so a test that imports a subpath also proves that subpath points at a real
 * module. src/README_test.ts relies on it to run the README's snippets verbatim.
 */
function selfAliases(): { find: RegExp; replacement: string }[] {
	const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
		name: string;
		exports: Record<string, string>;
	};
	return Object.entries(pkg.exports)
		.filter(([, target]) => target.startsWith("./dist/") && target.endsWith(".js"))
		.map(([subpath, target]) => ({
			find: new RegExp(`^${(pkg.name + subpath.slice(1)).replaceAll("/", "\\/")}$`),
			replacement: new URL(`./src/${target.slice("./dist/".length, -".js".length)}.ts`, import.meta.url).pathname,
		}));
}
