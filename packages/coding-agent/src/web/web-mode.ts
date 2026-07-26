/**
 * Web mode: Headless operation serving the pi web UI.
 *
 * Connects to (or auto-starts) the local pi server and registers the session
 * as an instance. The server's web dashboard then serves the session alongside
 * any other active sessions.
 */

import chalk from "chalk";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { RpcBridge, type RpcClientConnection } from "../modes/rpc/rpc-bridge.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { registerWithServer } from "./server-registration.ts";

export interface WebModeOptions {
	/** Interface passed to the server. Default 127.0.0.1 (localhost only). */
	host?: string;
	/** Port passed to the server. Default 0 (random free port). */
	port?: number;
}

export async function runWebMode(runtimeHost: AgentSessionRuntime, options: WebModeOptions = {}): Promise<never> {
	const host = options.host ?? "127.0.0.1";
	const session = runtimeHost.session;

	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];
	let bridge: RpcBridge | undefined;
	let socket: { destroy(): void } | undefined;

	async function shutdown(exitCode = 0): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		socket?.destroy();
		await bridge?.dispose();
		await runtimeHost.dispose();
		process.exit(exitCode);
	}

	try {
		bridge = new RpcBridge(runtimeHost, {
			onShutdownRequested: () => {
				void shutdown();
			},
		});
		await bridge.start();

		const reg = await registerWithServer({
			cwd: process.cwd(),
			label: undefined,
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
			webHost: options.host,
			webPort: options.port,
		});
		socket = reg.socket;

		// Attach the server as an RPC client
		const connection: RpcClientConnection = {
			send: (message) => {
				if (!reg.socket.destroyed) {
					reg.socket.write(`${JSON.stringify(message)}\n`);
				}
			},
		};
		const clientHandle = bridge.attachClient(connection);

		let buffer = "";
		reg.socket.on("data", (chunk: Buffer | string) => {
			buffer += chunk.toString();
			for (;;) {
				const newlineIndex = buffer.indexOf("\n");
				if (newlineIndex === -1) break;
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (!line) continue;
				void clientHandle.receive(line);
			}
		});
		reg.socket.once("close", () => clientHandle.detach());
		reg.socket.on("error", () => clientHandle.detach());

		const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;

		console.log(chalk.bold("pi web UI"));
		console.log();

		if (reg.webPort !== undefined) {
			const url = `http://${displayHost}:${reg.webPort}/i/${reg.instanceId}/`;
			console.log(`  ${chalk.cyan(url)}`);
		} else {
			console.log(`  Session registered on local server (instance: ${reg.instanceId})`);
		}
		console.log();
		if (host === "127.0.0.1") {
			console.log(chalk.dim("  Use --web-host 0.0.0.0 to allow other devices,"));
			console.log(chalk.dim("  or expose through tailscale serve / a TLS-terminating reverse proxy."));
		} else {
			console.log(chalk.yellow("  Listening on all interfaces without TLS. Anyone with the URL has full"));
			console.log(chalk.yellow("  control of this session. Prefer tailscale serve or a TLS reverse proxy."));
		}
	} catch (error: unknown) {
		console.error(chalk.red(`Failed to start web mode: ${error instanceof Error ? error.message : String(error)}`));
		process.exit(1);
	}

	const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
	if (process.platform !== "win32") {
		signals.push("SIGHUP");
	}
	for (const signal of signals) {
		const handler = () => {
			killTrackedDetachedChildren();
			void shutdown(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
		};
		process.on(signal, handler);
		signalCleanupHandlers.push(() => process.off(signal, handler));
	}

	// Keep process alive forever
	return new Promise(() => {});
}
