import { render } from "preact";
import { App } from "./app.tsx";
import { client } from "./state.ts";
import { applyTheme, currentThemeName } from "./theme.ts";
import "./style.css";

void applyTheme(currentThemeName()).catch(() => {
	// Theme endpoint unavailable (e.g. running without the bridge); CSS fallbacks apply.
});

client.start();

const container = document.getElementById("app");
if (container) {
	render(<App />, container);
}
