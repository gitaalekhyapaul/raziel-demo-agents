import { randomUUID } from "node:crypto";
import { fromBinary, fromJson } from "@bufbuild/protobuf";
import {
	createRazielClient,
	AccessRequestSchema,
	ProofCapabilitySchema,
	type AgentSigner,
	type RazielClient,
} from "@gitaalekhyapaul/raziel-sdk-ts";
import {
	AccessTasks,
	newTask,
	queryRange,
	taskInput,
	type AgentState,
	type Credentials,
} from "./access-tasks.ts";
import { ChannelClient, type TaskMessage } from "./channel-client.ts";
import { runToolLoop, type LlmConfig, type Tool } from "./llm.ts";
import {
	lookupFromRow,
	reconcile,
	text,
	validateLookup,
	type Lookup,
} from "./reconciliation.ts";
import { AppError, JsonStore } from "./storage.ts";

export function errorCode(error: unknown): string {
	if (error instanceof AppError) return error.code;
	// Do not forward provider response bodies or arbitrary exception text.
	const code = (error as { code?: unknown })?.code;
	return typeof code === "string" && /^[A-Z][A-Z_]{1,63}$/.test(code)
		? code
		: "SERVICE_UNAVAILABLE";
}
export class AgentRuntime {
	readonly role: "A" | "B";
	readonly signer: AgentSigner;
	readonly access: AccessTasks;
	readonly channel?: ChannelClient;
	readonly llm?: LlmConfig;
	readonly busy = new Set<string>();
	readonly clientFactory: (credentials: Credentials) => RazielClient;
	constructor(options: {
		role: "A" | "B";
		signer: AgentSigner;
		root: string;
		channel?: ChannelClient;
		llm?: LlmConfig;
		clientFactory?: (credentials: Credentials) => RazielClient;
	}) {
		this.role = options.role;
		this.signer = options.signer;
		this.channel = options.channel;
		this.llm = options.llm;
		this.access = new AccessTasks(
			new JsonStore<AgentState>(options.root, "state.json", () => ({
				version: 1,
				tasks: [],
			})),
		);
		this.clientFactory =
			options.clientFactory ??
			((credentials) =>
				createRazielClient({
					baseUrl: credentials.baseUrl,
					audience: credentials.audience,
					tokenProvider: () => credentials.token,
					signer: this.signer,
				}));
	}
	async client() {
		const credentials = (await this.access.store.read()).credentials;
		if (!credentials) throw new AppError("CONNECT_AGENT_FIRST", 409);
		return this.clientFactory(credentials);
	}
	async connect(input: Record<string, unknown>) {
		if (Object.keys(input).sort().join(",") !== "audience,baseUrl,token")
			throw new AppError("INVALID_REQUEST");
		const candidate: Credentials = {
			baseUrl: text(input.baseUrl, 2048),
			audience: text(input.audience, 256),
			token: text(input.token, 256),
			agentId: "",
		};
		const me = await this.clientFactory(candidate).me();
		candidate.agentId = me.agentId;
		await this.access.store.update((state) => {
			if (
				state.tasks.length &&
				state.credentials &&
				(state.credentials.baseUrl !== candidate.baseUrl ||
					state.credentials.audience !== candidate.audience ||
					state.credentials.agentId !== candidate.agentId)
			)
				throw new AppError("TASK_INSTALLATION_CONFLICT", 409);
			state.credentials = candidate;
		});
	}
	async start(input: Record<string, unknown>) {
		const client = await this.client();
		const values = taskInput(input);
		if (this.role === "A" && (values.channelTaskId || values.lookupMessageId))
			throw new AppError("INVALID_TASK");
		if (this.role === "B") {
			if (!values.channelTaskId || !values.lookupMessageId)
				throw new AppError("SELECT_LOOKUP_FIRST");
			await this.lookup(values.channelTaskId, values.lookupMessageId);
		}
		const task = newTask(values);
		await this.access.store.update((state) => {
			if (state.tasks.some((row) => row.id === task.id))
				throw new AppError("TASK_ALREADY_EXISTS", 409);
			if (state.tasks.length >= 32)
				throw new AppError("TASK_CAPACITY_EXCEEDED", 409);
			state.tasks.push(task);
		});
		await this.command(task.id, "retry", {}, client);
		return task.id;
	}
	async command(
		id: string,
		command: string,
		args: Record<string, unknown> = {},
		existing?: RazielClient,
	) {
		if (command === "pause") return this.access.patch(id, { paused: true });
		if (this.busy.has(id)) throw new AppError("TASK_BUSY", 409);
		this.busy.add(id);
		try {
			return await this.perform(id, command, args, existing);
		} catch (error) {
			await this.access.patch(id, { error: errorCode(error) });
			throw error;
		} finally {
			this.busy.delete(id);
		}
	}
	async perform(
		id: string,
		command: string,
		args: Record<string, unknown>,
		existing?: RazielClient,
	): Promise<unknown> {
		const task = await this.access.get(id);
		if (
			task.paused &&
			["query", "lookup", "evidence", "run-agent", "retry"].includes(command)
		)
			throw new AppError("TASK_PAUSED", 409);
		if (command === "pause") return this.access.patch(id, { paused: true });
		if (command === "messages") return this.messages(id);
		if (command === "lookup")
			return this.sendLookup(id, text(args.transactionReference));
		if (command === "evidence")
			return this.sendEvidence(id, args.lookupMessageId as string | undefined);
		if (command === "run-agent") return this.runAgent(id);
		const client = existing ?? (await this.client());
		if (command === "retry")
			return task.outbox
				? this.publish(id, task.outbox.kind, task.outbox.payload)
				: this.access.create(id, client);
		if (command === "refresh") return this.access.refresh(id, client);
		if (command === "resume") return this.access.resume(id, client);
		if (command === "cancel") return this.access.cancel(id, client);
		if (command === "query") return this.query(id, client, args);
		throw new AppError("UNKNOWN_COMMAND", 404);
	}
	async query(
		id: string,
		client: RazielClient,
		args: Record<string, unknown> = {},
	) {
		const task = await this.access.get(id);
		if (!task.request) throw new AppError("ACCESS_PENDING", 409);
		const request = fromJson(AccessRequestSchema, task.request);
		if (task.phase !== "READY" || !request.capability.length)
			throw new AppError("ACCESS_PENDING", 409);
		const range = Object.keys(args).length
			? queryRange(args)
			: {
					fromOccurredAt: task.fromOccurredAt,
					toOccurredAt: task.toOccurredAt,
				};
		const result = await client.queryDataset(
			task.datasetId,
			request.capability,
			{
				...range,
				limit: 100,
			},
		);
		const visible = {
			verification_path: result.verification_path,
			rows: result.rows,
			receiptId: result.receipt.receipt_id,
		};
		await this.access.patch(id, {
			...range,
			lastQuery: visible,
			error: undefined,
		});
		return visible;
	}
	requireChannel() {
		if (!this.channel) throw new AppError("CHANNEL_NOT_CONFIGURED", 503);
		return this.channel;
	}
	async lookup(id: string, messageId: string): Promise<Lookup> {
		const task = (await this.requireChannel().list()).find(
			(row) => row.taskId === id,
		);
		const message = task?.messages.find(
			(row) =>
				row.id === messageId && row.kind === "lookup" && row.sender === "A",
		);
		if (!message) throw new AppError("LOOKUP_NOT_FOUND", 404);
		return validateLookup(message.payload);
	}
	async messages(id: string) {
		const channelTask = (await this.requireChannel().list()).find(
			(row) => row.taskId === id,
		);
		const messages = channelTask?.messages ?? [];
		const result = messages
			.filter((row) => row.kind === "settlement_result")
			.at(-1)?.payload;
		await this.access.patch(id, {
			messages,
			...(result
				? { result: result as import("./reconciliation.ts").SettlementResult }
				: {}),
		});
		return messages;
	}
	async publish(
		id: string,
		kind: TaskMessage["kind"],
		payload: TaskMessage["payload"],
	) {
		const channel = this.requireChannel();
		let task = await this.access.get(id);
		if (
			task.outbox &&
			(task.outbox.kind !== kind ||
				JSON.stringify(task.outbox.payload) !== JSON.stringify(payload))
		)
			throw new AppError("MESSAGE_RETRY_REQUIRED", 409);
		if (!task.outbox) {
			await this.access.patch(id, {
				outbox: { id: randomUUID(), kind, payload },
			});
			task = await this.access.get(id);
		}
		if (this.role === "A") await channel.create(id);
		await channel.post(id, task.outbox!);
		await this.access.patch(id, { outbox: undefined });
		return this.messages(id);
	}
	async sendLookup(id: string, reference: string) {
		if (this.role !== "A") throw new AppError("WRONG_AGENT", 403);
		const task = await this.access.get(id);
		const row = task.lastQuery?.rows.find(
			(row) => row.transactionId === reference,
		);
		if (!row) throw new AppError("QUERY_TRANSACTION_FIRST", 409);
		return this.publish(id, "lookup", lookupFromRow(row));
	}
	async sendEvidence(id: string, messageId?: string) {
		if (this.role !== "B") throw new AppError("WRONG_AGENT", 403);
		const task = await this.access.get(id);
		const reference = messageId ?? task.lookupMessageId;
		if (!reference || !task.lastQuery)
			throw new AppError("QUERY_SETTLEMENT_FIRST", 409);
		// A full page cannot establish an exhaustive match or absence.
		if (task.lastQuery.rows.length >= 100)
			throw new AppError("NARROW_QUERY_RANGE", 409);
		const lookup = await this.lookup(id, reference);
		const result = reconcile(
			lookup,
			task.lastQuery.rows,
			task.lastQuery.receiptId,
		);
		await this.publish(id, "settlement_result", result);
		await this.access.patch(id, { result, error: undefined });
		return result;
	}
	async runAgent(id: string) {
		if (!this.llm) throw new AppError("LLM_NOT_CONFIGURED", 503);
		const task = await this.access.get(id);
		if (task.paused) throw new AppError("TASK_PAUSED", 409);
		const tools: Tool[] = [
			tool("check_access", "Read the current access state.", {}),
			tool(
				"query_ledger",
				"Query the authorized ledger with the retained capability.",
				{},
			),
			tool("read_messages", "Read messages for this reconciliation task.", {}),
			this.role === "A"
				? tool(
						"request_settlement",
						"Send a lookup from an authorized processor row.",
						{ transactionReference: { type: "string" } },
						["transactionReference"],
					)
				: tool(
						"send_settlement_evidence",
						"Compute and send a bounded bank match from authorized rows.",
						{},
					),
		];
		const summary = await runToolLoop(
			this.llm,
			{
				role: this.role,
				task: task.label,
				access: task.phase,
				authorizedRows: task.lastQuery?.rows ?? [],
				messages: task.messages ?? [],
			},
			tools,
			async (name, value) => {
				if (!value || typeof value !== "object" || Array.isArray(value))
					throw new AppError("INVALID_TOOL_ARGUMENTS");
				if ((await this.access.get(id)).paused)
					throw new AppError("TASK_PAUSED", 409);
				const args = value as Record<string, unknown>;
				const names =
					name === "request_settlement" ? ["transactionReference"] : [];
				if (Object.keys(args).some((key) => !names.includes(key)))
					throw new AppError("INVALID_TOOL_ARGUMENTS");
				if (name === "check_access") {
					await this.perform(id, "refresh", {});
					return { state: (await this.access.get(id)).phase };
				}
				const command = {
					query_ledger: "query",
					read_messages: "messages",
					request_settlement: "lookup",
					send_settlement_evidence: "evidence",
				}[name];
				if (!command) throw new AppError("INVALID_TOOL");
				return this.perform(id, command, args);
			},
		);
		await this.access.patch(id, { summary, error: undefined });
		return { summary };
	}
	async tick() {
		for (const task of (await this.access.store.read()).tasks) {
			if (this.busy.has(task.id) || !this.access.needsPoll(task)) continue;
			try {
				await this.command(task.id, task.request ? "refresh" : "retry");
			} catch {
				/* Persisted errors stay visible. The next poll reconciles the same intent. */
			}
		}
	}
	async view() {
		const state = await this.access.store.read();
		let inbox: import("./channel-client.ts").ChannelTask[] = [];
		let channelError: string | undefined;
		try {
			if (this.channel) inbox = await this.channel.list();
		} catch (error) {
			channelError = errorCode(error);
		}
		const tasks = state.tasks.map((task) => {
			const request = task.request
				? fromJson(AccessRequestSchema, task.request)
				: undefined;
			const capability = request?.capability.length
				? fromBinary(ProofCapabilitySchema, request.capability)
				: undefined;
			const cachedChannel = !this.channel || Boolean(channelError);
			const messages = cachedChannel
				? (task.messages ?? [])
				: (inbox.find((row) => row.taskId === task.id)?.messages ?? []);
			const result = messages
				.filter((row) => row.kind === "settlement_result")
				.at(-1)?.payload;
			return {
				id: task.id,
				label: task.label,
				datasetId: task.datasetId,
				datasetRevision: task.datasetRevision,
				fromOccurredAt: task.fromOccurredAt,
				toOccurredAt: task.toOccurredAt,
				phase: task.phase,
				paused: task.paused,
				running: this.busy.has(task.id),
				error: task.error,
				requestId: request?.requestId,
				requestState: task.phase,
				lastQuery: task.lastQuery,
				summary: task.summary,
				messages,
				result: result ?? (cachedChannel ? task.result : undefined),
				capability: capability
					? {
							id: capability.capabilityId,
							expiresAt: capability.expiresAt
								? new Date(
										Number(capability.expiresAt.seconds) * 1000,
									).toISOString()
								: "",
							policyHash: Buffer.from(capability.policyHash).toString("hex"),
							resourceScope: capability.resourceScope,
						}
					: undefined,
			};
		});
		const credentials = state.credentials;
		return {
			role: this.role,
			label: this.role === "A" ? "Processor agent" : "Settlement agent",
			connection: credentials
				? {
						configured: true,
						baseUrl: credentials.baseUrl,
						audience: credentials.audience,
						agentId: credentials.agentId,
					}
				: { configured: false, baseUrl: "", audience: "" },
			llm: { configured: Boolean(this.llm), model: this.llm?.model ?? "" },
			tasks,
			inbox,
			channelError,
		};
	}
}
function tool(
	name: string,
	description: string,
	properties: Record<string, unknown>,
	required: string[] = [],
): Tool {
	return {
		name,
		description,
		parameters: {
			type: "object",
			properties,
			required,
			additionalProperties: false,
		},
	};
}
