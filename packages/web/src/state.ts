import { signal } from "@preact/signals";
import { RpcClient } from "./client.ts";
import type {
	AgentMessage,
	AgentSessionEvent,
	BashResult,
	ImageContent,
	Model,
	RpcExtensionUIRequest,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
	SessionStats,
	ToolResultLike,
	ToolResultMessage,
} from "./protocol.ts";

export interface ToolDisplayState {
	name: string;
	args: Record<string, unknown>;
	status: "running" | "done";
	partial?: string;
	output?: string;
	isError?: boolean;
}

export interface Toast {
	id: number;
	message: string;
	kind: "info" | "warning" | "error";
}

export interface Widget {
	lines: string[];
	placement: "aboveEditor" | "belowEditor";
}

export const connected = signal(false);
export const sessionState = signal<RpcSessionState | undefined>(undefined);
export const messages = signal<AgentMessage[]>([]);
export const toolStates = signal<Record<string, ToolDisplayState>>({});
export const stats = signal<SessionStats | undefined>(undefined);
export const slashCommands = signal<RpcSlashCommand[]>([]);
export const queue = signal<{ steering: readonly string[]; followUp: readonly string[] }>({
	steering: [],
	followUp: [],
});
export const workingMessage = signal<string | undefined>(undefined);
export const toasts = signal<Toast[]>([]);
export const dialogQueue = signal<RpcExtensionUIRequest[]>([]);
export const statusEntries = signal<Record<string, string>>({});
export const widgets = signal<Record<string, Widget>>({});
export const editorText = signal("");

let nextToastId = 1;

export function pushToast(message: string, kind: Toast["kind"] = "info"): void {
	const id = nextToastId++;
	toasts.value = [...toasts.value, { id, message, kind }];
	setTimeout(() => {
		toasts.value = toasts.value.filter((toast) => toast.id !== id);
	}, 6_000);
}

// ============================================================================
// Client wiring
// ============================================================================

// The app is served at / by pi --web and at /i/<instance-id>/ by pi-server;
// the WS endpoint is always at <base>ws.
const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
const basePath = location.pathname.endsWith("/") ? location.pathname : `${location.pathname}/`;
export const client = new RpcClient(`${wsProtocol}://${location.host}${basePath}ws`, {
	onEvent: handleEvent,
	onUiRequest: handleUiRequest,
	onUiCancel: (id) => {
		dialogQueue.value = dialogQueue.value.filter((queued) => queued.id !== id);
	},
	onConnectionChange: handleConnectionChange,
});

let syncing = false;
const eventBuffer: AgentSessionEvent[] = [];

function handleConnectionChange(isConnected: boolean): void {
	connected.value = isConnected;
	if (isConnected) {
		void sync();
	}
}

export function dataAs<T>(response: RpcResponse, command: string): T | undefined {
	return response.success && response.command === command ? (response.data as T) : undefined;
}

async function sync(): Promise<void> {
	syncing = true;
	try {
		const [stateRes, messagesRes, commandsRes, statsRes] = await Promise.all([
			client.command({ type: "get_state" }),
			client.command({ type: "get_messages" }),
			client.command({ type: "get_commands" }),
			client.command({ type: "get_session_stats" }),
		]);
		const state = dataAs<RpcSessionState>(stateRes, "get_state");
		if (state) {
			sessionState.value = state;
			updateTitle(state.sessionName);
		}
		const history = dataAs<{ messages: AgentMessage[] }>(messagesRes, "get_messages");
		if (history) {
			messages.value = history.messages;
			rebuildToolStates(history.messages);
		}
		const commandList = dataAs<{ commands: RpcSlashCommand[] }>(commandsRes, "get_commands");
		if (commandList) {
			slashCommands.value = commandList.commands;
		}
		const sessionStats = dataAs<SessionStats>(statsRes, "get_session_stats");
		if (sessionStats) {
			stats.value = sessionStats;
		}
		if (sessionState.value?.isStreaming) {
			workingMessage.value = "Working";
		}
	} catch (error) {
		pushToast(`Failed to sync session state: ${error instanceof Error ? error.message : String(error)}`, "error");
	} finally {
		syncing = false;
		const buffered = eventBuffer.splice(0);
		for (const event of buffered) {
			applyEvent(event);
		}
	}
}

