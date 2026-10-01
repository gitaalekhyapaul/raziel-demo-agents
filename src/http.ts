import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AppError } from "./storage.ts";

export async function readJson(
	request: IncomingMessage,
): Promise<Record<string, unknown>> {
	if (request.headers["content-type"]?.split(";")[0] !== "application/json")
		throw new AppError("JSON_REQUIRED", 415);
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of request) {
		const bytes = Buffer.from(chunk);
		length += bytes.length;
		if (length > 16 * 1024) throw new AppError("REQUEST_TOO_LARGE", 413);
		chunks.push(bytes);
	}
	let value: unknown;
	try {
		value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new AppError("INVALID_JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new AppError("INVALID_REQUEST");
	return value as Record<string, unknown>;
}
export function json(response: ServerResponse, status: number, value: unknown) {
	response.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(JSON.stringify(value));
}
export function equalsSecret(actual: string, expected: string) {
	return timingSafeEqual(
		createHash("sha256").update(actual).digest(),
		createHash("sha256").update(expected).digest(),
	);
}
export class Sessions {
	readonly password: string;
	readonly origins: Set<string>;
	readonly cookieName: string;
	readonly values = new Map<string, number>();
	constructor(password: string, origins: string[], role: "A" | "B") {
		if (password.length < 12)
			throw new AppError("DASHBOARD_PASSWORD_REQUIRED", 503);
		this.password = password;
		this.origins = new Set(origins);
		this.cookieName = `raziel-agent-${role.toLowerCase()}`;
	}
	origin(request: IncomingMessage) {
		if (!request.headers.origin || !this.origins.has(request.headers.origin))
			throw new AppError("ORIGIN_REJECTED", 403);
	}
	token(request: IncomingMessage) {
		return (
			request.headers.cookie
				?.split(";")
				.map((part) => part.trim())
				.find((part) => part.startsWith(`${this.cookieName}=`))
				?.slice(this.cookieName.length + 1) ?? ""
		);
	}
	authenticated(request: IncomingMessage) {
		return (this.values.get(this.token(request)) ?? 0) > Date.now();
	}
	require(request: IncomingMessage) {
		if (!this.authenticated(request)) throw new AppError("LOGIN_REQUIRED", 401);
	}
	login(password: unknown, response: ServerResponse, secure = false) {
		if (typeof password !== "string" || !equalsSecret(password, this.password))
			throw new AppError("LOGIN_FAILED", 401);
		for (const [token, expiry] of this.values)
			if (expiry <= Date.now()) this.values.delete(token);
		if (this.values.size >= 16)
			this.values.delete(this.values.keys().next().value!);
		const token = randomBytes(32).toString("base64url");
		this.values.set(token, Date.now() + 8 * 3600_000);
		response.setHeader(
			"Set-Cookie",
			`${this.cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure ? "; Secure" : ""}`,
		);
	}
	logout(request: IncomingMessage, response: ServerResponse) {
		this.values.delete(this.token(request));
		response.setHeader(
			"Set-Cookie",
			`${this.cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
		);
	}
}
