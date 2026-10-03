import { defineConfig } from "vitest/config";

// The tests run on Node: the server in-process, and the browser's own session code (client/src)
// with an in-memory log instead of IndexedDB, talking to the server through its fetch handler.
// No network, no external service; the S3 test runs only when the S3_* variables are set.
// The browser test has its own config, vitest.browser.config.ts.
export default defineConfig({
	test: {
		include: ["test/**/*_test.ts"],
		exclude: ["test/**/*_browser_test.ts", "**/node_modules/**"],
		testTimeout: 30_000,
	},
});
