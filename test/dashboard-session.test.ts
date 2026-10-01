import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Sessions } from "../src/http.ts";

test("dashboard cookies are separate by role and HTTPS origins receive Secure cookies", () => {
	const a = new Sessions(
		"synthetic-dashboard-password",
		["https://agent-a.example"],
		"A",
	);
	const b = new Sessions(
		"synthetic-dashboard-password",
		["http://127.0.0.1:3002"],
		"B",
	);
	let cookie = "";
	const response = {
		setHeader(_name: string, value: string) {
			cookie = value;
		},
	} as unknown as ServerResponse;
	a.login("synthetic-dashboard-password", response, true);
	assert.match(cookie, /^raziel-agent-a=/);
	assert.match(cookie, /; Secure$/);
	const request = {
		headers: {
			cookie: cookie.split(";")[0],
			origin: "https://agent-a.example",
		},
	} as IncomingMessage;
	assert.equal(a.authenticated(request), true);
	assert.equal(b.authenticated(request), false);
	a.origin(request);
	assert.throws(() => b.origin(request), /ORIGIN_REJECTED/);
	assert.throws(() => a.login("wrong-password", response), /LOGIN_FAILED/);
	a.logout(request, response);
	assert.equal(a.authenticated(request), false);
});
