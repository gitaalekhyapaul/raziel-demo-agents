import { randomUUID } from "node:crypto";
import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import {
	AccessIntentSchema,
	AccessRequestSchema,
	AccessRequestMutationSchema,
	AccessIssuanceSubmissionSchema,
	AccessRequestState,
	type AccessRequest,
	type RazielClient,
} from "@gitaalekhyapaul/raziel-sdk-ts";
import { AppError, JsonStore } from "./storage.ts";
import {
	text,
	type LedgerRow,
	type SettlementResult,
} from "./reconciliation.ts";
import type { TaskMessage } from "./channel-client.ts";

export interface Credentials {
	baseUrl: string;
	audience: string;
	token: string;
	agentId: string;
}
export interface QueryResult {
	verification_path: string;
	rows: LedgerRow[];
	receiptId: string;
}
export interface Task {
	id: string;
	label: string;
	datasetId: string;
	datasetRevision: number;
	fromOccurredAt: string;
	toOccurredAt: string;
	intent: JsonValue;
	request?: JsonValue;
	attempt?: JsonValue;
	phase: string;
	paused: boolean;
	error?: string;
	lastQuery?: QueryResult;
	messages?: TaskMessage[];
	result?: SettlementResult;
	summary?: string;
	lookupMessageId?: string;
	outbox?: Pick<TaskMessage, "id" | "kind" | "payload">;
}
export interface AgentState {
	version: 1;
	credentials?: Credentials;
	tasks: Task[];
}
export interface TaskInput {
	label: string;
	datasetId: string;
	datasetRevision: number;
	fromOccurredAt: string;
	toOccurredAt: string;
	channelTaskId?: string;
	lookupMessageId?: string;
}
export const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const terminal = new Set([
	"READY",
	"REJECTED",
	"CANCELED",
	"EXPIRED",
	"FAILED",
]);

export function taskInput(value: Record<string, unknown>): TaskInput {
	const allowed = [
		"label",
		"datasetId",
		"datasetRevision",
		"fromOccurredAt",
		"toOccurredAt",
		"channelTaskId",
		"lookupMessageId",
	];
	if (Object.keys(value).some((key) => !allowed.includes(key)))
		throw new AppError("INVALID_REQUEST");
	const datasetId = text(value.datasetId);
	if (
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(datasetId) ||
		!Number.isSafeInteger(value.datasetRevision) ||
		Number(value.datasetRevision) < 1
	)
		throw new AppError("INVALID_DATASET");
	const range = queryRange({
		fromOccurredAt: value.fromOccurredAt,
		toOccurredAt: value.toOccurredAt,
	});
	for (const key of ["channelTaskId", "lookupMessageId"]) {
		if (value[key] !== undefined && !UUID.test(String(value[key])))
			throw new AppError("INVALID_TASK");
	}
	return {
		label: text(value.label),
		datasetId,
		datasetRevision: Number(value.datasetRevision),
		...range,
		channelTaskId: value.channelTaskId as string | undefined,
		lookupMessageId: value.lookupMessageId as string | undefined,
	};
}
export function queryRange(value: Record<string, unknown>) {
	if (Object.keys(value).sort().join(",") !== "fromOccurredAt,toOccurredAt")
		throw new AppError("INVALID_QUERY_RANGE");
	const fromOccurredAt = utc(value.fromOccurredAt);
	const toOccurredAt = utc(value.toOccurredAt);
	const span = Date.parse(toOccurredAt) - Date.parse(fromOccurredAt);
	if (span < 0 || span > 31 * 86400_000)
		throw new AppError("INVALID_QUERY_RANGE");
	return { fromOccurredAt, toOccurredAt };
}
function utc(value: unknown) {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ||
		!Number.isFinite(Date.parse(value)) ||
		new Date(value).toISOString().replace(".000Z", "Z") !== value
	)
		throw new AppError("INVALID_QUERY_RANGE");
	return value;
}
export function newTask(input: TaskInput): Task {
	const id = input.channelTaskId ?? randomUUID();
	const intent = create(AccessIntentSchema, {
		formatVersion: 1,
		requestId: randomUUID(),
		taskId: `recon-${id}`,
		purpose: "reconciliation",
		action: "query",
		datasetId: input.datasetId,
		datasetRevision: BigInt(input.datasetRevision),
	});
	return {
		...input,
		id,
		intent: toJson(AccessIntentSchema, intent),
		phase: "REQUESTING",
		paused: false,
	};
}

