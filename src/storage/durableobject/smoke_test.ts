import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { tilePath } from "../../api/layout/index.ts";

it("runs inside workerd with Durable Object storage", async () => {
	const ns = (env as unknown as { TEST_LOG: DurableObjectNamespace }).TEST_LOG;
	const stub = ns.get(ns.idFromName("smoke"));
	const got = await runInDurableObject(stub, async (_instance, state) => {
		await state.storage.put("k", new Uint8Array([1, 2, 3]));
		return state.storage.get<Uint8Array>("k");
	});
	expect(got).toEqual(new Uint8Array([1, 2, 3]));
	expect(tilePath(0n, 1234067n, 0)).toBe("tile/0/x001/x234/067");
});
