import { ChatList } from "./components/chat-list.tsx";
import { DialogHost, ToastHost } from "./components/dialogs.tsx";
import { Editor } from "./components/editor.tsx";
import { Footer } from "./components/footer.tsx";
import { MarkdownView } from "./components/markdown-view.tsx";
import { ForkPicker, ModelPicker } from "./components/pickers.tsx";
import { commandResult, connected, sessionState, widgets } from "./state.ts";

function Header() {
	const name = sessionState.value?.sessionName;
	const isConnected = connected.value;
	return (
		<header class="header">
			<a href="/" class="header-home" title="All sessions">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
					<title>Home</title>
					<path d="M2 6l6-4 6 4v8H2V6z" stroke="currentColor" stroke-width="1.2" fill="none" />
					<rect x="6" y="9" width="4" height="5" stroke="currentColor" stroke-width="1.2" fill="none" />
				</svg>
			</a>
			<span class="header-title">{name ? `pi — ${name}` : "pi"}</span>
			<span
				class={`connection-dot ${isConnected ? "online" : "offline"}`}
				title={isConnected ? "Connected" : "Disconnected"}
			/>
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

export function App() {
	return (
		<div class="app">
			<Header />
			<ChatList />
			<CommandResultCard />
			<WidgetArea placement="aboveEditor" />
			<Editor />
			<WidgetArea placement="belowEditor" />
			<Footer />
			<DialogHost />
			<ToastHost />
			<ModelPicker />
			<ForkPicker />
		</div>
	);
}
