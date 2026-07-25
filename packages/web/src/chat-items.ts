import type { AgentMessage } from "./protocol.ts";

export type ChatEntryKind = "user" | "assistant" | "bash" | "custom" | "compaction" | "branchSummary";

export interface ChatEntry {
	kind: ChatEntryKind;
	key: string;
	message: AgentMessage;
}

function messageTimestamp(message: AgentMessage): number {
	return message.timestamp;
}

/**
 * Reduce the session message list to renderable chat entries.
 * toolResult messages are not rendered directly; they are paired with the
 * toolCall block of the preceding assistant message (see state.ts).
 */
export function buildChatEntries(history: AgentMessage[]): ChatEntry[] {
	const entries: ChatEntry[] = [];
	for (const message of history) {
		const key = `${message.role}:${messageTimestamp(message)}`;
		switch (message.role) {
			case "user":
				entries.push({ kind: "user", key, message });
				break;
			case "assistant":
				entries.push({ kind: "assistant", key, message });
				break;
			case "bashExecution":
				entries.push({ kind: "bash", key, message });
				break;
			case "custom":
				if (message.display) {
					entries.push({ kind: "custom", key, message });
				}
				break;
			case "compactionSummary":
				entries.push({ kind: "compaction", key, message });
				break;
			case "branchSummary":
				entries.push({ kind: "branchSummary", key, message });
				break;
			default:
				// toolResult and anything else: not rendered as standalone entries
				break;
		}
	}
	return entries;
}
