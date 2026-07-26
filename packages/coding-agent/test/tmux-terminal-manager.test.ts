import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
	disposeTerminal,
	getExistingTerminal,
	getOrCreateTerminal,
	reapStaleTerminals,
} from "../src/core/terminal/terminal-manager.ts";
import { findTmux, runTmux } from "../src/core/terminal/tmux-cli.ts";

const tmuxPath = findTmux();
const describeTmux = tmuxPath ? describe : describe.skip;

describeTmux("terminal manager (requires tmux)", () => {
	afterEach(async () => {
		await disposeTerminal();
	});

	it("creates one terminal and reuses it", async () => {
		const first = await getOrCreateTerminal({ cwd: tmpdir(), shell: "/bin/bash" });
		const second = await getOrCreateTerminal({ cwd: tmpdir(), shell: "/bin/bash" });
		expect(second).toBe(first);
	});

	it("shares a single creation between concurrent callers", async () => {
		// Two clients opening the terminal at once must not create two sessions.
		const [first, second] = await Promise.all([
			getOrCreateTerminal({ cwd: tmpdir(), shell: "/bin/bash" }),
			getOrCreateTerminal({ cwd: tmpdir(), shell: "/bin/bash" }),
		]);
		expect(second).toBe(first);

		const { stdout } = await runTmux(tmuxPath as string, ["list-sessions", "-F", "#{session_name}"]);
		const ours = stdout.split("\n").filter((name) => name.startsWith(`pi-${process.pid}-`));
		expect(ours).toHaveLength(1);
	});

	it("reports no existing terminal before creation and after dispose", async () => {
		expect(getExistingTerminal()).toBeUndefined();
		await getOrCreateTerminal({ cwd: tmpdir(), shell: "/bin/bash" });
		expect(getExistingTerminal()).toBeDefined();
		await disposeTerminal();
		expect(getExistingTerminal()).toBeUndefined();
	});

	it("leaves this process's own session alone when reaping", async () => {
		const terminal = await getOrCreateTerminal({ cwd: tmpdir(), shell: "/bin/bash" });
		await reapStaleTerminals();
		const { exitCode } = await runTmux(tmuxPath as string, ["has-session", "-t", terminal.sessionName]);
		expect(exitCode).toBe(0);
	});

	it("reaps a pi session whose owning process is gone", async () => {
		// PID 999999 is above the default pid_max, so it cannot be alive.
		const stale = "pi-999999-abc123";
		await runTmux(tmuxPath as string, ["new-session", "-d", "-s", stale, "--", "/bin/bash", "-i"]);
		expect((await runTmux(tmuxPath as string, ["has-session", "-t", stale])).exitCode).toBe(0);

		const reaped = await reapStaleTerminals();
		expect(reaped).toBeGreaterThanOrEqual(1);
		expect((await runTmux(tmuxPath as string, ["has-session", "-t", stale])).exitCode).not.toBe(0);
	});

	it("ignores non-pi tmux sessions when reaping", async () => {
		const unrelated = "my-own-work-session";
		await runTmux(tmuxPath as string, ["new-session", "-d", "-s", unrelated, "--", "/bin/bash", "-i"]);
		try {
			await reapStaleTerminals();
			expect((await runTmux(tmuxPath as string, ["has-session", "-t", unrelated])).exitCode).toBe(0);
		} finally {
			await runTmux(tmuxPath as string, ["kill-session", "-t", unrelated]);
		}
	});

	it("replaces a terminal that died", async () => {
		const first = await getOrCreateTerminal({ cwd: tmpdir(), shell: "/bin/bash" });
		// Simulate the user running `exit` or the tmux server being killed.
		await runTmux(tmuxPath as string, ["kill-session", "-t", first.sessionName]);
		await new Promise((resolve) => setTimeout(resolve, 400));

		const second = await getOrCreateTerminal({ cwd: tmpdir(), shell: "/bin/bash" });
		expect(second).not.toBe(first);
		expect(second.isAlive).toBe(true);
	});
});
