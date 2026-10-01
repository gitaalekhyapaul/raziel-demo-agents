import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { create, fromJson, toJson } from "@bufbuild/protobuf";
import {
	AccessIntentSchema,
	AccessIssuanceSubmissionSchema,
	AccessRequestSchema,
	AccessRequestState,
	createRazielClient,
	type RazielClient,
} from "@gitaalekhyapaul/raziel-sdk-ts";
import { newTask, taskInput } from "../src/access-tasks.ts";
import { ChannelClient, type ChannelTask } from "../src/channel-client.ts";
import { loadIdentity } from "../src/identity.ts";
import type { SettlementResult } from "../src/reconciliation.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { AppError } from "../src/storage.ts";

async function withRuntime(
	run: (runtime: AgentRuntime, base: RazielClient, id: string) => Promise<void>,
	channel?: ChannelClient,
) {
	const root = await mkdtemp(join(tmpdir(), "raziel-task-controls-"));
	try {
		const identity = await loadIdentity(root);
		const runtime = new AgentRuntime({
			role: "A",
			root,
			signer: identity.signer,
			channel,
		});
		const base = createRazielClient({
			baseUrl: "http://127.0.0.1:3000",
			audience: "synthetic",
			tokenProvider: () => "",
			signer: identity.signer,
		});
		const task = newTask(
			taskInput({
				label: "Reconcile processor ledger",
				datasetId: "processor-demo-v1",
				datasetRevision: 1,
				fromOccurredAt: "2026-10-01T00:00:00Z",
				toOccurredAt: "2026-10-01T23:59:59Z",
			}),
		);
		await runtime.access.store.update((state) => state.tasks.push(task));
		await run(runtime, base, task.id);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

for (const pauseDuring of ["status", "signing"]) {
	test(`pause during ${pauseDuring} prevents issuance submission and resume retains the attempt`, async () => {
		await withRuntime(async (runtime, base, id) => {
			const intent = fromJson(
				AccessIntentSchema,
				(await runtime.access.get(id)).intent,
			);
			const request = create(AccessRequestSchema, {
				requestId: intent.requestId,
				state: AccessRequestState.AWAITING_SIGNATURE,
				generation: 2n,
				proposal: { proposalId: "controlled-proposal" },
			});
			const attempt = create(AccessIssuanceSubmissionSchema, {
				formatVersion: 1,
				proposalId: request.proposal!.proposalId,
				generation: request.generation,
			});
			let pause = true;
			let signs = 0;
			let submits = 0;
			const client: RazielClient = {
				...base,
				async getAccessRequest() {
					if (pause && pauseDuring === "status")
						await runtime.command(id, "pause");
					return request;
				},
				async signIssuance() {
					signs++;
					if (pause && pauseDuring === "signing")
						await runtime.command(id, "pause");
					return attempt;
				},
				async submitIssuance(requestId, submitted) {
					submits++;
					assert.equal(requestId, intent.requestId);
					assert.deepEqual(submitted, attempt);
					assert.deepEqual(
						(await runtime.access.get(id)).attempt,
						toJson(AccessIssuanceSubmissionSchema, attempt),
					);
					return create(AccessRequestSchema, {
						requestId,
						state: AccessRequestState.PROVING,
					});
				},
			};
			await runtime.command(id, "refresh", {}, client);
			assert.equal(signs, pauseDuring === "status" ? 0 : 1);
			assert.equal(submits, 0);
			assert.equal((await runtime.access.get(id)).paused, true);
			pause = false;
			await runtime.command(id, "resume", {}, client);
			assert.equal(signs, 1);
			assert.equal(submits, 1);
			assert.equal((await runtime.access.get(id)).phase, "PROVING");
		});
	});
}

test("paused cancellation keeps status polling until the terminal result without signing", async () => {
	await withRuntime(async (runtime, base, id) => {
		const intent = fromJson(
			AccessIntentSchema,
			(await runtime.access.get(id)).intent,
		);
		let state = AccessRequestState.PROVING;
		const current = () =>
			create(AccessRequestSchema, { requestId: intent.requestId, state });
		const client: RazielClient = {
			...base,
			async getAccessRequest() {
				return current();
			},
			async cancelAccessRequest() {
				state = AccessRequestState.CANCELLING;
				return current();
			},
			async signIssuance() {
				assert.fail("paused cancellation must not sign");
			},
		};
		await runtime.access.remember(id, current());
		await runtime.command(id, "pause");
		await runtime.command(id, "cancel", {}, client);
		assert.equal((await runtime.access.get(id)).phase, "CANCELLING");
		assert.equal(runtime.access.needsPoll(await runtime.access.get(id)), true);
		state = AccessRequestState.CANCELED;
		await runtime.command(id, "refresh", {}, client);
		const task = await runtime.access.get(id);
		assert.equal(task.phase, "CANCELED");
		assert.equal(task.paused, true);
		assert.equal(runtime.access.needsPoll(task), false);
	});
});

test("dashboard settlement result follows fresh messages and uses cached evidence only on channel failure", async () => {
	class ControlledChannel extends ChannelClient {
		inbox: ChannelTask[] = [];
		unavailable = false;
		override async list() {
			if (this.unavailable) throw new AppError("CHANNEL_UNAVAILABLE", 503);
			return this.inbox;
		}
	}
	const channel = new ControlledChannel("http://127.0.0.1:0", "controlled");
	await withRuntime(async (runtime, _base, id) => {
		const oldResult: SettlementResult = {
			status: "matched",
			transactionReference: "processor-001",
			currency: "SGD",
			evidenceReceiptId: "receipt-001",
			candidateCount: 1,
		};
		const newResult: SettlementResult = {
			...oldResult,
			status: "not_found",
			transactionReference: "processor-002",
			evidenceReceiptId: "receipt-002",
			candidateCount: 0,
		};
		await runtime.access.patch(id, { result: oldResult });
		channel.inbox = [
			{
				taskId: id,
				messages: [
					{
						id: "controlled-result",
						sender: "B",
						kind: "settlement_result",
						payload: newResult,
						createdAt: "2026-10-01T12:00:00Z",
					},
				],
			},
		];
		assert.deepEqual((await runtime.view()).tasks[0]!.result, newResult);
		channel.inbox = [];
		assert.equal((await runtime.view()).tasks[0]!.result, undefined);
		channel.unavailable = true;
		const cached = await runtime.view();
		assert.equal(cached.channelError, "CHANNEL_UNAVAILABLE");
		assert.deepEqual(cached.tasks[0]!.result, oldResult);
	}, channel);
});
