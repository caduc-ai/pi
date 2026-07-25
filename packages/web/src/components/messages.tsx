import type { AgentMessage, AssistantMessage, ImageContent, ThinkingContent, UserMessage } from "../protocol.ts";
import { MarkdownView } from "./markdown-view.tsx";
import { ToolExecution } from "./tool-execution.tsx";

function userContentParts(message: UserMessage): { text: string; images: ImageContent[] } {
	if (typeof message.content === "string") {
		return { text: message.content, images: [] };
	}
	const textParts: string[] = [];
	const images: ImageContent[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			textParts.push(block.text);
		} else if (block.type === "image") {
			images.push(block);
		}
	}
	return { text: textParts.join("\n"), images };
}

export function UserMessageView({ message }: { message: UserMessage }) {
	const { text, images } = userContentParts(message);
	return (
		<div class="msg msg-user">
			{text && <div class="msg-user-text">{text}</div>}
			{images.map((image, index) => (
				<img
					key={`${image.mimeType}-${index}`}
					class="msg-image"
					src={`data:${image.mimeType};base64,${image.data}`}
					alt="attached"
				/>
			))}
		</div>
	);
}

function ThinkingBlock({ block }: { block: ThinkingContent }) {
	if (block.redacted) {
		return <div class="thinking redacted">Thinking (redacted)</div>;
	}
	return (
		<details class="thinking">
			<summary>Thinking</summary>
			<div class="thinking-content">{block.thinking}</div>
		</details>
	);
}

export function AssistantMessageView({ message }: { message: AssistantMessage }) {
	const hasVisibleContent = message.content.some(
		(block) =>
			(block.type === "text" && block.text.trim() !== "") || block.type === "thinking" || block.type === "toolCall",
	);
	return (
		<div class="msg msg-assistant">
			{message.content.map((block, index) => {
				if (block.type === "thinking") {
					return <ThinkingBlock key={`thinking-${index}`} block={block} />;
				}
				if (block.type === "text") {
					return block.text.trim() === "" ? null : <MarkdownView key={`text-${index}`} text={block.text} />;
				}
				if (block.type === "toolCall") {
					return <ToolExecution key={block.id} toolCallId={block.id} name={block.name} args={block.arguments} />;
				}
				return null;
			})}
			{!hasVisibleContent && message.stopReason !== "error" && message.stopReason !== "aborted" && (
				<div class="msg-empty">…</div>
			)}
			{message.stopReason === "error" && <div class="msg-error">{message.errorMessage ?? "Unknown error"}</div>}
			{message.stopReason === "aborted" && <div class="msg-note">(aborted)</div>}
		</div>
	);
}

export function BashExecutionView({ message }: { message: AgentMessage }) {
	if (message.role !== "bashExecution") return null;
	const exitNote = message.cancelled
		? "cancelled"
		: message.exitCode !== undefined && message.exitCode !== 0
			? `exit code ${message.exitCode}`
			: undefined;
	return (
		<div class="msg msg-bash">
			<div class="bash-command">$ {message.command}</div>
			{message.output && <pre class="bash-output">{message.output}</pre>}
			{exitNote && <div class="msg-note">({exitNote})</div>}
		</div>
	);
}

export function CustomMessageView({ message }: { message: AgentMessage }) {
	if (message.role !== "custom") return null;
	return (
		<div class="msg msg-custom">
			<div class="custom-label">{message.customType}</div>
			{typeof message.content === "string" ? <MarkdownView text={message.content} /> : null}
		</div>
	);
}

export function CompactionSummaryView({ message }: { message: AgentMessage }) {
	if (message.role !== "compactionSummary") return null;
	return (
		<details class="msg msg-summary">
			<summary>Context compacted ({message.tokensBefore.toLocaleString()} tokens before)</summary>
			<div class="summary-content">{message.summary}</div>
		</details>
	);
}

export function BranchSummaryView({ message }: { message: AgentMessage }) {
	if (message.role !== "branchSummary") return null;
	return (
		<details class="msg msg-summary">
			<summary>Branch summary</summary>
			<div class="summary-content">{message.summary}</div>
		</details>
	);
}
