import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { findTmux } from "../../src/core/terminal/tmux-cli.ts";
import { RpcBridge, type RpcClientConnection } from "../../src/modes/rpc/rpc-bridge.ts";
import { createHarness, type Harness } from "./harness.ts";

const tmuxPath = findTmux();
const describeTmux = tmuxPath ? describe : describe.skip;

interface TestClient {
	connection: RpcClientConnection;
	messages: Array<Record<string, unknown>>;
	/** Concatenated, base64-decoded terminal_output payloads. */
	terminalText(): string;
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
		terminalText: () =>
			messages
				.filter((m) => m.type === "terminal_output")
				.map((m) => Buffer.from(m.data as string, "base64").toString("utf8"))
				.join(""),
	};
}

/**
 * Drive RpcBridge directly with the faux-provider harness: the terminal path
 * needs no model calls, so no provider API is involved.
 */
async function createBridge(harness: Harness): Promise<RpcBridge> {
	const runtimeHost = {
		session: harness.session,
		setRebindSession: () => {},
	} as unknown as AgentSessionRuntime;
	const bridge = new RpcBridge(runtimeHost, {}, { bindExtensions: false });
	await bridge.start();
	return bridge;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describeTmux("terminal over RPC (requires tmux)", () => {
	const harnesses: Harness[] = [];
	const bridges: RpcBridge[] = [];

	afterEach(async () => {
		while (bridges.length > 0) {
			// dispose() also kills the process terminal.
			await bridges.pop()?.dispose();
		}
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function setup(): Promise<{ bridge: RpcBridge; client: TestClient; send: (cmd: object) => Promise<void> }> {
		const harness = await createHarness();
		harnesses.push(harness);
		const bridge = await createBridge(harness);
		bridges.push(bridge);
		const client = createTestClient();
		const handle = bridge.attachClient(client.connection);
		return { bridge, client, send: (cmd) => handle.receive(JSON.stringify(cmd)) };
	}

	function responseFor(client: TestClient, command: string): Record<string, unknown> | undefined {
		return client.messages.find((m) => m.type === "response" && m.command === command);
	}

	it("opens a terminal and reports its size", async () => {
		const { client, send } = await setup();

		await send({ id: "1", type: "terminal_open", cols: 100, rows: 30 });
		const response = responseFor(client, "terminal_open");
		expect(response?.success).toBe(true);
		const data = response?.data as { termId: string; cols: number; rows: number; replay: string };
		expect(data.termId).toMatch(/^pi-\d+-[0-9a-f]+$/);
		expect(data.cols).toBe(100);
		expect(data.rows).toBe(30);
		expect(typeof data.replay).toBe("string");
	});

	it("streams command output back as terminal_output events", async () => {
		const { client, send } = await setup();
		await send({ id: "1", type: "terminal_open", cols: 80, rows: 24 });

		const input = Buffer.from("echo RPC_MARKER\n", "utf8").toString("base64");
		await send({ id: "2", type: "terminal_input", data: input });

		await waitFor(() => client.terminalText().includes("RPC_MARKER"));
		expect(client.terminalText()).toContain("RPC_MARKER");
	});

	it("keeps cwd across separate terminal_input commands", async () => {
		const { client, send } = await setup();
		await send({ id: "1", type: "terminal_open", cols: 80, rows: 24 });

		await send({ id: "2", type: "terminal_input", data: Buffer.from("cd /tmp\n").toString("base64") });
		await waitFor(() => client.terminalText().includes("cd /tmp"));
		await send({ id: "3", type: "terminal_input", data: Buffer.from("echo AT:$PWD\n").toString("base64") });

		await waitFor(() => client.terminalText().includes("AT:/tmp"));
		expect(client.terminalText()).toContain("AT:/tmp");
	});

	it("does not put terminal output into session history or the model context", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const bridge = await createBridge(harness);
		bridges.push(bridge);
		const client = createTestClient();
		const handle = bridge.attachClient(client.connection);

		await handle.receive(JSON.stringify({ id: "1", type: "terminal_open", cols: 80, rows: 24 }));
		await handle.receive(
			JSON.stringify({
				id: "2",
				type: "terminal_input",
				data: Buffer.from("echo SHOULD_NOT_BE_IN_CONTEXT\n").toString("base64"),
			}),
		);
		await waitFor(() => client.terminalText().includes("SHOULD_NOT_BE_IN_CONTEXT"));

		// This is the core separation from the agent bash tool.
		expect(harness.session.messages.some((m) => m.role === "bashExecution")).toBe(false);
		const serialized = JSON.stringify(harness.session.messages);
		expect(serialized).not.toContain("SHOULD_NOT_BE_IN_CONTEXT");
		expect(harness.sessionManager.getEntries().some((e) => e.type === "message")).toBe(false);
	});

	it("broadcasts output to every attached client", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const bridge = await createBridge(harness);
		bridges.push(bridge);

		const first = createTestClient();
		const second = createTestClient();
		const handleFirst = bridge.attachClient(first.connection);
		bridge.attachClient(second.connection);

		await handleFirst.receive(JSON.stringify({ id: "1", type: "terminal_open", cols: 80, rows: 24 }));
		await handleFirst.receive(
			JSON.stringify({ id: "2", type: "terminal_input", data: Buffer.from("echo SHARED\n").toString("base64") }),
		);

		await waitFor(() => first.terminalText().includes("SHARED") && second.terminalText().includes("SHARED"));
		expect(first.terminalText()).toContain("SHARED");
		expect(second.terminalText()).toContain("SHARED");
	});

	it("replays earlier output to a client that opens later", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const bridge = await createBridge(harness);
		bridges.push(bridge);

		const first = createTestClient();
		const handleFirst = bridge.attachClient(first.connection);
		await handleFirst.receive(JSON.stringify({ id: "1", type: "terminal_open", cols: 80, rows: 24 }));
		await handleFirst.receive(
			JSON.stringify({ id: "2", type: "terminal_input", data: Buffer.from("echo EARLIER\n").toString("base64") }),
		);
		await waitFor(() => first.terminalText().includes("EARLIER"));

		// A phone reconnecting mid-session must not see a blank screen.
		const late = createTestClient();
		const handleLate = bridge.attachClient(late.connection);
		await handleLate.receive(JSON.stringify({ id: "3", type: "terminal_open", cols: 80, rows: 24 }));

		const response = responseFor(late, "terminal_open");
		const data = response?.data as { replay: string };
		expect(Buffer.from(data.replay, "base64").toString("utf8")).toContain("EARLIER");
	});

	it("reuses one terminal across repeated opens", async () => {
		const { client, send } = await setup();
		await send({ id: "1", type: "terminal_open", cols: 80, rows: 24 });
		const firstId = (responseFor(client, "terminal_open")?.data as { termId: string }).termId;

		client.messages.length = 0;
		await send({ id: "2", type: "terminal_open", cols: 80, rows: 24 });
		const secondId = (responseFor(client, "terminal_open")?.data as { termId: string }).termId;

		expect(secondId).toBe(firstId);
	});

	it("applies terminal_resize", async () => {
		const { client, send } = await setup();
		await send({ id: "1", type: "terminal_open", cols: 80, rows: 24 });
		await send({ id: "2", type: "terminal_resize", cols: 132, rows: 43 });
		expect(responseFor(client, "terminal_resize")?.success).toBe(true);

		await send({ id: "3", type: "terminal_input", data: Buffer.from("stty size\n").toString("base64") });
		// stty prints "<rows> <cols>"; \b would not match here because the shell
		// emits ANSI sequences directly adjacent to the digits.
		await waitFor(() => client.terminalText().includes("43 132"));
		expect(client.terminalText()).toContain("43 132");
	});

	it("rejects input and resize when no terminal is open", async () => {
		const { client, send } = await setup();

		await send({ id: "1", type: "terminal_input", data: Buffer.from("echo nope\n").toString("base64") });
		const inputResponse = responseFor(client, "terminal_input");
		expect(inputResponse?.success).toBe(false);
		expect(inputResponse?.error).toBe("No terminal is open");

		await send({ id: "2", type: "terminal_resize", cols: 80, rows: 24 });
		expect(responseFor(client, "terminal_resize")?.success).toBe(false);
	});

	it("closes the terminal on terminal_close", async () => {
		const { client, send } = await setup();
		await send({ id: "1", type: "terminal_open", cols: 80, rows: 24 });
		await send({ id: "2", type: "terminal_close" });
		expect(responseFor(client, "terminal_close")?.success).toBe(true);

		// Input after close is refused until reopened.
		await send({ id: "3", type: "terminal_input", data: Buffer.from("echo x\n").toString("base64") });
		expect(responseFor(client, "terminal_input")?.success).toBe(false);
	});

	it("survives a client detaching and reattaching", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const bridge = await createBridge(harness);
		bridges.push(bridge);

		const first = createTestClient();
		const handleFirst = bridge.attachClient(first.connection);
		await handleFirst.receive(JSON.stringify({ id: "1", type: "terminal_open", cols: 80, rows: 24 }));
		await handleFirst.receive(
			JSON.stringify({ id: "2", type: "terminal_input", data: Buffer.from("export KEPT=yes\n").toString("base64") }),
		);
		await waitFor(() => first.terminalText().includes("export KEPT=yes"));

		// The client goes away; the shell and its state must not.
		handleFirst.detach();

		const second = createTestClient();
		const handleSecond = bridge.attachClient(second.connection);
		await handleSecond.receive(JSON.stringify({ id: "3", type: "terminal_open", cols: 80, rows: 24 }));
		await handleSecond.receive(
			JSON.stringify({
				id: "4",
				type: "terminal_input",
				data: Buffer.from("echo KEPT_IS:$KEPT\n").toString("base64"),
			}),
		);

		await waitFor(() => second.terminalText().includes("KEPT_IS:yes"));
		expect(second.terminalText()).toContain("KEPT_IS:yes");
	});
});
