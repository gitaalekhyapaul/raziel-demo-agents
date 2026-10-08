import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { ChannelClient } from "./channel-client.ts";
import { AppError } from "./storage.ts";

export function configuration() {
	// Reference a private runtime file. Never copy its values into source or public state.
	if (process.env.LLM_ENV_FILE) loadEnvFile(process.env.LLM_ENV_FILE);
	const role = process.env.AGENT_ROLE ?? "A";
	if (role !== "A" && role !== "B")
		throw new AppError("INVALID_AGENT_ROLE", 503);
	const port = Number(process.env.PORT ?? (role === "A" ? "3001" : "3002"));
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new AppError("INVALID_PORT", 503);
	const baseUrl = process.env.LLM_BASE_URL ?? process.env.SOCLAAS_BASE_URL;
	const model = process.env.LLM_MODEL ?? process.env.SOCLAAS_MODEL;
	const apiKey = process.env.LLM_API_KEY ?? process.env.SOCLAAS_API_KEY;
	if (Boolean(baseUrl) !== Boolean(model))
		throw new AppError("LLM_CONFIGURATION_INVALID", 503);
	return {
		role: role as "A" | "B",
		port,
		host: process.env.HOST ?? "127.0.0.1",
		root: resolve(
			process.env.AGENT_STATE_DIR ?? `.state/agent-${role.toLowerCase()}`,
		),
		password: process.env.AGENT_DASHBOARD_PASSWORD ?? "",
		defaultBaseUrl: process.env.RAZIEL_API_BASE_URL ?? "",
		origins: (
			process.env.AGENT_DASHBOARD_ORIGINS ??
			`http://127.0.0.1:${port},http://localhost:${port}`
		)
			.split(",")
			.map((value) => value.trim()),
		channel: process.env.CHANNEL_TOKEN
			? new ChannelClient(
					process.env.CHANNEL_BASE_URL ?? "http://127.0.0.1:3003",
					process.env.CHANNEL_TOKEN,
				)
			: undefined,
		llm: baseUrl && model ? { baseUrl, model, apiKey } : undefined,
	};
}