function handleEvent(event: AgentSessionEvent): void {
	if (syncing) {
		eventBuffer.push(event);
		return;
	}
	applyEvent(event);
}

function updateTitle(sessionName: string | undefined): void {
	document.title = sessionName ? `pi - ${sessionName}` : "pi";
}

// ============================================================================
// Message handling
// ============================================================================

function messageTimestamp(message: AgentMessage): number {
	return message.timestamp;
}

function upsertMessage(message: AgentMessage): void {
	const list = messages.value;
	const timestamp = messageTimestamp(message);
	for (let i = list.length - 1; i >= 0; i--) {
		const existing = list[i];
		if (existing.role === message.role && messageTimestamp(existing) === timestamp) {
			const next = [...list];
			next[i] = message;
			messages.value = next;
			return;
		}
	}
	messages.value = [...list, message];
}

function setToolState(toolCallId: string, updates: Partial<ToolDisplayState>): void {
	const existing = toolStates.value[toolCallId];
	toolStates.value = {
		...toolStates.value,
		[toolCallId]: {
			name: updates.name ?? existing?.name ?? "tool",
			args: updates.args ?? existing?.args ?? {},
			status: updates.status ?? existing?.status ?? "running",
			...updates,
		},
	};
}

function extractResultText(result: ToolResultLike | undefined): string | undefined {
	if (!result || !Array.isArray(result.content)) {
		return undefined;
	}
	const texts: string[] = [];
	for (const block of result.content) {
		if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
			texts.push(block.text);
		}
	}
	return texts.length > 0 ? texts.join("\n") : undefined;
}

function rebuildToolStates(history: AgentMessage[]): void {
	const resultsByToolCallId = new Map<string, ToolResultMessage>();
	for (const message of history) {
		if (message.role === "toolResult") {
			resultsByToolCallId.set(message.toolCallId, message);
		}
	}
	const states: Record<string, ToolDisplayState> = {};
	for (const message of history) {
		if (message.role !== "assistant") continue;
		for (const toolCall of message.content) {
			if (toolCall.type !== "toolCall") continue;
			const result = resultsByToolCallId.get(toolCall.id);
			states[toolCall.id] = {
				name: toolCall.name,
				args: toolCall.arguments,
				status: result ? "done" : "running",
				output: result ? extractResultText(result) : undefined,
				isError: result?.isError,
			};
		}
	}
	toolStates.value = states;
}

// ============================================================================
// Event reduction
// ============================================================================

function refreshStats(): void {
	void client
		.command({ type: "get_session_stats" })
		.then((res) => {
			const sessionStats = dataAs<SessionStats>(res, "get_session_stats");
			if (sessionStats) {
				stats.value = sessionStats;
			}
		})
		.catch(() => {});
}

