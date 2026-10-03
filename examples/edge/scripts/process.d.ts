// Declares the node:process exports keygen.ts uses; the Worker itself uses no Node APIs.
declare module "node:process" {
	export const argv: readonly string[];
	export function exit(code?: number): never;
}
