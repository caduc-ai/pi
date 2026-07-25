import { computed } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { buildChatEntries, type ChatEntry } from "../chat-items.ts";
import type { AssistantMessage, UserMessage } from "../protocol.ts";
import { messages } from "../state.ts";
import {
	AssistantMessageView,
	BashExecutionView,
	BranchSummaryView,
	CompactionSummaryView,
	CustomMessageView,
	UserMessageView,
} from "./messages.tsx";

const entries = computed(() => buildChatEntries(messages.value));

function Entry({ entry }: { entry: ChatEntry }) {
	switch (entry.kind) {
		case "user":
			return <UserMessageView message={entry.message as UserMessage} />;
		case "assistant":
			return <AssistantMessageView message={entry.message as AssistantMessage} />;
		case "bash":
			return <BashExecutionView message={entry.message} />;
		case "custom":
			return <CustomMessageView message={entry.message} />;
		case "compaction":
			return <CompactionSummaryView message={entry.message} />;
		case "branchSummary":
			return <BranchSummaryView message={entry.message} />;
		default:
			return null;
	}
}

const NEAR_BOTTOM_PX = 120;

export function ChatList() {
	const containerRef = useRef<HTMLDivElement>(null);
	const stickToBottom = useRef(true);

	const handleScroll = () => {
		const el = containerRef.current;
		if (!el) return;
		stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
	};

	useEffect(() => {
		const el = containerRef.current;
		if (el && stickToBottom.current) {
			el.scrollTop = el.scrollHeight;
		}
	});

	// Scroll to bottom on first load
	useEffect(() => {
		const el = containerRef.current;
		if (el) {
			el.scrollTop = el.scrollHeight;
		}
	}, []);

	return (
		<div class="chat" ref={containerRef} onScroll={handleScroll}>
			{entries.value.length === 0 && <div class="chat-empty">No messages yet. Say something.</div>}
			{entries.value.map((entry) => (
				<Entry key={entry.key} entry={entry} />
			))}
		</div>
	);
}
