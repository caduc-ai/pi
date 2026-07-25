import { useState } from "preact/hooks";
import { toolStates } from "../state.ts";

const COLLAPSE_LINE_THRESHOLD = 15;
const COLLAPSE_CHAR_THRESHOLD = 2000;

// Remember expand/collapse per tool call across re-renders
const expandedToolCalls = new Map<string, boolean>();

function summarizeArgs(args: Record<string, unknown>): string {
	const candidate =
		(typeof args.command === "string" && args.command) ||
		(typeof args.path === "string" && args.path) ||
		(typeof args.file_path === "string" && args.file_path) ||
		(typeof args.query === "string" && args.query) ||
		(typeof args.pattern === "string" && args.pattern) ||
		JSON.stringify(args);
	const singleLine = candidate.replace(/\s+/g, " ").trim();
	return singleLine.length > 100 ? `${singleLine.slice(0, 100)}…` : singleLine;
}

export function ToolExecution({
	toolCallId,
	name,
	args,
}: {
	toolCallId: string;
	name: string;
	args: Record<string, unknown>;
}) {
	const live = toolStates.value[toolCallId];
	const status = live?.status ?? "running";
	const isError = live?.isError ?? false;
	const output = live?.output ?? live?.partial ?? "";

	const [expanded, setExpanded] = useState(expandedToolCalls.get(toolCallId) ?? false);
	const toggleExpanded = () => {
		const next = !expanded;
		expandedToolCalls.set(toolCallId, next);
		setExpanded(next);
	};

	const statusClass = status === "running" ? "tool-pending" : isError ? "tool-error" : "tool-success";
	const summary = summarizeArgs(args);
	const lineCount = output === "" ? 0 : output.split("\n").length;
	const isLong = lineCount > COLLAPSE_LINE_THRESHOLD || output.length > COLLAPSE_CHAR_THRESHOLD;

	return (
		<div class={`tool ${statusClass}`}>
			<button type="button" class="tool-title" onClick={isLong ? toggleExpanded : undefined}>
				<span class="tool-name">{name}</span>
				{summary && <span class="tool-summary">{summary}</span>}
				{status === "running" && <span class="tool-running-indicator">…</span>}
			</button>
			{output && <pre class={`tool-output ${isLong && !expanded ? "collapsed" : ""}`}>{output}</pre>}
			{isLong && (
				<button type="button" class="tool-toggle" onClick={toggleExpanded}>
					{expanded ? "Show less" : `Show all ${lineCount} lines`}
				</button>
			)}
		</div>
	);
}
