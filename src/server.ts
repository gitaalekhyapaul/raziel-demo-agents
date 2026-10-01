import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { configuration } from "./config.ts";
import { loadIdentity } from "./identity.ts";
import { Sessions, json, readJson } from "./http.ts";
import { AgentRuntime, errorCode } from "./runtime.ts";
import { UUID } from "./access-tasks.ts";
import { AppError } from "./storage.ts";

const config = configuration();
const identity = await loadIdentity(config.root);
const runtime = new AgentRuntime({ ...config, signer: identity.signer });
const sessions = new Sessions(config.password, config.origins, config.role);
const assets = new Map([
	["/", ["index.html", "text/html; charset=utf-8"]],
	["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
	["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);
const commands = new Set([
	"refresh",
	"resume",
	"pause",
	"cancel",
	"query",
	"lookup",
	"evidence",
	"run-agent",
	"retry",
	"messages",
]);
const server = createServer(async (request, response) => {
	try {
		const url = new URL(request.url ?? "/", "http://localhost");
		const method = request.method ?? "GET";
		if (method === "GET" && url.pathname === "/health")
			return json(response, 200, { status: "ok", role: config.role });
		if (method === "GET" && assets.has(url.pathname)) {
			const [file, type] = assets.get(url.pathname)!;
			response.writeHead(200, {
				"Content-Type": type!,
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy":
					"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
			});
			return response.end(
				await readFile(new URL(`../public/${file}`, import.meta.url)),
			);
		}
		if (method === "GET" && url.pathname === "/api/session")
			return json(response, 200, {
				authenticated: sessions.authenticated(request),
			});
		if (method === "POST") sessions.origin(request);
		if (method === "POST" && url.pathname === "/api/login") {
			const body = await readJson(request);
			sessions.login(
				body.password,
				response,
				request.headers.origin?.startsWith("https://"),
			);
			return json(response, 200, { authenticated: true });
		}
		sessions.require(request);
		if (method === "GET" && url.pathname === "/api/state")
			return json(response, 200, {
				...(await runtime.view()),
				identity: identity.public,
			});
		if (method === "POST" && url.pathname === "/api/logout") {
			sessions.logout(request, response);
			return json(response, 200, { authenticated: false });
		}
		if (method === "POST" && url.pathname === "/api/connect") {
			await runtime.connect(await readJson(request));
			return json(response, 200, { connected: true });
		}
		if (method === "POST" && url.pathname === "/api/tasks") {
			const id = await runtime.start(await readJson(request));
			return json(response, 201, { id });
		}
		const match = /^\/api\/tasks\/([^/]+)\/([^/]+)$/.exec(url.pathname);
		if (
			method === "POST" &&
			match &&
			UUID.test(match[1]!) &&
			commands.has(match[2]!)
		) {
			const body = await readJson(request);
			const allowed =
				match[2] === "lookup"
					? ["transactionReference"]
					: match[2] === "evidence"
						? ["lookupMessageId"]
						: match[2] === "query"
							? ["fromOccurredAt", "toOccurredAt"]
							: [];
			if (Object.keys(body).some((key) => !allowed.includes(key)))
				throw new AppError("INVALID_REQUEST");
			if (match[2] === "run-agent") {
				void runtime.command(match[1]!, match[2]!, body).catch(() => {});
				return json(response, 202, { accepted: true });
			}
			await runtime.command(match[1]!, match[2]!, body);
			return json(response, 200, { accepted: true });
		}
		throw new AppError("NOT_FOUND", 404);
	} catch (error) {
		if (!response.headersSent)
			json(response, error instanceof AppError ? error.status : 503, {
				error: errorCode(error),
			});
		else response.end();
	}
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
let polling = false;
const timer = setInterval(async () => {
	if (polling) return;
	polling = true;
	try {
		await runtime.tick();
	} catch {
		/* Public task reads retain the last durable state. */
	} finally {
		polling = false;
	}
}, 5000);
server.listen(config.port, config.host, () =>
	console.log(`Agent ${config.role}: http://${config.host}:${config.port}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		clearInterval(timer);
		server.close();
		server.closeIdleConnections();
	});
