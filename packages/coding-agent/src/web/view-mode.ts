/**
 * Read-only session viewer: serves a .jsonl session file to the pi web UI
 * without an agent process (`pi --web --view <file>`). Only read commands are
 * answered; everything else returns an error.
 */

import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import chalk from "chalk";
import type { SessionStats } from "../core/agent-session.ts";
import { buildSessionContext, SessionManager } from "../core/session-manager.ts";
import type { RpcClientConnection, RpcClientHandle } from "../modes/rpc/rpc-bridge.ts";
import type { RpcCommand, RpcResponse, RpcSessionState } from "../modes/rpc/rpc-types.ts";
import { resolvePath } from "../utils/paths.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { startWebServer } from "./web-server.ts";

class SessionViewBridge {
	private readonly sessionPath: string;

	constructor(sessionPath: string) {
		this.sessionPath = sessionPath;
	}

	/** Load entries fresh on each request so external changes to the file show up on reconnect. */
	private load() {
		const sm = SessionManager.open(this.sessionPath);
		const context = buildSessionContext(sm.getEntries(), sm.getLeafId());
		return { header: sm.getHeader(), context };
	}

	attachClient(connection: RpcClientConnection): RpcClientHandle {
		return {
			receive: async (line) => {
				let command: RpcCommand;
				try {
					command = JSON.parse(line) as RpcCommand;
				} catch (parseError: unknown) {
					connection.send({
						type: "response",
						command: "parse",
						success: false,
						error: `Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
					} satisfies RpcResponse);
					return;
				}
				try {
					connection.send(this.handleCommand(command));
				} catch (commandError: unknown) {
					connection.send({
						id: command.id,
						type: "response",
						command: command.type,
						success: false,
						error: commandError instanceof Error ? commandError.message : String(commandError),
					} satisfies RpcResponse);
				}
			},
			detach: () => {},
		};
	}

	private handleCommand(command: RpcCommand): RpcResponse {
		const id = command.id;
		switch (command.type) {
			case "get_state": {
				const { header, context } = this.load();
				const state: RpcSessionState = {
					// Session entries only store provider/modelId, not a full Model
					model: undefined,
					thinkingLevel: context.thinkingLevel as RpcSessionState["thinkingLevel"],
					isStreaming: false,
					isCompacting: false,
					steeringMode: "all",
					followUpMode: "all",
					sessionFile: this.sessionPath,
					sessionId: header?.id ?? "unknown",
					sessionName: undefined,
					autoCompactionEnabled: false,
					messageCount: context.messages.length,
					pendingMessageCount: 0,
				};
				return { id, type: "response", command: command.type, success: true, data: state } as RpcResponse;
			}

			case "get_messages": {
				const { context } = this.load();
				return {
					id,
					type: "response",
					command: command.type,
					success: true,
					data: { messages: context.messages },
				} as RpcResponse;
			}

			case "get_commands":
				return {
					id,
					type: "response",
					command: command.type,
					success: true,
					data: { commands: [] },
				} as RpcResponse;

			case "get_session_stats": {
				const { header, context } = this.load();
				return {
					id,
					type: "response",
					command: command.type,
					success: true,
					data: this.computeStats(header?.id ?? "unknown", context.messages),
				} as RpcResponse;
			}

			default:
				return {
					id,
					type: "response",
					command: command.type,
					success: false,
					error: "Read-only session viewer",
				} as RpcResponse;
		}
	}

	private computeStats(sessionId: string, messages: AgentMessage[]): SessionStats {
		const stats: SessionStats = {
			sessionFile: this.sessionPath,
			sessionId,
			userMessages: 0,
			assistantMessages: 0,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: messages.length,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		};
		for (const message of messages) {
			if (message.role === "user") stats.userMessages++;
			if (message.role === "toolResult") stats.toolResults++;
			if (message.role !== "assistant") continue;
			const assistant = message as AssistantMessage;
			stats.assistantMessages++;
			for (const block of assistant.content) {
				if (block.type === "toolCall") stats.toolCalls++;
			}
			if (assistant.stopReason !== "error" && assistant.stopReason !== "aborted") {
				stats.tokens.input += assistant.usage.input;
				stats.tokens.output += assistant.usage.output;
				stats.tokens.cacheRead += assistant.usage.cacheRead;
				stats.tokens.cacheWrite += assistant.usage.cacheWrite;
				stats.tokens.total += assistant.usage.totalTokens;
				stats.cost += assistant.usage.cost.total;
			}
		}
		return stats;
	}
}

export interface WebViewModeOptions {
	/** Interface to bind. Default 127.0.0.1 (localhost only). */
	host?: string;
	/** Port to bind. Default 0 (random free port, printed on startup). */
	port?: number;
}

export async function runWebViewMode(sessionPath: string, options: WebViewModeOptions = {}): Promise<never> {
	const resolved = resolvePath(sessionPath);
	if (!existsSync(resolved)) {
		console.error(chalk.red(`Error: Session file not found: ${resolved}`));
		process.exit(1);
	}

	// Fail fast on unreadable/corrupt session files
	try {
		const sm = SessionManager.open(resolved);
		buildSessionContext(sm.getEntries(), sm.getLeafId());
	} catch (error: unknown) {
		console.error(
			chalk.red(`Error: Failed to read session file: ${error instanceof Error ? error.message : String(error)}`),
		);
		process.exit(1);
	}

	const bridge = new SessionViewBridge(resolved);

	const host = options.host ?? "127.0.0.1";
	const token = crypto.randomBytes(16).toString("base64url");
	const server = await startWebServer({ bridge, host, port: options.port ?? 0, token });

	const displayHost = host === "0.0.0.0" || host === "::" ? "<this-machine>" : host;
	console.log(chalk.bold("pi session viewer") + chalk.dim(` (read-only, ${resolved})`));
	console.log();
	console.log(`  ${chalk.cyan(`http://${displayHost}:${server.port}/?token=${token}`)}`);
	console.log();

	const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
	if (process.platform !== "win32") {
		signals.push("SIGHUP");
	}
	for (const signal of signals) {
		process.on(signal, () => {
			killTrackedDetachedChildren();
			void server.close().then(() => process.exit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143));
		});
	}

	// Keep process alive forever
	return new Promise(() => {});
}
