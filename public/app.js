"use strict";

(() => {
	const $ = (id) => document.getElementById(id);
	const LIMIT = {
		tasks: 200,
		rows: 100,
		messages: 40,
		inbox: 200,
		text: 512,
		summary: 4000,
	};
	const TERMINAL = new Set([
		"canceled",
		"cancelled",
		"rejected",
		"expired",
		"failed",
		"completed",
		"done",
	]);
	const ROW_FIELDS = [
		["transactionId", "transaction_id"],
		["occurredAt", "occurred_at"],
		["amountMinor", "amount_minor"],
		["currency"],
		["merchantReference", "merchant_reference"],
		["accountReference", "account_reference"],
		["transactionType", "transaction_type"],
		["reconciliationStatus", "reconciliation_status"],
	];
	// Only bounded business fields enter message/result views. Never render arbitrary objects.
	const BUSINESS_FIELDS = [
		["status", "Status"],
		["transactionReference", "Transaction reference"],
		["merchantReference", "Merchant reference"],
		["candidateCount", "Candidates"],
		["settlementReference", "Settlement reference"],
		["currency", "Currency"],
		["amountMinor", "Amount (minor)"],
		["settlementAmountMinor", "Settlement amount (minor)"],
		["amountDifferenceMinor", "Difference (minor)"],
		["evidenceReceiptId", "Evidence receipt"],
		["receiptId", "Receipt"],
		["lookupMessageId", "Lookup message"],
		["matchCount", "Matches"],
		["matchedCount", "Matched"],
		["unmatchedCount", "Unmatched"],
		["ambiguousCount", "Ambiguous"],
		["checkedCount", "Checked"],
		["datasetId", "Dataset"],
		["datasetRevision", "Revision"],
		["channelTaskId", "Channel task"],
		["taskId", "Task"],
	];
	let state = null;
	let selectedId = null;
	let queryTaskId = null;
	let authenticated = false;
	let epoch = 0;
	let timer = null;
	let stateRequest = null;
	let connectionDirty = false;
	let connectionRevision = 0;
	let roleInitialized = false;
	let failedRefresh = false;
	const busy = new Set();
	const taskNodes = new Map();
	const list = (value) => (Array.isArray(value) ? value : []);
	const scalar = (value, max = LIMIT.text) => {
		if (
			typeof value !== "string" &&
			typeof value !== "number" &&
			typeof value !== "boolean"
		)
			return "-";
		const text = String(value);
		return text.length > max ? text.slice(0, max) + "..." : text;
	};
	const put = (id, value, max) => {
		$(id).textContent = scalar(value, max);
	};
	const node = (tag, value, className) => {
		const element = document.createElement(tag);
		if (value !== undefined) element.textContent = scalar(value);
		if (className) element.className = className;
		return element;
	};
	const normalize = (value) =>
		typeof value === "string" ? value.toLowerCase().replaceAll("-", "_") : "";
	const task = () =>
		list(state?.tasks).find((entry) => entry.id === selectedId);
	const note = (message) => {
		put("notice", message);
		$("notice").hidden = !message;
	};
	const fieldValue = (object, keys) =>
		keys.map((key) => object?.[key]).find((value) => value !== undefined);

	function stamp(value) {
		if (typeof value !== "string" && typeof value !== "number") return "-";
		const date = new Date(value);
		return Number.isFinite(date.getTime())
			? date.toISOString().replace("T", " ").replace(".000Z", " UTC")
			: "-";
	}

	function pairs(target, entries) {
		const fragment = document.createDocumentFragment();
		for (const [label, value] of entries) {
			fragment.append(node("dt", label), node("dd", value));
		}
		target.replaceChildren(fragment);
	}

	function businessPairs(value) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return [];
		return BUSINESS_FIELDS.filter(([key]) =>
			["string", "number", "boolean"].includes(typeof value[key]),
		).map(([key, label]) => [label, value[key]]);
	}

	function phaseBadge(element, value, paused = false) {
		const phase = normalize(value);
		element.textContent = paused
			? "Paused"
			: scalar(value || "Pending").replaceAll("_", " ");
		element.className = "badge";
		if (
			paused ||
			/waiting|pending|preparing|proving|signing|submitted|queued/.test(phase)
		)
			element.classList.add("warning");
		else if (/failed|rejected|expired|error/.test(phase))
			element.classList.add("error");
		else if (/cancel/.test(phase)) element.classList.add("neutral");
	}

	class RequestError extends Error {
		constructor(status) {
			super(
				status === 401
					? "Sign in required."
					: status === 403
						? "Request not permitted."
						: status === 409
							? "Request conflicts with the current state. Refresh and try again."
							: status === 429
								? "Too many requests. Try again later."
								: "Request failed. Check the connection and refresh.",
			);
			this.status = status;
		}
	}

	async function api(path, body) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15000);
		try {
			const response = await fetch(path, {
				method: body === undefined ? "GET" : "POST",
				credentials: "same-origin",
				cache: "no-store",
				headers: {
					Accept: "application/json",
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: controller.signal,
			});
			if (!response.ok) throw new RequestError(response.status);
			if (response.status === 204) return {};
			const text = await response.text();
			return text ? JSON.parse(text) : {};
		} catch (error) {
			if (error instanceof RequestError) throw error;
			throw new RequestError(0);
		} finally {
			clearTimeout(timeout);
		}
	}

	function endSession() {
		epoch += 1;
		authenticated = false;
		clearInterval(timer);
		timer = null;
		state = null;
		selectedId = null;
		queryTaskId = null;
		stateRequest = null;
		connectionDirty = false;
		roleInitialized = false;
		taskNodes.clear();
		for (const id of [
			"password",
			"api-token",
			"public-key",
			"key-thumbprint",
			"registered-agent-id",
			"base-url",
			"audience",
			"transaction-reference",
		]) {
			if ($(id).tagName === "INPUT") $(id).value = "";
			else put(id, "-");
		}
		for (const id of [
			"task-list",
			"query-rows",
			"message-list",
			"result-fields",
			"task-summary",
			"capability-claims",
			"task-meta",
			"llm-meta",
		])
			$(id).replaceChildren();
		$("incoming-task").replaceChildren(node("option", "Select task"));
		$("incoming-task").firstChild.value = "";
		$("incoming-message").replaceChildren(node("option", "Select message"));
		$("incoming-message").firstChild.value = "";
		$("evidence-message").replaceChildren(node("option", "Current lookup"));
		$("evidence-message").firstChild.value = "";
		for (const id of ["incoming-task", "incoming-message", "evidence-message"])
			delete $(id).dataset.signature;
		put("incoming-reference", "");
		put("copy-status", "");
		changeTab("tasks-tab");
		$("console-view").hidden = true;
		$("header-session").hidden = true;
		$("login-view").hidden = false;
		$("selected-task").hidden = true;
		$("new-task-section").hidden = true;
		$("new-task-button").setAttribute("aria-expanded", "false");
		document.title = "Raziel | Agent Console";
	}

	function handleError(error, login = false) {
		if (error.status === 401 && !login) endSession();
		note(login && error.status === 401 ? "Sign-in failed." : error.message);
	}

	async function perform(key, action, login = false) {
		if (busy.has(key)) return;
		busy.add(key);
		updateControls();
		note("");
		const startEpoch = epoch;
		try {
			await action();
		} catch (error) {
			if (epoch === startEpoch) handleError(error, login);
		} finally {
			busy.delete(key);
			updateControls();
		}
	}

	async function refreshState(force = false) {
		if (stateRequest) {
			await stateRequest;
			if (!force) return;
		}
		if (!authenticated) return;
		const startEpoch = epoch;
		const pending = (async () => {
			try {
				const next = await api("/api/state");
				if (startEpoch !== epoch || !authenticated) return;
				if (!["A", "B"].includes(next.role) || !Array.isArray(next.tasks))
					throw new RequestError(0);
				state = next;
				if (failedRefresh) note("");
				failedRefresh = false;
				render();
				put(
					"sync-status",
					"Updated " + new Date().toISOString().slice(11, 19) + " UTC",
				);
			} catch (error) {
				if (startEpoch !== epoch) return;
				failedRefresh = true;
				put("sync-status", "Connection unavailable");
				handleError(error);
				updateControls();
			}
		})();
		stateRequest = pending;
		await pending;
		if (stateRequest === pending) stateRequest = null;
	}

	async function startSession() {
		authenticated = true;
		epoch += 1;
		$("login-view").hidden = true;
		$("console-view").hidden = false;
		$("header-session").hidden = false;
		$("session-retry").hidden = true;
		note("");
		clearInterval(timer);
		timer = setInterval(() => {
			if (authenticated) void refreshState();
		}, 5000);
		await refreshState();
	}

	async function checkSession() {
		await perform(
			"session",
			async () => {
				try {
					const session = await api("/api/session");
					if (session.authenticated === true) await startSession();
					else endSession();
				} catch (error) {
					endSession();
					$("session-retry").hidden = false;
					note(error.message);
				}
			},
			true,
		);
	}

	function allMessages(entry) {
		const joined = [...list(entry?.messages)];
		for (const group of list(state?.inbox).slice(0, LIMIT.inbox)) {
			if (group.taskId === entry?.id || group.taskId === entry?.channelTaskId)
				joined.push(...list(group.messages));
		}
		const seen = new Set();
		return joined.filter((message) => {
			if (!message || typeof message.id !== "string" || seen.has(message.id))
				return false;
			seen.add(message.id);
			return true;
		});
	}

	function incomingGroups() {
		return list(state?.inbox)
			.slice(0, LIMIT.inbox)
			.filter((group) => typeof group.taskId === "string")
			.map((group) => ({
				taskId: group.taskId,
				messages: list(group.messages).filter(
					(message) =>
						typeof message?.id === "string" &&
						normalize(message.kind).includes("lookup"),
				),
			}))
			.filter((group) => group.messages.length);
	}

	function options(select, entries, placeholder) {
		// Keep the native select and its selection intact across unchanged polls.
		const next = [["", placeholder], ...entries];
		const signature = JSON.stringify(next);
		if (select.dataset.signature === signature) return;
		if (document.activeElement === select) return;
		const previous = select.value;
		const fragment = document.createDocumentFragment();
		for (const [id, label] of next) {
			const option = node("option", label);
			option.value = id;
			fragment.append(option);
		}
		select.replaceChildren(fragment);
		select.value = next.some(([id]) => id === previous) ? previous : "";
		select.dataset.signature = signature;
	}

	function renderIncoming() {
		const groups = incomingGroups();
		options(
			$("incoming-task"),
			groups.map((group) => [group.taskId, group.taskId]),
			"Select task",
		);
		const group = groups.find(
			(entry) => entry.taskId === $("incoming-task").value,
		);
		options(
			$("incoming-message"),
			list(group?.messages)
				.slice(-LIMIT.messages)
				.map((message) => [
					message.id,
					scalar(message.payload?.transactionReference || message.id),
				]),
			"Select message",
		);
		const message = list(group?.messages).find(
			(entry) => entry.id === $("incoming-message").value,
		);
		put(
			"incoming-reference",
			message
				? "Reference: " + scalar(message.payload?.transactionReference)
				: groups.length
					? ""
					: "No incoming lookups",
		);
		const selected = task();
		const evidenceMessages = [
			...allMessages(selected),
			...list(
				groups.find((entry) => entry.taskId === selected?.channelTaskId)
					?.messages,
			),
		];
		const seen = new Set();
		options(
			$("evidence-message"),
			evidenceMessages
				.filter(
					(entry) =>
						normalize(entry.kind).includes("lookup") &&
						!seen.has(entry.id) &&
						seen.add(entry.id),
				)
				.slice(-LIMIT.messages)
				.map((entry) => [
					entry.id,
					scalar(entry.payload?.transactionReference || entry.id),
				]),
			"Current lookup",
		);
	}

	function selectTask(id) {
		if (selectedId !== id) {
			selectedId = id;
			$("transaction-reference").value = "";
			$("evidence-message").value = "";
		}
		renderTaskList();
		renderDetail();
		renderIncoming();
		updateControls();
	}

	function renderTaskList() {
		const tasks = list(state?.tasks).slice(0, LIMIT.tasks);
		const keep = new Set();
		let position = 0;
		for (const entry of tasks) {
			if (!entry || typeof entry.id !== "string") continue;
			keep.add(entry.id);
			let item = taskNodes.get(entry.id);
			if (!item) {
				const button = node("button", undefined, "task-item");
				button.type = "button";
				const title = node("span", "", "task-item-title");
				const meta = node("span", "", "task-item-meta");
				const badge = node("span", "", "badge");
				button.append(title, meta, badge);
				button.addEventListener("click", () => selectTask(entry.id));
				item = { button, title, meta, badge };
				taskNodes.set(entry.id, item);
			}
			const atPosition = $("task-list").children[position++] ?? null;
			if (atPosition !== item.button)
				$("task-list").insertBefore(item.button, atPosition);
			item.title.textContent = scalar(entry.label || entry.id);
			item.meta.textContent =
				scalar(entry.datasetId) + " / r" + scalar(entry.datasetRevision);
			phaseBadge(item.badge, entry.phase, entry.paused);
			item.button.setAttribute("aria-current", String(entry.id === selectedId));
		}
		for (const [id, item] of taskNodes) {
			if (!keep.has(id)) {
				item.button.remove();
				taskNodes.delete(id);
			}
		}
		put("task-count", list(state?.tasks).length);
		$("no-tasks").hidden = tasks.length > 0;
	}

	function renderRows(entry) {
		const query = entry.lastQuery;
		const rows = list(query?.rows);
		put("row-count", rows.length);
		const path = query?.verification_path;
		put(
			"verification-path",
			["VERIFIER", "CACHE"].includes(path) ? path : "Not queried",
		);
		$("verification-path").className =
			"badge" + (["VERIFIER", "CACHE"].includes(path) ? "" : " neutral");
		put("receipt-id", query?.receiptId);
		const fragment = document.createDocumentFragment();
		for (const row of rows.slice(0, LIMIT.rows)) {
			const tr = node("tr");
			ROW_FIELDS.forEach((keys, index) => {
				const raw = fieldValue(row, keys);
				tr.append(
					node(
						"td",
						index === 1 ? stamp(raw) : raw,
						index === 2 ? "amount" : "",
					),
				);
			});
			fragment.append(tr);
		}
		$("query-rows").replaceChildren(fragment);
		$("rows-empty").hidden = rows.length > 0;
		put(
			"rows-empty",
			query ? "No authorized rows returned" : "No query result",
		);
		$("rows-limit").hidden = rows.length <= LIMIT.rows;
		put("rows-limit", "Showing " + LIMIT.rows + " of " + rows.length + " rows");
	}

	function renderMessages(entry) {
		const messages = allMessages(entry);
		const fragment = document.createDocumentFragment();
		for (const message of messages.slice(-LIMIT.messages)) {
			const item = node("li", undefined, "message");
			const header = node("div", undefined, "message-header");
			const time = node("time", stamp(message.createdAt));
			header.append(
				node("strong", message.sender),
				node("span", message.kind),
				time,
			);
			const fields = node("dl", undefined, "metadata");
			pairs(fields, businessPairs(message.payload));
			item.append(header, node("code", message.id, "message-ref"), fields);
			fragment.append(item);
		}
		$("message-list").replaceChildren(fragment);
		put("message-count", messages.length);
		$("messages-empty").hidden = messages.length > 0;
		$("messages-limit").hidden = messages.length <= LIMIT.messages;
		put(
			"messages-limit",
			"Showing latest " +
				LIMIT.messages +
				" of " +
				messages.length +
				" messages",
		);
	}

	function renderDetail() {
		const entry = task();
		$("no-selection").hidden = Boolean(entry);
		$("selected-task").hidden = !entry;
		if (!entry) return;
		if (queryTaskId !== entry.id) {
			queryTaskId = entry.id;
			$("query-from").value = scalar(entry.fromOccurredAt).replace(/Z$/, "");
			$("query-to").value = scalar(entry.toOccurredAt).replace(/Z$/, "");
		}
		put("detail-label", entry.label || entry.id);
		put(
			"detail-dataset",
			scalar(entry.datasetId) + " / revision " + scalar(entry.datasetRevision),
		);
		phaseBadge($("detail-phase"), entry.phase, entry.paused);
		pairs($("task-meta"), [
			["Task ID", entry.id],
			["Request ID", entry.requestId],
			["Request state", entry.requestState],
			[
				"Execution",
				entry.paused ? "Paused" : entry.running ? "Running" : "Idle",
			],
		]);
		$("task-error").hidden = !entry.error;
		const errorCode =
			typeof entry.error === "string" &&
			/^[A-Z][A-Z0-9_]{1,63}$/.test(entry.error)
				? entry.error
				: "";
		put("task-error", errorCode || "Task action failed. Refresh or retry.");
		const capability = entry.capability;
		const expiry = capability?.expiresAt;
		const expired =
			expiry &&
			Number.isFinite(new Date(expiry).getTime()) &&
			new Date(expiry).getTime() <= Date.now();
		put(
			"capability-status",
			!capability ? "Not issued" : expired ? "Expired" : "Issued",
		);
		$("capability-status").className =
			"badge" + (!capability ? " neutral" : expired ? " error" : "");
		pairs(
			$("capability-claims"),
			capability
				? [
						["Capability ID", capability.id],
						["Expires (UTC)", stamp(expiry)],
						["Policy hash", capability.policyHash],
						["Resource scope", capability.resourceScope],
					]
				: [],
		);
		renderRows(entry);
		renderMessages(entry);
		const directResult = businessPairs(entry.result);
		const latestSettlement = allMessages(entry).findLast(
			(message) => normalize(message.kind) === "settlement_result",
		);
		const result = directResult.length
			? directResult
			: businessPairs(latestSettlement?.payload);
		pairs($("result-fields"), result);
		$("result-empty").hidden = result.length > 0;
		const summary =
			typeof entry.summary === "string" && entry.summary.length > 0;
		$("summary-section").hidden = !summary;
		put("task-summary", summary ? entry.summary : "", LIMIT.summary);
		$("lookup-section").hidden = state.role !== "A";
		$("evidence-section").hidden = state.role !== "B";
	}

	function render() {
		put("agent-label", state.label || "Agent " + state.role);
		put("agent-role", "Agent " + state.role);
		document.title =
			scalar(state.label || "Agent " + state.role, 160) + " | Raziel";
		const configured = Boolean(state.connection?.configured);
		put("connection-status", configured ? "Configured" : "Not configured");
		$("connection-status").className =
			"status" + (configured ? " connected" : "");
		put("connection-badge", configured ? "Configured" : "Not configured");
		$("connection-badge").className = "badge" + (configured ? "" : " neutral");
		put("public-key", state.identity?.publicKey, 4096);
		put("key-thumbprint", state.identity?.keyThumbprint);
		put("registered-agent-id", state.connection?.agentId);
		pairs($("llm-meta"), [
			["Status", state.llm?.configured ? "Configured" : "Not configured"],
			["Model", state.llm?.model],
		]);
		if (
			!connectionDirty &&
			!$("connection-form").contains(document.activeElement)
		) {
			$("base-url").value =
				typeof state.connection?.baseUrl === "string"
					? state.connection.baseUrl
					: "";
			$("audience").value =
				typeof state.connection?.audience === "string"
					? state.connection.audience
					: "";
		}
		if (!roleInitialized) {
			$("dataset-id").value =
				state.role === "B" ? "bank-demo-v1" : "processor-demo-v1";
			$("task-label").value =
				state.role === "B" ? "Settlement lookup" : "Reconciliation";
			roleInitialized = true;
		}
		$("incoming-fields").hidden = state.role !== "B";
		$("incoming-task").required = state.role === "B";
		$("incoming-message").required = state.role === "B";
		$("channel-error").hidden = !state.channelError;
		if (!list(state.tasks).some((entry) => entry.id === selectedId)) {
			selectedId = list(state.tasks)[0]?.id || null;
			$("transaction-reference").value = "";
			$("evidence-message").value = "";
		}
		renderTaskList();
		renderDetail();
		renderIncoming();
		updateControls();
	}

	function can(command, entry) {
		if (!entry) return false;
		const phase = normalize(entry.phase);
		const requestState = normalize(entry.requestState);
		const terminal = TERMINAL.has(phase) || TERMINAL.has(requestState);
		const accessEnded = ["canceled", "cancelled", "rejected", "expired"].some(
			(value) => phase === value || requestState === value,
		);
		if (command === "pause")
			return !entry.paused && (entry.running || !terminal);
		if (failedRefresh || !state?.connection?.configured) return false;
		if (entry.running && !["refresh", "messages"].includes(command))
			return false;
		const capability = entry.capability;
		const expiry = capability && new Date(capability.expiresAt).getTime();
		const validCapability = Boolean(
			capability && Number.isFinite(expiry) && expiry > Date.now(),
		);
		if (command === "refresh" || command === "messages") return true;
		if (command === "resume")
			return (
				!terminal &&
				Boolean(
					entry.paused ||
						phase === "waiting_for_agent" ||
						requestState === "waiting_for_agent",
				)
			);
		if (command === "cancel") return !terminal;
		if (command === "retry")
			return Boolean(
				entry.error || phase === "failed" || requestState === "failed",
			);
		if (command === "run-agent")
			return Boolean(state.llm?.configured && !entry.paused && !terminal);
		if (command === "query" || command === "evidence")
			return !entry.paused && validCapability && !accessEnded;
		if (command === "lookup")
			return (
				state.role === "A" &&
				!entry.paused &&
				validCapability &&
				!accessEnded &&
				Boolean(entry.lastQuery)
			);
		return false;
	}

	function updateControls() {
		$("login-button").disabled = busy.has("login") || busy.has("session");
		$("session-retry").disabled = busy.has("session");
		$("logout-button").disabled = busy.has("logout");
		$("sync-button").disabled = busy.has("sync");
		$("connect-button").disabled = busy.has("connect");
		$("copy-key-button").disabled =
			!state?.identity?.publicKey || busy.has("copy");
		$("create-task-button").disabled =
			busy.has("create") ||
			busy.has("logout") ||
			failedRefresh ||
			!state?.connection?.configured ||
			(state.role === "B" &&
				(!$("incoming-task").value || !$("incoming-message").value));
		const entry = task();
		const pausePending = busy.has("pause:" + entry?.id);
		const pending =
			busy.has("task:" + entry?.id) || pausePending || busy.has("logout");
		for (const button of document.querySelectorAll("[data-command]")) {
			const commandBusy =
				button.dataset.command === "pause"
					? pausePending || busy.has("logout")
					: pending;
			button.disabled = commandBusy || !can(button.dataset.command, entry);
			if (button.dataset.command === "resume")
				button.hidden =
					!entry?.paused &&
					normalize(entry?.phase) !== "waiting_for_agent" &&
					normalize(entry?.requestState) !== "waiting_for_agent";
			if (button.dataset.command === "pause")
				button.hidden = Boolean(entry?.paused);
		}
		$("lookup-button").disabled = pending || !can("lookup", entry);
		$("evidence-button").disabled = pending || !can("evidence", entry);
	}

	async function command(name, body = {}) {
		const entry = task();
		if (!can(name, entry)) return;
		if (name === "query") {
			if (!$("query-from").reportValidity() || !$("query-to").reportValidity())
				return;
			const from = Date.parse($("query-from").value + "Z");
			const to = Date.parse($("query-to").value + "Z");
			if (
				!Number.isFinite(from) ||
				!Number.isFinite(to) ||
				from > to ||
				to - from > 31 * 86400_000
			) {
				note("Invalid UTC date range.");
				return;
			}
			body = {
				fromOccurredAt: new Date(from).toISOString().replace(".000Z", "Z"),
				toOccurredAt: new Date(to).toISOString().replace(".000Z", "Z"),
			};
		}
		const id = entry.id;
		await perform((name === "pause" ? "pause:" : "task:") + id, async () => {
			await api("/api/tasks/" + encodeURIComponent(id) + "/" + name, body);
			await refreshState(true);
		});
	}

	function changeTab(id, focus = false) {
		for (const tab of [$("tasks-tab"), $("identity-tab")]) {
			const active = tab.id === id;
			tab.setAttribute("aria-selected", String(active));
			tab.tabIndex = active ? 0 : -1;
			$(tab.getAttribute("aria-controls")).hidden = !active;
			if (active && focus) tab.focus();
		}
	}

	$("login-form").addEventListener("submit", (event) => {
		event.preventDefault();
		if (!$("login-form").reportValidity()) return;
		const password = $("password").value;
		$("password").value = "";
		void perform(
			"login",
			async () => {
				await api("/api/login", { password });
				await startSession();
			},
			true,
		);
	});
	$("session-retry").addEventListener("click", () => void checkSession());
	$("logout-button").addEventListener(
		"click",
		() =>
			void perform("logout", async () => {
				await api("/api/logout", {});
				endSession();
				note("");
			}),
	);
	$("sync-button").addEventListener(
		"click",
		() => void perform("sync", () => refreshState(true)),
	);
	for (const tab of [$("tasks-tab"), $("identity-tab")]) {
		tab.addEventListener("click", () => changeTab(tab.id));
		tab.addEventListener("keydown", (event) => {
			if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
				return;
			event.preventDefault();
			const id =
				event.key === "Home"
					? "tasks-tab"
					: event.key === "End"
						? "identity-tab"
						: tab.id === "tasks-tab"
							? "identity-tab"
							: "tasks-tab";
			changeTab(id, true);
		});
	}
	function showTaskForm(show) {
		$("new-task-section").hidden = !show;
		$("new-task-button").setAttribute("aria-expanded", String(show));
		if (show) $("task-label").focus();
		else $("new-task-button").focus();
	}
	$("new-task-button").addEventListener("click", () =>
		showTaskForm($("new-task-section").hidden),
	);
	$("close-task-form").addEventListener("click", () => showTaskForm(false));
	$("task-form").addEventListener("submit", (event) => {
		event.preventDefault();
		if (!$("task-form").reportValidity() || $("create-task-button").disabled)
			return;
		const from = $("from-occurred-at").value + "Z";
		const to = $("to-occurred-at").value + "Z";
		const revision = Number($("dataset-revision").value);
		if (
			!Number.isFinite(Date.parse(from)) ||
			!Number.isFinite(Date.parse(to)) ||
			Date.parse(from) > Date.parse(to)
		) {
			note("Invalid UTC date range.");
			return;
		}
		if (!Number.isSafeInteger(revision) || revision < 1) {
			note("Invalid dataset revision.");
			return;
		}
		const body = {
			label: $("task-label").value.trim(),
			datasetId: $("dataset-id").value.trim(),
			datasetRevision: revision,
			fromOccurredAt: new Date(from).toISOString().replace(".000Z", "Z"),
			toOccurredAt: new Date(to).toISOString().replace(".000Z", "Z"),
		};
		if (!body.label || !body.datasetId) {
			note("Task label and dataset are required.");
			return;
		}
		if (state.role === "B") {
			body.channelTaskId = $("incoming-task").value;
			body.lookupMessageId = $("incoming-message").value;
		}
		const previousIds = new Set(list(state.tasks).map((entry) => entry.id));
		void perform("create", async () => {
			const result = await api("/api/tasks", body);
			if (typeof result.id === "string") selectedId = result.id;
			showTaskForm(false);
			await refreshState(true);
			if (typeof result.id !== "string") {
				const created = list(state?.tasks).find(
					(entry) => !previousIds.has(entry.id),
				);
				if (created) selectTask(created.id);
			}
		});
	});
	for (const id of ["incoming-task", "incoming-message", "evidence-message"]) {
		$(id).addEventListener("change", () => {
			renderIncoming();
			updateControls();
		});
		$(id).addEventListener("blur", () => {
			renderIncoming();
			updateControls();
		});
	}
	for (const button of document.querySelectorAll("[data-command]"))
		button.addEventListener(
			"click",
			() => void command(button.dataset.command),
		);
	$("lookup-form").addEventListener("submit", (event) => {
		event.preventDefault();
		const reference = $("transaction-reference").value.trim();
		if (!reference || !$("lookup-form").reportValidity()) return;
		void command("lookup", { transactionReference: reference });
	});
	$("evidence-form").addEventListener("submit", (event) => {
		event.preventDefault();
		const id = $("evidence-message").value;
		void command("evidence", id ? { lookupMessageId: id } : {});
	});
	$("connection-form").addEventListener("input", () => {
		connectionDirty = true;
		connectionRevision += 1;
	});
	$("connection-form").addEventListener("submit", (event) => {
		event.preventDefault();
		if (!$("connection-form").reportValidity()) return;
		const body = {
			baseUrl: $("base-url").value.trim(),
			audience: $("audience").value.trim(),
			token: $("api-token").value,
		};
		let url;
		try {
			url = new URL(body.baseUrl);
		} catch {
			note("Invalid API base URL.");
			return;
		}
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			!body.audience
		) {
			note("Invalid connection settings.");
			return;
		}
		const revision = connectionRevision;
		$("api-token").value = "";
		void perform("connect", async () => {
			await api("/api/connect", body);
			if (revision === connectionRevision) connectionDirty = false;
			await refreshState(true);
		});
	});
	$("copy-key-button").addEventListener(
		"click",
		() =>
			void perform("copy", async () => {
				try {
					await navigator.clipboard.writeText(state.identity.publicKey);
					put("copy-status", "Public key copied");
				} catch {
					const range = document.createRange();
					range.selectNodeContents($("public-key"));
					const selection = window.getSelection();
					selection.removeAllRanges();
					selection.addRange(range);
					put("copy-status", "Clipboard unavailable. Public key selected.");
				}
			}),
	);
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden && authenticated) void refreshState();
	});
	window.addEventListener("pagehide", () => {
		clearInterval(timer);
		$("password").value = "";
		$("api-token").value = "";
	});
	void checkSession();
})();
