import { render } from "preact";
import { App } from "./app.tsx";
import { installCodeblockCopy } from "./copy.ts";
import { client } from "./state.ts";
import { initTheme } from "./theme.ts";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

void initTheme().catch(() => {
	// Theme endpoint unavailable (e.g. running without the bridge); CSS fallbacks apply.
});

installCodeblockCopy();

if ("serviceWorker" in navigator) {
	window.addEventListener("load", () => {
		const instanceBase = /^\/i\/[0-9a-f-]{36}(?:\/|$)/.exec(location.pathname)?.[0];
		const scope = instanceBase ? (instanceBase.endsWith("/") ? instanceBase : `${instanceBase}/`) : "/";
		void navigator.serviceWorker.register(`${scope}pwa-sw.js`, { scope }).catch(() => {
			// Service workers are unavailable on insecure non-local origins and in some embedded browsers.
		});
	});
}

client.start();

const container = document.getElementById("app");
if (container) {
	render(<App />, container);
}
