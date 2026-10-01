import { createServer } from "node:http";
import { resolve } from "node:path";
import { equalsSecret, json, readJson } from "./http.ts";
import { validateLookup, validateResult } from "./reconciliation.ts";
import { AppError, JsonStore, privateDirectory } from "./storage.ts";
import { UUID } from "./access-tasks.ts";
import type { ChannelTask, TaskMessage } from "./channel-client.ts";

const root = resolve(process.env.CHANNEL_STATE_DIR ?? ".state/channel");
await privateDirectory(root);
const store = new JsonStore<{ version: 1; tasks: ChannelTask[] }>(
	root,
	"messages.json",
	() => ({ version: 1, tasks: [] }),
);
const tokenA = process.env.CHANNEL_TOKEN_A ?? "";
const tokenB = process.env.CHANNEL_TOKEN_B ?? "";
if (tokenA.length < 32 || tokenB.length < 32 || tokenA === tokenB)
	throw new AppError("CHANNEL_TOKENS_REQUIRED", 503);
const server = createServer(async (request, response) => {
	try {
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		if (request.method === "GET" && path === "/health")
			return json(response, 200, { status: "ok" });
		const token = request.headers.authorization?.startsWith("Bearer ")
			? request.headers.authorization.slice(7)
			: "";
		const role = equalsSecret(token, tokenA)
			? "A"
			: equalsSecret(token, tokenB)
				? "B"
				: undefined;
		if (!role) throw new AppError("CHANNEL_AUTH_REQUIRED", 401);
		if (request.method === "GET" && path === "/tasks")
			return json(response, 200, (await store.read()).tasks);
		if (request.method === "POST" && path === "/tasks") {
			const body = await readJson(request);
			if (
				role !== "A" ||
				Object.keys(body).join(",") !== "taskId" ||
				!UUID.test(String(body.taskId))
			)
				throw new AppError("INVALID_TASK");
			const task = await store.update((state) => {
				const previous = state.tasks.find((row) => row.taskId === body.taskId);
				if (previous) return previous;
				if (state.tasks.length >= 100)
					throw new AppError("CHANNEL_CAPACITY_EXCEEDED", 409);
				const created: ChannelTask = {
					taskId: String(body.taskId),
					messages: [],
				};
				state.tasks.push(created);
				return created;
			});
			return json(response, 200, task);
		}
		const match = /^\/tasks\/([^/]+)\/messages$/.exec(path);
		if (request.method === "POST" && match && UUID.test(match[1]!)) {
			const body = await readJson(request);
			if (
				Object.keys(body).sort().join(",") !== "id,kind,payload" ||
				!UUID.test(String(body.id)) ||
				(role === "A"
					? body.kind !== "lookup"
					: body.kind !== "settlement_result")
			)
				throw new AppError("INVALID_MESSAGE");
			const payload =
				role === "A"
					? validateLookup(body.payload)
					: validateResult(body.payload);
			const message = await store.update((state) => {
				const task = state.tasks.find((row) => row.taskId === match[1]);
				if (!task) throw new AppError("TASK_NOT_FOUND", 404);
				const previous = task.messages.find((row) => row.id === body.id);
				if (previous) {
					if (
						previous.sender !== role ||
						previous.kind !== body.kind ||
						JSON.stringify(previous.payload) !== JSON.stringify(payload)
					)
						throw new AppError("MESSAGE_CONFLICT", 409);
					return previous;
				}
				if (
					role === "B" &&
					!task.messages.some(
						(row) =>
							row.sender === "A" &&
							row.kind === "lookup" &&
							row.payload.transactionReference === payload.transactionReference,
					)
				)
					throw new AppError("LOOKUP_REQUIRED", 409);
				if (task.messages.length >= 100)
					throw new AppError("CHANNEL_CAPACITY_EXCEEDED", 409);
				const created: TaskMessage = {
					id: String(body.id),
					sender: role,
					kind: body.kind as TaskMessage["kind"],
					payload,
					createdAt: new Date().toISOString(),
				};
				task.messages.push(created);
				return created;
			});
			return json(response, 200, message);
		}
		throw new AppError("NOT_FOUND", 404);
	} catch (error) {
		json(response, error instanceof AppError ? error.status : 503, {
			error: error instanceof AppError ? error.code : "CHANNEL_UNAVAILABLE",
		});
	}
});
server.requestTimeout = 10_000;
server.headersTimeout = 5000;
server.listen(
	Number(process.env.PORT ?? "3003"),
	process.env.HOST ?? "127.0.0.1",
	() => console.log("Reconciliation channel started"),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		server.close();
		server.closeIdleConnections();
	});
