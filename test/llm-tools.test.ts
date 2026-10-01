import assert from "node:assert/strict";
import { test } from "node:test";
import { runToolLoop } from "../src/llm.ts";

test("the bounded provider loop sends only supplied business context and validates tools", async () => {
	const original = globalThis.fetch;
	const bodies: string[] = [];
	const tools = [
		{
			name: "check_access",
			description: "Read public access state",
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
		},
	];
	let calls = 0;
	try {
		globalThis.fetch = (async (_url, init) => {
			bodies.push(String(init?.body));
			return new Response(
				JSON.stringify({
					choices: [
						{
							message:
								calls++ === 0
									? {
											role: "assistant",
											content: null,
											tool_calls: [
												{
													id: "call-1",
													type: "function",
													function: { name: "check_access", arguments: "{}" },
												},
											],
										}
									: { role: "assistant", content: "Access is pending." },
						},
					],
				}),
				{ status: 200 },
			);
		}) as typeof fetch;
		let executed = 0;
		const summary = await runToolLoop(
			{
				baseUrl: "https://synthetic-provider.invalid/v1",
				model: "test",
				apiKey: "private-provider-key",
			},
			{ task: "Reconciliation", access: "PENDING_REVIEW" },
			tools,
			async (name) => {
				assert.equal(name, "check_access");
				executed++;
				return { state: "PENDING_REVIEW" };
			},
		);
		assert.equal(summary, "Access is pending.");
		assert.equal(executed, 1);
		assert.equal(
			bodies.some((body) => body.includes("private-provider-key")),
			false,
		);
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								role: "assistant",
								tool_calls: [
									{
										id: "call-2",
										type: "function",
										function: { name: "read_private_policy", arguments: "{}" },
									},
								],
							},
						},
					],
				}),
				{ status: 200 },
			)) as typeof fetch;
		await assert.rejects(
			runToolLoop(
				{ baseUrl: "https://synthetic-provider.invalid/v1", model: "test" },
				{},
				tools,
				async () => {
					executed++;
				},
			),
			/LLM_TOOL_INVALID/,
		);
		assert.equal(executed, 1);
		globalThis.fetch = (async () =>
			new Response("provider detail with private credentials", {
				status: 401,
			})) as typeof fetch;
		await assert.rejects(
			runToolLoop(
				{ baseUrl: "https://synthetic-provider.invalid/v1", model: "test" },
				{},
				tools,
				async () => ({}),
			),
			(error) => error instanceof Error && error.message === "LLM_UNAVAILABLE",
		);
	} finally {
		globalThis.fetch = original;
	}
});