function applyEvent(event: AgentSessionEvent): void {
	switch (event.type) {
		case "message_start":
		case "message_end":
		case "message_update":
			upsertMessage(event.message);
			break;

		case "tool_execution_start":
			setToolState(event.toolCallId, {
				name: event.toolName,
				args: event.args ?? {},
				status: "running",
				partial: undefined,
				output: undefined,
				isError: undefined,
			});
			break;

		case "tool_execution_update":
			setToolState(event.toolCallId, {
				partial: extractResultText(event.partialResult),
			});
			break;

		case "tool_execution_end":
			setToolState(event.toolCallId, {
				status: "done",
				output: extractResultText(event.result),
				isError: event.isError,
			});
			break;

		case "agent_start":
			workingMessage.value = "Working";
			break;

		case "turn_end":
			refreshStats();
			break;

		case "agent_end":
			if (!event.willRetry) {
				refreshStats();
			}
			break;

		case "agent_settled":
			workingMessage.value = undefined;
			refreshStats();
			break;

		case "queue_update":
			queue.value = { steering: event.steering, followUp: event.followUp };
			break;

		case "compaction_start":
			workingMessage.value = "Compacting context";
			break;

		case "compaction_end":
			workingMessage.value = undefined;
			if (event.errorMessage) {
				pushToast(`Compaction failed: ${event.errorMessage}`, "error");
			} else if (!event.aborted) {
				if (event.result) {
					// Mirror the compactionSummary message the session appends to its history
					messages.value = [
						...messages.value,
						{
							role: "compactionSummary",
							summary: event.result.summary,
							tokensBefore: event.result.tokensBefore,
							timestamp: Date.now(),
						},
					];
				}
				pushToast("Context compacted", "info");
				refreshStats();
			}
			break;

		case "auto_retry_start":
			workingMessage.value = `Retrying (${event.attempt}/${event.maxAttempts})`;
			break;

		case "auto_retry_end":
			workingMessage.value = undefined;
			if (!event.success) {
				pushToast(event.finalError ?? "Retry failed", "error");
			}
			break;

		case "summarization_retry_scheduled":
			workingMessage.value = `Retrying summary (${event.attempt}/${event.maxAttempts})`;
			break;

		case "summarization_retry_attempt_start":
		case "summarization_retry_finished":
			break;

		case "session_info_changed":
			if (sessionState.value) {
				sessionState.value = { ...sessionState.value, sessionName: event.name };
			}
			updateTitle(event.name);
			break;

		case "thinking_level_changed":
			if (sessionState.value) {
				sessionState.value = { ...sessionState.value, thinkingLevel: event.level };
			}
			break;

		case "extension_error":
			pushToast(`Extension error: ${event.error}`, "error");
			break;

		case "terminal_output":
			// Not stored in message history: terminal output is display-only and is
			// never part of the model's context.
			terminalOutput.value = { data: event.data, seq: terminalOutputSeq++ };
			break;

		case "terminal_exit":
			pushToast(event.reason ? `Terminal exited (${event.reason})` : "Terminal exited", "info");
			break;

		default:
			break;
	}
}

// ============================================================================
// Extension UI requests
// ============================================================================

function handleUiRequest(request: RpcExtensionUIRequest): void {
	switch (request.method) {
		case "select":
		case "confirm":
		case "input":
		case "editor":
			dialogQueue.value = [...dialogQueue.value, request];
			break;
		case "notify":
			pushToast(request.message, request.notifyType ?? "info");
			break;
		case "setStatus": {
			const next = { ...statusEntries.value };
			if (request.statusText) {
				next[request.statusKey] = request.statusText;
			} else {
				delete next[request.statusKey];
			}
			statusEntries.value = next;
			break;
		}
		case "setWidget": {
			const next = { ...widgets.value };
			if (request.widgetLines) {
				next[request.widgetKey] = {
					lines: request.widgetLines,
					placement: request.widgetPlacement ?? "aboveEditor",
				};
			} else {
				delete next[request.widgetKey];
			}
			widgets.value = next;
			break;
		}
		case "setTitle":
			document.title = request.title;
			break;
		case "set_editor_text":
			editorText.value = request.text;
			break;
	}
}

export function respondToDialog(
	request: RpcExtensionUIRequest,
	response: { value?: string; confirmed?: boolean; cancelled?: true },
): void {
	dialogQueue.value = dialogQueue.value.filter((queued) => queued.id !== request.id);
	if (response.cancelled) {
		client.sendUiResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
	} else if (response.confirmed !== undefined) {
		client.sendUiResponse({ type: "extension_ui_response", id: request.id, confirmed: response.confirmed });
	} else if (response.value !== undefined) {
		client.sendUiResponse({ type: "extension_ui_response", id: request.id, value: response.value });
	} else {
		client.sendUiResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
	}
}

// ============================================================================
// Outgoing actions
// ============================================================================

function reportFailure(response: RpcResponse, fallback: string): void {
	if (!response.success) {
		pushToast(response.error || fallback, "error");
	}
}

export async function sendPrompt(text: string, images: ImageContent[]): Promise<void> {
	const busy = sessionState.value?.isStreaming || workingMessage.value !== undefined;
	const response = await client.command({
		type: "prompt",
		message: text,
		...(images.length > 0 ? { images } : {}),
		...(busy ? { streamingBehavior: "steer" as const } : {}),
	});
	reportFailure(response, "Prompt rejected");
}

