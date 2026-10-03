import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// The tests run in a real, headless Chromium: the log's IndexedDB storage, the Web Locks that
// let tabs share it, and the non-extractable WebCrypto device key are the browser's own, not
// Node polyfills. `npx playwright install chromium` provides the browser once;
// PLAYWRIGHT_CHROMIUM_EXECUTABLE points at another Chromium instead.
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
