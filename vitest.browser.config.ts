import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Runs the `*_browser_test.ts` suites inside a real, headless Chromium, so that
// the IndexedDB driver is exercised against the browser's own IndexedDB and Web
// Locks implementations rather than a Node polyfill.
//
// Locally, `pnpm exec playwright install chromium` provides the browser once.
// PLAYWRIGHT_CHROMIUM_EXECUTABLE overrides it with a preinstalled binary.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
	// Pre-bundle noble up front: discovering it mid-run makes Vite reload the test page.
	// sqlite-wasm ships its own worker and .wasm files, which Vite's pre-bundling would
	// break; excluding it also stops Vite reloading the page mid-run when it discovers it.
	optimizeDeps: {
		include: ["@noble/curves/ed25519.js", "@noble/hashes/sha2.js"],
		exclude: ["@sqlite.org/sqlite-wasm"],
	},
	test: {
		include: ["src/**/*_browser_test.ts"],
		testTimeout: 30_000,
		browser: {
			enabled: true,
			headless: true,
			provider: playwright(executablePath ? { launchOptions: { executablePath } } : {}),
			instances: [{ browser: "chromium" }],
		},
	},
});
