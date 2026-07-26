import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { findTmux, runTmux } from "../src/core/terminal/tmux-cli.ts";
import { TmuxTerminal } from "../src/core/terminal/tmux-terminal.ts";

const tmuxPath = findTmux();
const describeTmux = tmuxPath ? describe : describe.skip;

/**
 * A terminal plus a transcript that starts recording at creation.
 *
 * Output must be captured from before the first write: subscribing only after
 * writing races the shell and loses output that already arrived.
 */
interface TestTerminal {
	terminal: TmuxTerminal;
	transcript(): string;
}

async function createTerminal(): Promise<TestTerminal> {
	const terminal = await TmuxTerminal.create({
		cwd: tmpdir(),
		shell: "/bin/bash",
		cols: 80,
		rows: 24,
	});
	let text = "";
	terminal.subscribe((data) => {
		text += data.toString("utf8");
	});
	// Let the interactive shell print its first prompt before driving it.
	await new Promise((resolve) => setTimeout(resolve, 600));
	return { terminal, transcript: () => text };
}

/** Poll an already-recording transcript until `predicate` matches or time runs out. */
async function waitFor(
	transcript: () => string,
	predicate: (text: string) => boolean,
	timeoutMs = 10_000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate(transcript())) return transcript();
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return transcript();
}

