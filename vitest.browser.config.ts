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
