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
// (see AGENTS.md §3.1).
export default defineConfig({
	test: {
		include: ["src/**/*_test.ts"],
		exclude: ["src/storage/durableobject/**", "src/**/*_browser_test.ts", "**/node_modules/**"],
		testTimeout: 20_000,
	},
});
