import { ChatList } from "./components/chat-list.tsx";
import { DialogHost, ToastHost } from "./components/dialogs.tsx";
import { Editor } from "./components/editor.tsx";
import { Footer } from "./components/footer.tsx";
import { connected, sessionState, widgets } from "./state.ts";

function Header() {
	const name = sessionState.value?.sessionName;
	const isConnected = connected.value;
	return (
		<header class="header">
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

export function App() {
	return (
		<div class="app">
			<Header />
			<ChatList />
			<WidgetArea placement="aboveEditor" />
			<Editor />
			<WidgetArea placement="belowEditor" />
			<Footer />
			<DialogHost />
			<ToastHost />
		</div>
	);
}
