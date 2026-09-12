import { ChatList } from "./components/chat-list.tsx";
import { DialogHost, ToastHost } from "./components/dialogs.tsx";
import { Editor } from "./components/editor.tsx";
import { FileViewer, openFilePath } from "./components/explorer.tsx";
import { StatusStrip } from "./components/footer.tsx";
import { MarkdownView } from "./components/markdown-view.tsx";
import { ForkPicker, ModelPicker } from "./components/pickers.tsx";
import { Sidebar } from "./components/sidebar.tsx";
import { SubagentsPanel } from "./components/subagents.tsx";
import { TerminalView, TuiView } from "./components/terminal.tsx";
import {
	activePanel,
	commandResult,
	connected,
	currentNamespace,
	instanceId,
	sessionState,
	sessionUnreachable,
	sidebarOpen,
	stats,
	subagentRuns,
	terminalOpen,
	toggleSubagentsPanel,
	toggleTui,
	tuiActive,
	widgets,
} from "./state.ts";
import { applyTheme, themeName } from "./theme.ts";

function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}

function ThemeToggle() {
	const isLight = /light/i.test(themeName.value);
	return (
		<button
			type="button"
			class="topbar-icon-btn"
			title={isLight ? "Switch to dark theme" : "Switch to light theme"}
			onClick={() => void applyTheme(isLight ? "dark" : "light")}
		>
			{isLight ? (
				<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
					<title>Dark theme</title>
					<path
						d="M13.5 9.5A5.5 5.5 0 016.5 2.5 5.5 5.5 0 1013.5 9.5z"
						stroke="currentColor"
						stroke-width="1.2"
						fill="none"
					/>
				</svg>
			) : (
				<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
					<title>Light theme</title>
					<circle cx="8" cy="8" r="3.2" stroke="currentColor" stroke-width="1.2" />
					<path
						d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M13 3l-1.4 1.4M4.4 11.6L3 13"
						stroke="currentColor"
						stroke-width="1.2"
						stroke-linecap="round"
					/>
				</svg>
			)}
		</button>
	);
}

function UsageStats() {
	const sessionStats = stats.value;
	if (!sessionStats) return null;
	const context = sessionStats.contextUsage;
	return (
		<span class="topbar-usage">
			<span title="Input tokens">↑{formatTokens(sessionStats.tokens.input)}</span>
			<span title="Output tokens">↓{formatTokens(sessionStats.tokens.output)}</span>
			{sessionStats.tokens.cacheRead > 0 && (
				<span title="Cache read tokens">⟳{formatTokens(sessionStats.tokens.cacheRead)}</span>
			)}
			<span title="Session cost">${sessionStats.cost.toFixed(2)}</span>
			{context && context.percent !== null && context.percent !== undefined && (
				<span title={`${context.tokens ?? "?"} / ${context.contextWindow} tokens`}>
					⌂{context.percent}%/{formatTokens(context.contextWindow)}
				</span>
			)}
		</span>
	);
}

