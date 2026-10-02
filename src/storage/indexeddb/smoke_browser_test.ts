import { expect, it } from "vitest";
import { tilePath } from "../../api/layout/index.ts";

it("runs in a real browser with IndexedDB and Web Locks", async () => {
	expect(typeof indexedDB.open).toBe("function");
	expect(typeof navigator.locks.request).toBe("function");
	expect(tilePath(0n, 1234067n, 0)).toBe("tile/0/x001/x234/067");
});
