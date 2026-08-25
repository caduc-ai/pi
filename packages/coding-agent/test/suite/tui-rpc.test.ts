import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { findTmux } from "../../src/core/terminal/tmux-cli.ts";
import { RpcBridge, type RpcClientConnection } from "../../src/modes/rpc/rpc-bridge.ts";
import { createHarness, type Harness } from "./harness.ts";

const tmuxPath = findTmux();
const describeTmux = tmuxPath ? describe : describe.skip;

interface TestClient {
	connection: RpcClientConnection;
	messages: Array<Record<string, unknown>>;
	responseFor(command: string): Record<string, unknown> | undefined;
}

function createTestClient(): TestClient {
	const messages: Array<Record<string, unknown>> = [];
	return {
		connection: {
			send: (message) => {
				messages.push(message as Record<string, unknown>);
			},
		},
		messages,
		responseFor: (command) =>
			messages.filter((m) => m.type === "response" && m.command === command).at(-1) as
				| Record<string, unknown>
				| undefined,
	};
}

describe("tui_* over RPC", () => {
	const harnesses: Harness[] = [];
	const bridges: RpcBridge[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		while (bridges.length > 0) {
			await bridges.pop()?.dispose();
		}
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	function createSessionDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-tui-rpc-"));
		tempDirs.push(dir);
		return dir;
	}

	it("rejects tui_open when the session has no session file", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const runtimeHost = { session: harness.session, setRebindSession: () => {} } as unknown as AgentSessionRuntime;
		const bridge = new RpcBridge(runtimeHost, {}, { bindExtensions: false });
		bridges.push(bridge);
		await bridge.start();
		const client = createTestClient();
		const handle = bridge.attachClient(client.connection);

		await handle.receive(JSON.stringify({ id: "1", type: "tui_open" }));

		const response = client.responseFor("tui_open");
		expect(response?.success).toBe(false);
		expect(response?.error).toContain("no session file");
	});

	describeTmux("with a persisted session and a stand-in TUI process (requires tmux)", () => {
		async function setup(): Promise<{
			bridge: RpcBridge;
			client: TestClient;
			receive: (command: object) => Promise<void>;
			switchSessionCalls: string[];
			sessionFile: string;
		}> {
			const cwd = createSessionDir();
			const sessionDir = join(cwd, "sessions");
			mkdirSync(sessionDir, { recursive: true });
			const sessionManager = SessionManager.create(cwd, sessionDir);
			const harness = await createHarness({ sessionManager });
			harnesses.push(harness);
			const sessionFile = harness.session.sessionFile;
			if (!sessionFile) throw new Error("expected a file-backed session for this test");

			const switchSessionCalls: string[] = [];
			const runtimeHost = {
				session: harness.session,
				setRebindSession: () => {},
				switchSession: async (path: string) => {
					switchSessionCalls.push(path);
					return { cancelled: false };
				},
			} as unknown as AgentSessionRuntime;

			// A long-lived stand-in for the real pi TUI process: this test only
			// exercises the RPC guard and cleanup around tui_open/close, not an
			// actual interactive pi session (which would need a real model/provider).
			const bridge = new RpcBridge(
				runtimeHost,
				{},
				{ bindExtensions: false, resolveTuiCommand: () => ["sleep", "60"] },
			);
			bridges.push(bridge);
			await bridge.start();
			const client = createTestClient();
			const handle = bridge.attachClient(client.connection);
			return {
				bridge,
				client,
				receive: (command: object) => handle.receive(JSON.stringify(command)),
				switchSessionCalls,
				sessionFile,
			};
		}

		it("opens a TUI terminal attached to the session", async () => {
			const { client, receive } = await setup();

			await receive({ id: "1", type: "tui_open", cols: 80, rows: 24 });

			const response = client.responseFor("tui_open");
			expect(response?.success).toBe(true);
			const data = response?.data as { termId: string; cols: number; rows: number };
			expect(data.termId).toMatch(/^pi-\d+-[0-9a-f]+$/);
			expect(data.cols).toBe(80);
			expect(data.rows).toBe(24);
		});

		it("rejects prompt, steer, and follow_up while the TUI is open", async () => {
			const { client, receive } = await setup();
			await receive({ id: "1", type: "tui_open", cols: 80, rows: 24 });

			await receive({ id: "2", type: "prompt", message: "hello" });
			const promptResponse = client.responseFor("prompt");
			expect(promptResponse?.success).toBe(false);
			expect(promptResponse?.error).toBe("TUI is attached to this session");

			await receive({ id: "3", type: "steer", message: "hello" });
			expect(client.responseFor("steer")?.success).toBe(false);

			await receive({ id: "4", type: "follow_up", message: "hello" });
			expect(client.responseFor("follow_up")?.success).toBe(false);
		});

		it("does not block read-only or terminal commands while the TUI is open", async () => {
			const { client, receive } = await setup();
			await receive({ id: "1", type: "tui_open", cols: 80, rows: 24 });

			await receive({ id: "2", type: "get_state" });
			expect(client.responseFor("get_state")?.success).toBe(true);

			await receive({ id: "3", type: "get_messages" });
			expect(client.responseFor("get_messages")?.success).toBe(true);
		});

		it("reloads the session from disk and unblocks writes on tui_close", async () => {
			const { client, receive, switchSessionCalls, sessionFile } = await setup();
			await receive({ id: "1", type: "tui_open", cols: 80, rows: 24 });

			await receive({ id: "2", type: "tui_close" });
			expect(client.responseFor("tui_close")?.success).toBe(true);
			expect(switchSessionCalls).toEqual([sessionFile]);

			await receive({ id: "3", type: "tui_input", data: "AA==" });
			expect(client.responseFor("tui_input")?.success).toBe(false);
		});
	});
});
