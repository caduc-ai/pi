import { signal } from "@preact/signals";
import { RpcClient } from "./client.ts";
import type {
	AgentMessage,
	AgentSessionEvent,
	ImageContent,
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

const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
export const client = new RpcClient(`${wsProtocol}://${location.host}/ws`, {
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

function dataAs<T>(response: RpcResponse, command: string): T | undefined {
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