describeTmux("TmuxTerminal (requires tmux)", () => {
	const terminals: TmuxTerminal[] = [];

	afterEach(async () => {
		while (terminals.length > 0) {
			await terminals.pop()?.dispose();
		}
	});

	it("echoes a command and streams its output", async () => {
		const { terminal, transcript } = await createTerminal();
		terminals.push(terminal);

		await terminal.write(Buffer.from("echo PI_MARKER_A\n", "utf8"));
		expect(await waitFor(transcript, (t) => t.includes("PI_MARKER_A"))).toContain("PI_MARKER_A");
	});

	it("persists cwd across separate writes", async () => {
		const { terminal, transcript } = await createTerminal();
		terminals.push(terminal);

		await terminal.write(Buffer.from("cd /tmp\n", "utf8"));
		await waitFor(transcript, (t) => t.includes("cd /tmp"));
		await terminal.write(Buffer.from("echo CWD_IS:$PWD\n", "utf8"));

		expect(await waitFor(transcript, (t) => t.includes("CWD_IS:/tmp"))).toContain("CWD_IS:/tmp");
	});

	it("persists environment variables across separate writes", async () => {
		const { terminal, transcript } = await createTerminal();
		terminals.push(terminal);

		await terminal.write(Buffer.from("export PI_TEST_VAR=persisted\n", "utf8"));
		await waitFor(transcript, (t) => t.includes("export PI_TEST_VAR"));
		await terminal.write(Buffer.from("echo VAR_IS:$PI_TEST_VAR\n", "utf8"));

		expect(await waitFor(transcript, (t) => t.includes("VAR_IS:persisted"))).toContain("VAR_IS:persisted");
	});

	it("delivers Ctrl-C as SIGINT and keeps the shell usable", async () => {
		const { terminal, transcript } = await createTerminal();
		terminals.push(terminal);

		await terminal.write(Buffer.from("sleep 30\n", "utf8"));
		await waitFor(transcript, (t) => t.includes("sleep 30"));
		// 0x03 is Ctrl-C; the shell must survive it and accept the next command.
		await terminal.write(Buffer.from([0x03]));
		await waitFor(transcript, (t) => t.includes("^C"));
		await terminal.write(Buffer.from("echo AFTER_SIGINT\n", "utf8"));

		expect(await waitFor(transcript, (t) => t.includes("AFTER_SIGINT"))).toContain("AFTER_SIGINT");
		expect(terminal.isAlive).toBe(true);
	});

	it("passes multi-byte UTF-8 through unmangled", async () => {
		const { terminal, transcript } = await createTerminal();
		terminals.push(terminal);

		await terminal.write(Buffer.from("echo 'héllo ☃'\n", "utf8"));
		expect(await waitFor(transcript, (t) => t.includes("héllo ☃"))).toContain("héllo ☃");
	});

	it("propagates resize to the shell", async () => {
		const { terminal, transcript } = await createTerminal();
		terminals.push(terminal);

		await terminal.resize(120, 40);
		await terminal.write(Buffer.from("stty size\n", "utf8"));

		// stty prints "<rows> <cols>"; matched as a substring because shells emit
		// ANSI sequences directly adjacent to the digits.
		expect(await waitFor(transcript, (t) => t.includes("40 120"))).toContain("40 120");
		expect(terminal.size).toEqual({ cols: 120, rows: 40 });
	});

	it("replays prior output to a late subscriber", async () => {
		const { terminal, transcript } = await createTerminal();
		terminals.push(terminal);

		await terminal.write(Buffer.from("echo REPLAY_MARKER\n", "utf8"));
		await waitFor(transcript, (t) => t.includes("REPLAY_MARKER"));

		// A client attaching now gets scrollback, not an empty screen.
		const replay = await terminal.captureReplay();
		expect(replay).toContain("REPLAY_MARKER");
	});

	it("broadcasts the same bytes to multiple subscribers", async () => {
		const { terminal } = await createTerminal();
		terminals.push(terminal);

		let first = "";
		let second = "";
		terminal.subscribe((d) => {
			first += d.toString("utf8");
		});
		terminal.subscribe((d) => {
			second += d.toString("utf8");
		});

		await terminal.write(Buffer.from("echo BOTH_CLIENTS\n", "utf8"));
		await waitFor(
			() => first,
			() => first.includes("BOTH_CLIENTS") && second.includes("BOTH_CLIENTS"),
		);

		expect(first).toContain("BOTH_CLIENTS");
		expect(second).toBe(first);
	});

	it("preserves write order under concurrent writes", async () => {
		const { terminal, transcript } = await createTerminal();
		terminals.push(terminal);

		// Issued without awaiting: the internal queue must keep byte order.
		await Promise.all([
			terminal.write(Buffer.from("echo ORDER_", "utf8")),
			terminal.write(Buffer.from("ONE_", "utf8")),
			terminal.write(Buffer.from("TWO\n", "utf8")),
		]);

		expect(await waitFor(transcript, (t) => t.includes("ORDER_ONE_TWO"))).toContain("ORDER_ONE_TWO");
	});

	it("kills the tmux session on dispose", async () => {
		const { terminal } = await createTerminal();
		const sessionName = terminal.sessionName;

		const before = await runTmux(tmuxPath as string, ["has-session", "-t", sessionName]);
		expect(before.exitCode).toBe(0);

		await terminal.dispose();
		const after = await runTmux(tmuxPath as string, ["has-session", "-t", sessionName]);
		expect(after.exitCode).not.toBe(0);
	});

	it("keeps the shell alive when a subscriber detaches", async () => {
		const { terminal, transcript } = await createTerminal();
		terminals.push(terminal);

		// Simulates a client detaching: subscribers go away, the shell does not.
		const unsubscribe = terminal.subscribe(() => {});
		await terminal.write(Buffer.from("echo STILL_HERE\n", "utf8"));
		await waitFor(transcript, (t) => t.includes("STILL_HERE"));
		unsubscribe();

		expect(terminal.isAlive).toBe(true);
		await terminal.write(Buffer.from("echo AFTER_DETACH\n", "utf8"));
		expect(await waitFor(transcript, (t) => t.includes("AFTER_DETACH"))).toContain("AFTER_DETACH");
	});
});

describe("TmuxTerminal availability", () => {
	it("reports whether tmux was found", () => {
		// Documents the skip condition rather than silently passing.
		if (!tmuxPath) {
			console.warn("tmux not found; TmuxTerminal integration tests skipped");
		}
		expect(tmuxPath === null || typeof tmuxPath === "string").toBe(true);
	});
});
