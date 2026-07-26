/**
 * Process-level owner of the persistent web terminal.
 *
 * The terminal is scoped to the pi process run, not to an AgentSession: it
 * survives web clients attaching and detaching, and survives session switches
 * (RpcBridge.rebindSession re-points the bridge at a new session; the terminal
 * is deliberately outside that graph). It is killed on graceful shutdown.
 */

import { findTmux, runTmux } from "./tmux-cli.ts";
import { TmuxTerminal, type TmuxTerminalOptions } from "./tmux-terminal.ts";

let current: TmuxTerminal | undefined;
let creating: Promise<TmuxTerminal> | undefined;

/**
 * Get the process terminal, creating it on first use.
 *
 * Concurrent callers share one creation attempt, so two clients opening the
 * terminal at the same moment cannot produce two tmux sessions.
 */
export function getOrCreateTerminal(options: TmuxTerminalOptions): Promise<TmuxTerminal> {
	if (current?.isAlive) return Promise.resolve(current);
	// A dead terminal (user ran `exit`, tmux server killed) is replaced.
	if (current && !current.isAlive) current = undefined;
	if (creating) return creating;

	creating = TmuxTerminal.create(options)
		.then((terminal) => {
			current = terminal;
			creating = undefined;
			return terminal;
		})
		.catch((error: unknown) => {
			creating = undefined;
			throw error;
		});
	return creating;
}

/** The live terminal, if one exists. Does not create. */
export function getExistingTerminal(): TmuxTerminal | undefined {
	return current?.isAlive ? current : undefined;
}

/** Kill the process terminal. Safe to call when none exists. */
export async function disposeTerminal(): Promise<void> {
	const terminal = current;
	current = undefined;
	creating = undefined;
	await terminal?.dispose();
}

/**
 * Kill `pi-<pid>-*` tmux sessions whose owning pi process is gone.
 *
 * Backstop for crashes: graceful shutdown disposes its own session, but a
 * SIGKILLed pi would otherwise leak one tmux session per run.
 */
export async function reapStaleTerminals(): Promise<number> {
	const tmuxPath = findTmux();
	if (!tmuxPath) return 0;

	const { stdout, exitCode } = await runTmux(tmuxPath, ["list-sessions", "-F", "#{session_name}"]);
	// No server running is the common case, not an error.
	if (exitCode !== 0) return 0;

	let reaped = 0;
	for (const name of stdout.split("\n")) {
		const trimmed = name.trim();
		const match = /^pi-(\d+)-[0-9a-f]+$/.exec(trimmed);
		if (!match) continue;
		const pid = Number.parseInt(match[1], 10);
		if (pid === process.pid) continue;
		if (isProcessAlive(pid)) continue;
		await runTmux(tmuxPath, ["kill-session", "-t", trimmed]);
		reaped++;
	}
	return reaped;
}

function isProcessAlive(pid: number): boolean {
	try {
		// Signal 0 checks for existence without delivering a signal.
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		// EPERM means the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
