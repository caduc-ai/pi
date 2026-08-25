import type { Signal } from "@preact/signals";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { RpcCommand, TerminalOpenData } from "../protocol.ts";
import { client, dataAs, terminalOpen, terminalOutput, tuiActive, tuiOutput } from "../state.ts";

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
 * The terminal_* and tui_* RPC command families share an identical wire shape
 * (base64 payloads, {termId, cols, rows, replay} on open); this is the only
 * thing that differs between the two xterm-backed views.
 */
interface TerminalCommandFamily {
	open: (cols: number, rows: number) => RpcCommand;
	input: (data: string) => RpcCommand;
	resize: (cols: number, rows: number) => RpcCommand;
	outputSignal: Signal<{ data: string; seq: number } | undefined>;
}

const terminalFamily: TerminalCommandFamily = {
	open: (cols, rows) => ({ type: "terminal_open", cols, rows }),
	input: (data) => ({ type: "terminal_input", data }),
	resize: (cols, rows) => ({ type: "terminal_resize", cols, rows }),
	outputSignal: terminalOutput,
};

const tuiFamily: TerminalCommandFamily = {
	open: (cols, rows) => ({ type: "tui_open", cols, rows }),
	input: (data) => ({ type: "tui_input", data }),
	resize: (cols, rows) => ({ type: "tui_resize", cols, rows }),
	outputSignal: tuiOutput,
};

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

/**
 * Wire an xterm.js instance to a terminal_* or tui_* RPC command family:
 * open on mount, forward keystrokes as input, stream output, and resize on
 * host resize. Shared by TerminalView and TuiView.
 */
function useXtermSession(
	active: boolean,
	hostRef: RefObject<HTMLDivElement | null>,
	termRef: RefObject<XTerm | null>,
	family: TerminalCommandFamily,
): void {
	useEffect(() => {
		if (!active || !hostRef.current) return;

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
			void client.command(family.input(encodeUtf8(data)));
		});

		void (async () => {
			const response = await client.command(family.open(term.cols, term.rows));
			if (disposed) return;
			if (!response.success) {
				term.writeln(`\r\n\x1b[31m${"error" in response ? response.error : "Failed to open"}\x1b[0m`);
				return;
			}
			const data = dataAs<TerminalOpenData>(response, response.command);
			if (data?.replay) {
				term.write(decodeBase64(data.replay));
			}
			term.focus();
		})();

		// Stream server output into xterm.
		const unsubscribeOutput = family.outputSignal.subscribe((chunk) => {
			if (chunk) term.write(decodeBase64(chunk.data));
		});

		const resizeObserver = new ResizeObserver(() => {
			fit.fit();
			void client.command(family.resize(term.cols, term.rows));
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
		// `family` is a stable module-level constant; only `active` should retrigger this.
	}, [active]);
}

function sendMobileKey(command: (data: string) => RpcCommand, bytes: number[]): void {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	void client.command(command(btoa(binary)));
}

function MobileKeyRow({ family, onKey }: { family: TerminalCommandFamily; onKey?: () => void }) {
	return (
		<div class="terminal-keys">
			{MOBILE_KEYS.map((key) => (
				<button
					type="button"
					key={key.label}
					class="terminal-key"
					onClick={() => {
						sendMobileKey(family.input, key.bytes);
						onKey?.();
					}}
				>
					{key.label}
				</button>
			))}
		</div>
	);
}

export function TerminalView() {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const termRef = useRef<XTerm | null>(null);
	const isOpen = terminalOpen.value;

	useXtermSession(isOpen, hostRef, termRef, terminalFamily);

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
			<MobileKeyRow family={terminalFamily} onKey={() => termRef.current?.focus()} />
		</div>
	);
}

/**
 * Fills the chat area with the real pi interactive TUI, in place of
 * ChatList/CommandResultCard/WidgetAreas/Editor. No close button of its own:
 * the header `tui` button (see app.tsx) owns toggling, since closing also
 * needs to send tui_close and resync the chat view.
 */
export function TuiView() {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const termRef = useRef<XTerm | null>(null);
	const isActive = tuiActive.value;

	useXtermSession(isActive, hostRef, termRef, tuiFamily);

	if (!isActive) return null;

	return (
		<div class="tui-view">
			<div class="tui-host" ref={hostRef} />
			<MobileKeyRow family={tuiFamily} onKey={() => termRef.current?.focus()} />
		</div>
	);
}
