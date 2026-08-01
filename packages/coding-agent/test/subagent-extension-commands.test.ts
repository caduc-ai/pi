import { describe, expect, it, vi } from "vitest";
import subagentExtension from "../examples/extensions/subagent/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;

function setup(options: { isIdle?: boolean } = {}) {
	const commands = new Map<string, { description: string; handler: CommandHandler }>();
	const sendUserMessage = vi.fn<ExtensionAPI["sendUserMessage"]>();
	const notify = vi.fn();

	const api = {
		registerTool: vi.fn(),
		registerCommand(name: string, command: { description: string; handler: CommandHandler }) {
			commands.set(name, command);
		},
		sendUserMessage,
	} as unknown as ExtensionAPI;

	subagentExtension(api);

	const ctx = {
		hasUI: true,
		ui: { notify },
		isIdle: () => options.isIdle ?? true,
		cwd: "/tmp",
	} as unknown as ExtensionContext;

	async function runCommand(name: string, args: string): Promise<void> {
		const command = commands.get(name);
		if (!command) throw new Error(`Missing command: ${name}`);
		await command.handler(args, ctx);
	}

	return { commands, ctx, notify, runCommand, sendUserMessage };
}

describe("subagent example extension workflow commands", () => {
	it("registers the subagent tool and the three workflow commands", () => {
		const { commands } = setup();
		expect(commands.has("implement")).toBe(true);
		expect(commands.has("scout-and-plan")).toBe(true);
		expect(commands.has("implement-and-review")).toBe(true);
		expect(commands.get("implement")?.description).toContain("scout");
	});

	it("/implement sends a chained scout -> planner -> worker workflow with the query", async () => {
		const { runCommand, sendUserMessage } = setup();
		await runCommand("implement", "add caching to the store");
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		const message = String(sendUserMessage.mock.calls[0]?.[0]);
		expect(message).toContain('"scout" agent to find all code relevant to: add caching to the store');
		expect(message).toContain('"planner" agent to create an implementation plan');
		expect(message).toContain('"worker" agent to implement the plan');
	});

	it("/scout-and-plan does not implement", async () => {
		const { runCommand, sendUserMessage } = setup();
		await runCommand("scout-and-plan", "refactor auth to OAuth");
		const message = String(sendUserMessage.mock.calls[0]?.[0]);
		expect(message).toContain('"scout" agent to find all code relevant to: refactor auth to OAuth');
		expect(message).toContain('"planner" agent to create an implementation plan');
		expect(message).toContain("Do NOT implement");
	});

	it("/implement-and-review chains worker -> reviewer -> worker", async () => {
		const { runCommand, sendUserMessage } = setup();
		await runCommand("implement-and-review", "add input validation");
		const message = String(sendUserMessage.mock.calls[0]?.[0]);
		expect(message).toContain('"worker" agent to implement: add input validation');
		expect(message).toContain('"reviewer" agent to review the implementation');
		expect(message).toContain('"worker" agent to apply the feedback');
	});

	it("notifies usage when no query is given", async () => {
		const { notify, runCommand, sendUserMessage } = setup();
		await runCommand("implement", "  ");
		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Usage: /implement <query>", "warning");
	});

	it("steers when the agent is streaming", async () => {
		const { runCommand, sendUserMessage } = setup({ isIdle: false });
		await runCommand("implement", "fix the bug");
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("fix the bug"), {
			deliverAs: "steer",
		});
	});
});