export async function sendAbort(): Promise<void> {
	const response = await client.command({ type: "abort" });
	reportFailure(response, "Abort failed");
}

// ============================================================================
// Builtin slash commands (mapped to RPC command verbs, see rpc.md get_commands)
// ============================================================================

/**
 * Terminal panel visibility. Hiding the panel does not close the shell: the
 * terminal is owned by the pi process and keeps running.
 */
export const terminalOpen = signal(false);
/**
 * Latest terminal output chunk. `seq` makes each chunk a distinct value so
 * repeated identical output still notifies subscribers.
 */
export const terminalOutput = signal<{ data: string; seq: number } | undefined>(undefined);
let terminalOutputSeq = 0;

/** Transient card shown at the bottom of the chat (e.g. /session output). */
export const commandResult = signal<{ title: string; markdown: string } | undefined>(undefined);
export const modelPickerOpen = signal(false);
export const forkPickerOpen = signal(false);

function formatTokenCount(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}

/** Run a bash command (! prefix in the editor). */
export async function sendBash(command: string): Promise<void> {
	if (command.trim() === "") return;
	const response = await client.command({ type: "bash", command });
	if (!response.success) {
		reportFailure(response, "Bash failed");
		return;
	}
	const result = dataAs<BashResult>(response, "bash");
	// The session records a bashExecution message; mirror it locally until the next sync
	messages.value = [
		...messages.value,
		{
			role: "bashExecution",
			command,
			output: result?.output ?? "",
			exitCode: result?.exitCode,
			cancelled: result?.cancelled ?? false,
			truncated: result?.truncated ?? false,
			fullOutputPath: result?.fullOutputPath,
			timestamp: Date.now(),
		},
	];
	refreshStats();
}

async function setModelByQuery(query: string): Promise<void> {
	const response = await client.command({ type: "get_available_models" });
	const models = dataAs<{ models: Model[] }>(response, "get_available_models")?.models ?? [];
	const normalized = query.toLowerCase();
	const match =
		models.find((model) => `${model.provider}/${model.id}`.toLowerCase() === normalized) ??
		models.find((model) => model.id.toLowerCase() === normalized) ??
		models.find(
			(model) =>
				model.id.toLowerCase().includes(normalized) ||
				model.name.toLowerCase().includes(normalized) ||
				`${model.provider}/${model.id}`.toLowerCase().includes(normalized),
		);
	if (!match) {
		pushToast(`No model matching "${query}"`, "error");
		return;
	}
	const setResponse = await client.command({ type: "set_model", provider: match.provider, modelId: match.id });
	if (!setResponse.success) {
		reportFailure(setResponse, "Failed to set model");
		return;
	}
	pushToast(`Model: ${match.name}`, "info");
	await sync();
}

async function showSessionInfo(): Promise<void> {
	const [statsResponse, stateResponse] = await Promise.all([
		client.command({ type: "get_session_stats" }),
		client.command({ type: "get_state" }),
	]);
	const sessionStats = dataAs<SessionStats>(statsResponse, "get_session_stats");
	const state = dataAs<RpcSessionState>(stateResponse, "get_state");
	if (!sessionStats || !state) {
		pushToast("Failed to load session info", "error");
		return;
	}
	const lines = [
		state.sessionName ? `**${state.sessionName}**` : undefined,
		`Session: \`${sessionStats.sessionId}\``,
		sessionStats.sessionFile ? `File: \`${sessionStats.sessionFile}\`` : undefined,
		state.model ? `Model: ${state.model.name} · thinking ${state.thinkingLevel}` : undefined,
		`Messages: ${sessionStats.totalMessages} (${sessionStats.userMessages} user, ${sessionStats.assistantMessages} assistant, ${sessionStats.toolCalls} tool calls)`,
		`Tokens: ${formatTokenCount(sessionStats.tokens.total)} total (${formatTokenCount(sessionStats.tokens.input)} in, ${formatTokenCount(sessionStats.tokens.output)} out, ${formatTokenCount(sessionStats.tokens.cacheRead)} cache read)`,
		`Cost: $${sessionStats.cost.toFixed(4)}`,
		sessionStats.contextUsage?.percent !== null && sessionStats.contextUsage?.percent !== undefined
			? `Context: ${sessionStats.contextUsage.percent}% of ${formatTokenCount(sessionStats.contextUsage.contextWindow)}`
			: undefined,
	].filter((line): line is string => line !== undefined);
	commandResult.value = { title: "Session", markdown: lines.join("\n\n") };
}

