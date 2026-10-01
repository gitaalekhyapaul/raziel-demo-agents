import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";

test("real message channel authenticates each role, deduplicates, and stores only bounded payloads", async () => {
	const root = await mkdtemp(join(tmpdir(), "raziel-channel-"));
	const listener = createServer();
	listener.listen(0, "127.0.0.1");
	await once(listener, "listening");
	const port = (listener.address() as { port: number }).port;
	await new Promise<void>((resolve) => listener.close(() => resolve()));
	const tokenA = "synthetic-channel-a-".padEnd(40, "a");
	const tokenB = "synthetic-channel-b-".padEnd(40, "b");
	const child = spawn(process.execPath, ["src/channel.ts"], {
		env: {
			...process.env,
			PORT: String(port),
			CHANNEL_STATE_DIR: root,
			CHANNEL_TOKEN_A: tokenA,
			CHANNEL_TOKEN_B: tokenB,
		},
		stdio: "ignore",
	});
	const exited = once(child, "exit");
	const base = `http://127.0.0.1:${port}`;
	try {
		let healthy = false;
		for (let attempt = 0; attempt < 50 && !healthy; attempt++) {
			try {
				healthy = (await fetch(`${base}/health`)).ok;
			} catch {}
			if (!healthy) await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(healthy, true);
		const call = (token: string, path: string, body?: unknown) =>
			fetch(`${base}${path}`, {
				method: body ? "POST" : "GET",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				...(body ? { body: JSON.stringify(body) } : {}),
			});
		assert.equal((await call("wrong", "/tasks")).status, 401);
		const taskId = randomUUID();
		assert.equal((await call(tokenB, "/tasks", { taskId })).status, 400);
		assert.equal((await call(tokenA, "/tasks", { taskId })).status, 200);
		const lookup = {
			id: randomUUID(),
			kind: "lookup",
			payload: {
				transactionReference: "processor-001",
				merchantReference: "recon-exact-001",
				amountMinor: "12500",
				currency: "SGD",
			},
		};
		const path = `/tasks/${taskId}/messages`;
		assert.equal((await call(tokenB, path, lookup)).status, 400);
		const first = await (await call(tokenA, path, lookup)).json();
		assert.deepEqual(await (await call(tokenA, path, lookup)).json(), first);
		assert.equal(
			(
				await call(tokenA, path, {
					...lookup,
					payload: { ...lookup.payload, amountMinor: "1" },
				})
			).status,
			409,
		);
		const result = {
			id: randomUUID(),
			kind: "settlement_result",
			payload: {
				status: "matched",
				transactionReference: "processor-001",
				currency: "SGD",
				evidenceReceiptId: "receipt-001",
				candidateCount: 1,
				settlementReference: "bank-001",
				settlementAmountMinor: "12500",
				amountDifferenceMinor: "0",
			},
		};
		assert.equal(
			(
				await call(tokenB, path, {
					...result,
					payload: { ...result.payload, capability: "forbidden" },
				})
			).status,
			400,
		);
		assert.equal((await call(tokenB, path, result)).status, 200);
		const tasks = (await (await call(tokenA, "/tasks")).json()) as {
			messages: unknown[];
		}[];
		assert.equal(tasks[0]?.messages.length, 2);
		const stored = await readFile(join(root, "messages.json"), "utf8");
		for (const secret of [tokenA, tokenB, "capability"])
			assert.equal(stored.includes(secret), false);
	} finally {
		child.kill("SIGTERM");
		await exited;
		await rm(root, { recursive: true, force: true });
	}
});
