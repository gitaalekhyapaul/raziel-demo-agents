import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toJson } from "@bufbuild/protobuf";
import {
	AccessRequestSchema,
	AccessIssuanceSubmissionSchema,
	AccessRequestState,
	createRazielClient,
	type DatasetQuery,
	type AccessIntent,
	type AccessIssuanceSubmission,
} from "@gitaalekhyapaul/raziel-sdk-ts";
import { loadIdentity } from "../src/identity.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { AppError } from "../src/storage.ts";
import { queryRange } from "../src/access-tasks.ts";

const input = {
	label: "Reconcile processor ledger",
	datasetId: "processor-demo-v1",
	datasetRevision: 1,
	fromOccurredAt: "2026-10-01T00:00:00Z",
	toOccurredAt: "2026-10-01T23:59:59Z",
};
test("query windows use whole-second UTC and stay within the SDK's 31-day bound", () => {
	const range = {
		fromOccurredAt: "2026-10-01T00:00:00Z",
		toOccurredAt: "2026-11-01T00:00:00Z",
	};
	assert.deepEqual(queryRange(range), range);
	for (const invalid of [
		{ ...range, toOccurredAt: "2026-11-01T00:00:01Z" },
		{ ...range, toOccurredAt: "2026-09-30T00:00:00Z" },
		{ ...range, fromOccurredAt: "2026-02-30T00:00:00Z" },
		{ ...range, fromOccurredAt: "2026-10-01T00:00:00.000Z" },
		{ ...range, datasetId: "other-dataset" },
		{ fromOccurredAt: range.fromOccurredAt },
	])
		assert.throws(() => queryRange(invalid), /INVALID_QUERY_RANGE/);
});

