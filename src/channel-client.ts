import { AppError } from "./storage.ts";
import type { Lookup, SettlementResult } from "./reconciliation.ts";

export interface TaskMessage {
	id: string;
	sender: "A" | "B";
	kind: "lookup" | "settlement_result";
	payload: Lookup | SettlementResult;
	createdAt: string;
}
export interface ChannelTask {
	taskId: string;
	messages: TaskMessage[];
}
export class ChannelClient {
	readonly baseUrl: string;
	readonly token: string;
	constructor(baseUrl: string, token: string) {
		this.baseUrl = baseUrl;
		this.token = token;
	}
	async request<T>(method: string, target: string, body?: unknown): Promise<T> {
		const response = await fetch(new URL(target, this.baseUrl), {
			method,
			redirect: "error",
			signal: AbortSignal.timeout(5000),
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok)
			throw new AppError(
				response.status === 409 ? "MESSAGE_CONFLICT" : "CHANNEL_UNAVAILABLE",
				503,
			);
		const bytes = await response.text();
		if (Buffer.byteLength(bytes) > 1024 * 1024)
			throw new AppError("CHANNEL_UNAVAILABLE", 503);
		return JSON.parse(bytes) as T;
	}
	list() {
		return this.request<ChannelTask[]>("GET", "/tasks");
	}
	create(taskId: string) {
		return this.request<ChannelTask>("POST", "/tasks", { taskId });
	}
	post(taskId: string, message: Pick<TaskMessage, "id" | "kind" | "payload">) {
		return this.request<TaskMessage>(
			"POST",
			`/tasks/${encodeURIComponent(taskId)}/messages`,
			message,
		);
	}
}
