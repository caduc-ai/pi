import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef } from "preact/hooks";
import type { TerminalOpenData } from "../protocol.ts";
import { client, dataAs, terminalOpen, terminalOutput } from "../state.ts";

/** Keys a touch keyboard cannot produce, exposed as buttons on narrow screens. */
const MOBILE_KEYS: Array<{ label: string; bytes: number[] }> = [
	{ label: "Esc", bytes: [0x1b] },
	{ label: "Tab", bytes: [0x09] },
	{ label: "^C", bytes: [0x03] },
	{ label: "^D", bytes: [0x04] },
	{ label: "^Z", bytes: [0x1a] },
	{ label: "←", bytes: [0x1b, 0x5b, 0x44] },
	{ label: "↓", bytes: [0x1b, 0x5b, 0x42] },
	{ label: "↑", bytes: [0x1b, 0x5b, 0x41] },
	{ label: "→", bytes: [0x1b, 0x5b, 0x43] },
];

/**
 * Read a theme CSS custom property. The web UI populates --pi-* from the same
 * theme JSON the TUI uses, so the terminal matches the rest of the app.
 */
function cssVar(name: string, fallback: string): string {
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return value || fallback;
}

function encodeUtf8(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function decodeBase64(data: string): string {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	// stream: true keeps multi-byte characters split across chunks intact.
	return new TextDecoder("utf-8").decode(bytes, { stream: true });
}

export function TerminalView() {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const termRef = useRef<XTerm | null>(null);
	const isOpen = terminalOpen.value;

	useEffect(() => {
		if (!isOpen || !hostRef.current) return;

		const term = new XTerm({
			cursorBlink: true,
			fontSize: 13,
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
			theme: {
				background: cssVar("--pi-cardBg", "#1e1e24"),
				foreground: cssVar("--pi-text", "#d4d4d4"),
				cursor: cssVar("--pi-accent", "#8abeb7"),
			},
			// Scrollback lives in tmux; a modest local buffer is enough for smooth scrolling.
			scrollback: 2000,
			allowProposedApi: true,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(hostRef.current);
		fit.fit();
		termRef.current = term;

		let disposed = false;

		// Local echo is the shell's job; forward every keystroke as raw bytes.
		const dataSub = term.onData((data) => {
			void client.command({ type: "terminal_input", data: encodeUtf8(data) });
		});

		void (async () => {
			const response = await client.command({
				type: "terminal_open",
				cols: term.cols,
				rows: term.rows,
			});
			if (disposed) return;
			if (!response.success) {
				term.writeln(`\r\n\x1b[31m${"error" in response ? response.error : "Failed to open terminal"}\x1b[0m`);
				return;
			}
			const data = dataAs<TerminalOpenData>(response, "terminal_open");
			if (data?.replay) {
				term.write(decodeBase64(data.replay));
			}
			term.focus();
		})();

		// Stream server output into xterm.
		const unsubscribeOutput = terminalOutput.subscribe((chunk) => {
			if (chunk) term.write(decodeBase64(chunk.data));
		});

		const resizeObserver = new ResizeObserver(() => {
			fit.fit();
			void client.command({ type: "terminal_resize", cols: term.cols, rows: term.rows });
		});
		resizeObserver.observe(hostRef.current);

		return () => {
			disposed = true;
			resizeObserver.disconnect();
			unsubscribeOutput();
			dataSub.dispose();
			term.dispose();
			termRef.current = null;
		};
	}, [isOpen]);

	if (!isOpen) return null;

	return (
		<div class="terminal-panel">
			<div class="terminal-header">
				<span class="terminal-title">terminal</span>
				<button
					type="button"
					class="terminal-close"
					title="Hide terminal (session keeps running)"
					onClick={() => {
						terminalOpen.value = false;
					}}
				>
					×
				</button>
			</div>
			<div class="terminal-host" ref={hostRef} />
			<div class="terminal-keys">
				{MOBILE_KEYS.map((key) => (
					<button
						type="button"
						key={key.label}
						class="terminal-key"
						onClick={() => {
							let binary = "";
							for (const byte of key.bytes) binary += String.fromCharCode(byte);
							void client.command({ type: "terminal_input", data: btoa(binary) });
							termRef.current?.focus();
						}}
					>
						{key.label}
					</button>
				))}
			</div>
		</div>
	);
}