test("controlled follow-up queries retain the capability, intent, and dataset binding", async () => {
	const root = await mkdtemp(join(tmpdir(), "raziel-query-"));
	try {
		const identity = await loadIdentity(root);
		const base = createRazielClient({
			baseUrl: "http://127.0.0.1:3000",
			audience: "synthetic",
			tokenProvider: () => "",
			signer: identity.signer,
		});
		const capability = Uint8Array.of(1, 2, 3);
		const calls: Array<{
			dataset: string;
			capability: Uint8Array;
			range: DatasetQuery;
		}> = [];
		let unavailable = false;
		const factory = () => ({
			...base,
			async createAccessRequest(intent: AccessIntent) {
				return create(AccessRequestSchema, {
					requestId: intent.requestId,
					state: AccessRequestState.READY,
					capability,
				});
			},
			async queryDataset(
				dataset: string,
				retained: Uint8Array,
				range: DatasetQuery,
			) {
				calls.push({ dataset, capability: retained, range });
				if (unavailable) throw new AppError("SERVICE_UNAVAILABLE", 503);
				return {
					classification: "SYNTHETIC" as const,
					dataset_id: dataset,
					verification_path: "CACHE" as const,
					row_count: 0,
					rows: [],
					receipt: {
						format_version: 1 as const,
						receipt_id: "controlled-receipt",
						receipt_type: "AUDIT_RECEIPT_TYPE_PROTECTED_REQUEST" as const,
						request_id: "controlled-query",
						occurred_at: "2026-10-01T00:00:00Z",
						task_id: "controlled-task",
						capability_id: "controlled-capability",
						proof_job_id: "controlled-capability",
						policy_record_id: "controlled-policy",
						policy_hash: "00".repeat(32),
						snapshot_id: "controlled-snapshot",
						relationship_snapshot_root: "00".repeat(32),
						public_claims_digest: "00".repeat(32),
						proof_digest: "00".repeat(32),
						action: "query" as const,
						resource_type: "dataset",
						resource_scope: dataset,
						outcome: "AUDIT_OUTCOME_ACCEPTED" as const,
						reason_code: "PUBLIC_ERROR_CODE_UNSPECIFIED" as const,
					},
				};
			},
		});
		const runtime = new AgentRuntime({
			role: "A",
			root,
			signer: identity.signer,
			clientFactory: factory,
		});
		await runtime.access.store.update((state) => {
			state.credentials = {
				baseUrl: "http://127.0.0.1:3000",
				audience: "synthetic",
				token: "private",
				agentId: "a".repeat(32),
			};
		});
		const id = await runtime.start(input);
		const original = await runtime.access.get(id);
		await runtime.command(id, "query");
		const next = {
			fromOccurredAt: "2026-10-01T10:00:00Z",
			toOccurredAt: "2026-10-01T12:00:00Z",
		};
		await runtime.command(id, "query", next);
		assert.equal(calls.length, 2);
		for (const call of calls) {
			assert.equal(call.dataset, input.datasetId);
			assert.deepEqual(call.capability, capability);
			assert.equal(call.range.limit, 100);
		}
		assert.deepEqual(calls[1]!.range, { ...next, limit: 100 });
		const updated = await runtime.access.get(id);
		assert.deepEqual(updated.intent, original.intent);
		assert.deepEqual(updated.request, original.request);
		assert.equal(updated.fromOccurredAt, next.fromOccurredAt);
		assert.equal(updated.lastQuery?.receiptId, "controlled-receipt");
		await assert.rejects(
			runtime.command(id, "query", { ...next, datasetId: "other" }),
			/INVALID_QUERY_RANGE/,
		);
		assert.equal(calls.length, 2);
		unavailable = true;
		await assert.rejects(
			runtime.command(id, "query", {
				...next,
				toOccurredAt: "2026-10-01T13:00:00Z",
			}),
			/SERVICE_UNAVAILABLE/,
		);
		assert.equal(
			(await runtime.access.get(id)).toOccurredAt,
			next.toOccurredAt,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("a timed-out create and process restart retry the same persisted intent", async () => {
	const root = await mkdtemp(join(tmpdir(), "raziel-access-"));
	try {
		const identity = await loadIdentity(root);
		const ids: string[] = [];
		let fail = true;
		const base = createRazielClient({
			baseUrl: "http://127.0.0.1:3000",
			audience: "synthetic",
			tokenProvider: () => "",
			signer: identity.signer,
		});
		const factory = () => ({
			...base,
			async createAccessRequest(intent: AccessIntent) {
				ids.push(intent.requestId);
				if (fail) throw new AppError("SERVICE_UNAVAILABLE", 503);
				return create(AccessRequestSchema, {
					requestId: intent.requestId,
					state: AccessRequestState.PENDING_REVIEW,
				});
			},
		});
		const runtime = new AgentRuntime({
			role: "A",
			signer: identity.signer,
			root,
			clientFactory: factory,
		});
		await runtime.access.store.update((state) => {
			state.credentials = {
				baseUrl: "http://127.0.0.1:3000",
				audience: "synthetic",
				token: "server-only-token",
				agentId: "a".repeat(32),
			};
		});
		await assert.rejects(runtime.start(input), /SERVICE_UNAVAILABLE/);
		const saved = (await runtime.access.store.read()).tasks[0]!;
		assert.equal(saved.phase, "REQUESTING");
		const restart = new AgentRuntime({
			role: "A",
			signer: identity.signer,
			root,
			clientFactory: factory,
		});
		fail = false;
		await restart.command(saved.id, "retry");
		assert.equal(ids.length, 2);
		assert.equal(ids[0], ids[1]);
		assert.equal((await restart.access.get(saved.id)).phase, "PENDING_REVIEW");
		assert.equal(
			JSON.stringify(await restart.view()).includes("server-only-token"),
			false,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the real SDK signing attempt is durable before submit and reused after restart", async () => {
	const root = await mkdtemp(join(tmpdir(), "raziel-issuance-"));
	try {
		const identity = await loadIdentity(root);
		let signs = 0;
		const signer = {
			publicKey: identity.signer.publicKey,
			async sign(bytes: Uint8Array) {
				signs++;
				return identity.signer.sign(bytes);
			},
		};
		const base = createRazielClient({
			baseUrl: "http://127.0.0.1:3000",
			audience: "synthetic",
			tokenProvider: () => "",
			signer,
		});
		let intent!: AccessIntent;
		const attempts: unknown[] = [];
		const now = BigInt(Math.floor(Date.now() / 1000));
		const binding = {
			policyRecordId: "policy-example",
			policyHash: new Uint8Array(32).fill(1),
			resourceType: `dataset_${"b".repeat(32)}`,
			resourceScope: input.datasetId,
		};
		const current = () =>
			create(AccessRequestSchema, {
				formatVersion: 1,
				requestId: intent.requestId,
				agentId: "a".repeat(32),
				taskId: intent.taskId,
				purpose: intent.purpose,
				action: intent.action,
				datasetId: intent.datasetId,
				datasetRevision: intent.datasetRevision,
				state: AccessRequestState.AWAITING_SIGNATURE,
				generation: 2n,
				createdAtUnixSeconds: now,
				updatedAtUnixSeconds: now,
				deadlineUnixSeconds: now + 4500n,
				policyBinding: binding,
				proposal: {
					formatVersion: 1,
					proposalId: "c".repeat(32),
					generation: 2n,
					signatureDeadlineUnixSeconds: now + 120n,
					agentPublicKey: signer.publicKey,
					taskId: intent.taskId,
					purpose: intent.purpose,
					action: intent.action,
					policyBinding: binding,
					snapshotId: `snapshot-v1:${"0d".repeat(32)}`,
					snapshotRoot: new Uint8Array(32).fill(13),
					requestedExpiresAtUnixSeconds: now + 4400n,
				},
			});
		const factory = () => ({
			...base,
			async createAccessRequest(value: AccessIntent) {
				intent = value;
				return current();
			},
			async getAccessRequest() {
				return current();
			},
			async submitIssuance(_id: string, attempt: AccessIssuanceSubmission) {
				const state = JSON.parse(
					await readFile(join(root, "state.json"), "utf8"),
				);
				const serialized = toJson(AccessIssuanceSubmissionSchema, attempt);
				assert.deepEqual(state.tasks[0].attempt, serialized);
				attempts.push(serialized);
				if (attempts.length === 1)
					throw new AppError("SERVICE_UNAVAILABLE", 503);
				return create(AccessRequestSchema, {
					...current(),
					state: AccessRequestState.QUEUED,
					proposal: undefined,
				});
			},
		});
		const runtime = new AgentRuntime({
			role: "A",
			signer,
			root,
			clientFactory: factory,
		});
		await runtime.access.store.update((state) => {
			state.credentials = {
				baseUrl: "http://127.0.0.1:3000",
				audience: "synthetic",
				token: "private",
				agentId: "a".repeat(32),
			};
		});
		const id = await runtime.start(input);
		await assert.rejects(runtime.command(id, "refresh"), /SERVICE_UNAVAILABLE/);
		const restart = new AgentRuntime({
			role: "A",
			signer,
			root,
			clientFactory: factory,
		});
		await restart.command(id, "refresh");
		assert.equal(signs, 1);
		assert.deepEqual(attempts[0], attempts[1]);
		assert.equal((await restart.access.get(id)).phase, "QUEUED");
		const browser = JSON.stringify(await restart.view());
		for (const field of [
			"requestSignature",
			"issuanceNonce",
			"attempt",
			"token",
		])
			assert.equal(browser.includes(field), false);
		await restart.command(id, "pause");
		assert.equal((await restart.access.get(id)).paused, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