/** Persist each intent and signing attempt before any publication. */
export class AccessTasks {
	readonly store: JsonStore<AgentState>;
	constructor(store: JsonStore<AgentState>) {
		this.store = store;
	}
	async get(id: string) {
		const task = (await this.store.read()).tasks.find((row) => row.id === id);
		if (!task) throw new AppError("TASK_NOT_FOUND", 404);
		return task;
	}
	async patch(id: string, values: Partial<Task>) {
		await this.store.update((state) => {
			const task = state.tasks.find((row) => row.id === id);
			if (!task) throw new AppError("TASK_NOT_FOUND", 404);
			Object.assign(task, values);
		});
	}
	async remember(id: string, request: AccessRequest) {
		await this.patch(id, {
			request: toJson(AccessRequestSchema, request),
			phase: AccessRequestState[request.state],
			error: request.errorCode,
		});
		return request;
	}
	async create(id: string, client: RazielClient) {
		const task = await this.get(id);
		await this.remember(
			id,
			await client.createAccessRequest(
				fromJson(AccessIntentSchema, task.intent),
			),
		);
	}
	async refresh(id: string, client: RazielClient) {
		let task = await this.get(id);
		const intent = fromJson(AccessIntentSchema, task.intent);
		const request = await this.remember(
			id,
			await client.getAccessRequest(intent.requestId),
		);
		task = await this.get(id);
		if (task.paused || request.state !== AccessRequestState.AWAITING_SIGNATURE)
			return;
		let attempt = task.attempt
			? fromJson(AccessIssuanceSubmissionSchema, task.attempt)
			: undefined;
		if (
			!attempt ||
			attempt.proposalId !== request.proposal?.proposalId ||
			attempt.generation !== request.generation
		) {
			attempt = await client.signIssuance(intent, request);
			await this.patch(id, {
				attempt: toJson(AccessIssuanceSubmissionSchema, attempt),
			});
		}
		// Pause can arrive during signing. Retain the exact attempt for resume.
		if ((await this.get(id)).paused) return;
		await this.remember(
			id,
			await client.submitIssuance(intent.requestId, attempt),
		);
	}
	async resume(id: string, client: RazielClient) {
		await this.patch(id, { paused: false, error: undefined });
		const task = await this.get(id);
		if (!task.request) return this.create(id, client);
		const current = await this.remember(
			id,
			await client.getAccessRequest(
				fromJson(AccessIntentSchema, task.intent).requestId,
			),
		);
		if (current.state === AccessRequestState.WAITING_FOR_AGENT) {
			await this.remember(
				id,
				await client.resumeAccessRequest(
					current.requestId,
					create(AccessRequestMutationSchema, {
						formatVersion: 1,
						expectedGeneration: current.generation,
					}),
				),
			);
		}
		await this.refresh(id, client);
	}
	async cancel(id: string, client: RazielClient) {
		const task = await this.get(id);
		const current = await client.getAccessRequest(
			fromJson(AccessIntentSchema, task.intent).requestId,
		);
		await this.remember(
			id,
			await client.cancelAccessRequest(
				current.requestId,
				create(AccessRequestMutationSchema, {
					formatVersion: 1,
					expectedGeneration: current.generation,
				}),
			),
		);
	}
	needsPoll(task: Task) {
		return (
			(!task.paused || task.phase === "CANCELLING") && !terminal.has(task.phase)
		);
	}
}