function TopBar() {
	const isConnected = connected.value;
	// Review runs against the session's working location, which /cd can move.
	const cwd = sessionState.value?.cwd;

	return (
		<header class="topbar">
			<div class="topbar-left">
				<button
					type="button"
					class="topbar-icon-btn topbar-sidebar-toggle"
					title="Toggle sidebar"
					onClick={() => {
						sidebarOpen.value = !sidebarOpen.value;
					}}
				>
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
						<title>Toggle sidebar</title>
						<path
							d="M2 3.5h12M2 8h12M2 12.5h12"
							stroke="currentColor"
							stroke-width="1.3"
							stroke-linecap="round"
						/>
					</svg>
				</button>
				<ThemeToggle />
				{currentNamespace.value ? <span class="topbar-namespace-tag">{currentNamespace.value}</span> : null}
				{cwd ? (
					<a
						href={`/review?cwd=${encodeURIComponent(cwd)}${instanceId ? `&instance=${encodeURIComponent(instanceId)}` : ""}`}
						class="topbar-btn"
						title={`Review ${cwd}`}
					>
						<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
							<title>Review</title>
							<path
								d="M3 2h7l3 3v9H3V2z"
								stroke="currentColor"
								stroke-width="1.2"
								fill="none"
								stroke-linejoin="round"
							/>
							<path d="M5.5 9.5l1.5 1.5 3.5-3.5" stroke="currentColor" stroke-width="1.2" fill="none" />
						</svg>
						<span class="topbar-btn-label">Review</span>
					</a>
				) : null}
				<button
					type="button"
					class={`topbar-btn ${activePanel.value === "subagents" ? "active" : ""}`}
					title="Inspect subagent runs"
					onClick={toggleSubagentsPanel}
				>
					<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
						<title>Subagents</title>
						<circle cx="5" cy="5" r="2" stroke="currentColor" stroke-width="1.2" />
						<circle cx="11" cy="5" r="2" stroke="currentColor" stroke-width="1.2" />
						<circle cx="8" cy="11.5" r="2" stroke="currentColor" stroke-width="1.2" />
					</svg>
					<span class="topbar-btn-label">Subagents</span>
					{subagentRuns.value.length > 0 ? (
						<span class="topbar-btn-count">{subagentRuns.value.length}</span>
					) : null}
				</button>
				<button
					type="button"
					class={`topbar-btn ${terminalOpen.value ? "active" : ""}`}
					title="Toggle terminal"
					onClick={() => {
						terminalOpen.value = !terminalOpen.value;
					}}
				>
					<span aria-hidden="true">{">_"}</span>
					<span class="topbar-btn-label">Terminal</span>
				</button>
				<button
					type="button"
					class={`topbar-btn ${tuiActive.value ? "active" : ""}`}
					title="Toggle TUI"
					onClick={() => void toggleTui()}
				>
					<span class="topbar-btn-label">TUI</span>
				</button>
			</div>
			<div class="topbar-right">
				<UsageStats />
				<span
					class={`connection-dot ${isConnected ? "online" : "offline"}`}
					title={isConnected ? "Connected" : "Disconnected"}
				/>
			</div>
		</header>
	);
}

function WidgetArea({ placement }: { placement: "aboveEditor" | "belowEditor" }) {
	const entries = Object.entries(widgets.value).filter(([, widget]) => widget.placement === placement);
	if (entries.length === 0) return null;
	return (
		<div class="widget-area">
			{entries.map(([key, widget]) => (
				<pre key={key} class="widget">
					{widget.lines.join("\n")}
				</pre>
			))}
		</div>
	);
}

function CommandResultCard() {
	const result = commandResult.value;
	if (!result) return null;
	return (
		<div class="command-result">
			<div class="command-result-header">
				<span class="command-result-title">{result.title}</span>
				<button
					type="button"
					class="command-result-close"
					title="Dismiss"
					onClick={() => {
						commandResult.value = undefined;
					}}
				>
					×
				</button>
			</div>
			<MarkdownView text={result.markdown} />
		</div>
	);
}

function UnreachableView() {
	return (
		<div class="unreachable-view">
			<div class="unreachable-card">
				<h1>Session not found</h1>
				<p>This session is no longer running on the server.</p>
				<a href="/" class="unreachable-home">
					Go home
				</a>
			</div>
		</div>
	);
}

export function App() {
	if (sessionUnreachable.value) {
		return <UnreachableView />;
	}
	return (
		<div class="app-shell">
			<Sidebar />
			<div class="main">
				<TopBar />
				<div class="main-content">
					{activePanel.value === "subagents" ? (
						<SubagentsPanel />
					) : tuiActive.value ? (
						<TuiView />
					) : openFilePath.value ? (
						<FileViewer />
					) : (
						<>
							<ChatList />
							<CommandResultCard />
							<WidgetArea placement="aboveEditor" />
							<Editor />
							<WidgetArea placement="belowEditor" />
						</>
					)}
				</div>
				<TerminalView />
				<StatusStrip />
				<DialogHost />
				<ToastHost />
				<ModelPicker />
				<ForkPicker />
			</div>
		</div>
	);
}
