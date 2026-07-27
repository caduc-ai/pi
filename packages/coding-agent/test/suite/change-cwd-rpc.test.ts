import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { RpcBridge, type RpcClientConnection } from "../../src/modes/rpc/rpc-bridge.ts";
import type { RpcSessionState } from "../../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "./harness.ts";

interface TestClient {
	connection: RpcClientConnection;
	messages: Array<Record<string, unknown>>;
	/** Last response for a command verb, or undefined when none arrived. */
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

/**
 * Drive RpcBridge directly against a stub runtime host. changeCwd is stubbed so
 * the test covers the RPC surface (command routing, error mapping, state shape)
 * without rebuilding a full cwd-bound runtime.
 */
async function createBridge(
	harness: Harness,
	changeCwd?: AgentSessionRuntime["changeCwd"],
): Promise<{ bridge: RpcBridge; client: TestClient; receive: (command: object) => Promise<void> }> {
	const runtimeHost = {
		session: harness.session,
		setRebindSession: () => {},
		changeCwd,
	} as unknown as AgentSessionRuntime;
	const bridge = new RpcBridge(runtimeHost, {}, { bindExtensions: false });
	await bridge.start();
	const client = createTestClient();
	const handle = bridge.attachClient(client.connection);
	return {
		bridge,
		client,
		receive: (command: object) => handle.receive(JSON.stringify(command)),
	};
}

describe("change_cwd over RPC", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	function createTempDir(): string {
		const dir = join(tmpdir(), `pi-rpc-cd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	it("reports the session working location in get_state", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { receive, client } = await createBridge(harness);

		await receive({ type: "get_state" });

		const response = client.responseFor("get_state");
		expect(response?.success).toBe(true);
		const state = response?.data as RpcSessionState;
		expect(realpathSync(state.cwd)).toBe(realpathSync(harness.sessionManager.getCwd()));
	});

	it("routes change_cwd to the runtime and returns the new location", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const targetDir = createTempDir();
		const calls: string[] = [];
		const { receive, client } = await createBridge(harness, (async (cwd: string) => {
			calls.push(cwd);
			return { cancelled: false, cwd };
		}) as AgentSessionRuntime["changeCwd"]);

		await receive({ type: "change_cwd", cwd: targetDir });

		expect(calls).toEqual([targetDir]);
		const response = client.responseFor("change_cwd");
		expect(response?.success).toBe(true);
		expect(response?.data).toEqual({ cancelled: false, cwd: targetDir });
	});

	it("returns an error response when the working location is rejected", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { receive, client } = await createBridge(harness, (async () => {
			throw new Error("Cannot change working location to /nope: path does not exist");
		}) as AgentSessionRuntime["changeCwd"]);

		await receive({ type: "change_cwd", cwd: "/nope" });

		const response = client.responseFor("change_cwd");
		expect(response?.success).toBe(false);
		expect(response?.error).toContain("path does not exist");
	});

	it("offers cd as a builtin command", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { receive, client } = await createBridge(harness);

		await receive({ type: "get_commands" });

		const response = client.responseFor("get_commands");
		const commands = (response?.data as { commands: Array<{ name: string; source: string }> }).commands;
		expect(commands.some((command) => command.name === "cd" && command.source === "builtin")).toBe(true);
	});

	it("offers gas as a builtin command", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { receive, client } = await createBridge(harness);

		await receive({ type: "get_commands" });

		const response = client.responseFor("get_commands");
		const commands = (response?.data as { commands: Array<{ name: string; source: string }> }).commands;
		expect(commands.some((command) => command.name === "gas" && command.source === "builtin")).toBe(true);
	});
});
