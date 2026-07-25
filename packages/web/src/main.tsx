import { render } from "preact";
import { App } from "./app.tsx";
import { client } from "./state.ts";
import { initTheme } from "./theme.ts";
import "./style.css";

void initTheme().catch(() => {
	// Theme endpoint unavailable (e.g. running without the bridge); CSS fallbacks apply.
});

client.start();

const container = document.getElementById("app");
if (container) {
	render(<App />, container);
}
