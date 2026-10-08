import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadIdentity } from "../src/identity.ts";
import { AgentRuntime } from "../src/runtime.ts";

test("both agents prefill the fixed origin and retained connections survive new defaults", async () => {
	for (const role of ["A", "B"] as const) {
		const root = await mkdtemp(join(tmpdir(), "raziel-connection-default-"));
		try {
			const identity = await loadIdentity(root);
			const options = { role, root, signer: identity.signer };
			const runtime = new AgentRuntime({
				...options,
				defaultBaseUrl: "https://fixed-example.ngrok-free.app",
			});
			assert.deepEqual((await runtime.view()).connection, {
				configured: false,
				baseUrl: "https://fixed-example.ngrok-free.app",
				audience: "",
			});
			await runtime.access.store.update((state) => {
				state.credentials = {
					baseUrl: "https://retained-example.ngrok-free.app",
					audience: "retained-installation",
					agentId: "retained-agent",
					token: "private-test-token",
				};
			});
			const restarted = new AgentRuntime({
				...options,
				defaultBaseUrl: "https://different-example.ngrok-free.app",
			});
			assert.deepEqual((await restarted.view()).connection, {
				configured: true,
				baseUrl: "https://retained-example.ngrok-free.app",
				audience: "retained-installation",
				agentId: "retained-agent",
			});
			assert.equal(
				JSON.stringify(await restarted.view()).includes("private-test-token"),
				false,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
});