async function forkFromEntry(entryId: string): Promise<void> {
	const response = await client.command({ type: "fork", entryId });
	if (!response.success) {
		reportFailure(response, "Fork failed");
		return;
	}
	const result = dataAs<{ text?: string; cancelled: boolean }>(response, "fork");
	if (result?.text) {
		// Like the TUI: the forked message text goes into the editor for editing
		editorText.value = result.text;
	}
	pushToast("Forked to new session", "info");
	await sync();
}

export async function selectForkEntry(entryId: string): Promise<void> {
	forkPickerOpen.value = false;
	await forkFromEntry(entryId);
}

export async function selectModel(provider: string, modelId: string): Promise<void> {
	modelPickerOpen.value = false;
	const response = await client.command({ type: "set_model", provider, modelId });
	if (!response.success) {
		reportFailure(response, "Failed to set model");
		return;
	}
	await sync();
}

/**
 * Execute a builtin slash command (/compact, /new, /model, ...). Returns true
 * when the command was handled here; false when it should go through `prompt`
 * (extension/prompt/skill commands).
 */
export async function executeBuiltinCommand(text: string): Promise<boolean> {
	const spaceIndex = text.indexOf(" ");
	const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

	switch (name) {
		case "compact": {
			const response = await client.command({ type: "compact", ...(args ? { customInstructions: args } : {}) });
			reportFailure(response, "Compaction failed");
			return true;
		}
		case "new": {
			const response = await client.command({ type: "new_session" });
			if (!response.success) {
				reportFailure(response, "Failed to start new session");
				return true;
			}
			await sync();
			return true;
		}
		case "name": {
			if (!args) {
				pushToast("Usage: /name <session name>", "error");
				return true;
			}
			const response = await client.command({ type: "set_session_name", name: args });
			reportFailure(response, "Failed to set session name");
			return true;
		}
		case "model": {
			if (args) {
				await setModelByQuery(args);
			} else {
				modelPickerOpen.value = true;
			}
			return true;
		}
		case "session": {
			await showSessionInfo();
			return true;
		}
		case "export": {
			const response = await client.command({ type: "export_html", ...(args ? { outputPath: args } : {}) });
			if (!response.success) {
				reportFailure(response, "Export failed");
				return true;
			}
			const exported = dataAs<{ path: string }>(response, "export_html");
			pushToast(`Exported to ${exported?.path ?? "session HTML"} (on the server)`, "info");
			return true;
		}
		case "copy": {
			const response = await client.command({ type: "get_last_assistant_text" });
			const result = dataAs<{ text: string | undefined }>(response, "get_last_assistant_text");
			if (!result?.text) {
				pushToast("No agent message to copy", "error");
				return true;
			}
			try {
				await navigator.clipboard.writeText(result.text);
				pushToast("Copied last agent message", "info");
			} catch {
				pushToast("Clipboard unavailable (requires https or localhost)", "error");
			}
			return true;
		}
		case "fork": {
			forkPickerOpen.value = true;
			return true;
		}
		case "clone": {
			const response = await client.command({ type: "clone" });
			if (!response.success) {
				reportFailure(response, "Clone failed");
				return true;
			}
			pushToast("Cloned session", "info");
			await sync();
			return true;
		}
		case "cd": {
			if (!args) {
				pushToast(`Working location: ${sessionState.value?.cwd ?? "unknown"}`, "info");
				return true;
			}
			const response = await client.command({ type: "change_cwd", cwd: args });
			if (!response.success) {
				reportFailure(response, "Failed to change working location");
				return true;
			}
			const changed = dataAs<{ cancelled: boolean; cwd: string }>(response, "change_cwd");
			if (changed?.cancelled) {
				pushToast("Change of working location cancelled", "info");
				return true;
			}
			pushToast(`Working location: ${changed?.cwd ?? args}`, "info");
			await sync();
			return true;
		}
		default:
			return false;
	}
}
