/**
 * Web mode: Headless operation serving the pi web UI.
 *
 * Starts an HTTP + WebSocket server attached to the session via RpcBridge and
 * prints a URL containing a per-run auth token. The web UI speaks the exact pi
 * RPC protocol (docs/rpc.md) over WebSocket, one JSON message per frame.
 */

import * as crypto from "node:crypto";
import chalk from "chalk";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { RpcBridge } from "../modes/rpc/rpc-bridge.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { startWebServer } from "./web-server.ts";

export interface WebModeOptions {
	/** Interface to bind. Default 127.0.0.1 (localhost only). */
	host?: string;
	/** Port to bind. Default 0 (random free port, printed on startup). */
	port?: number;
}

export async function runWebMode(runtimeHost: AgentSessionRuntime, options: WebModeOptions = {}): Promise<never> {
	const host = options.host ?? "127.0.0.1";
	const token = crypto.randomBytes(16).toString("base64url");

	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];

	async function shutdown(exitCode = 0): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await server.close();
		await bridge.dispose();
		await runtimeHost.dispose();
		process.exit(exitCode);
	}

	const bridge = new RpcBridge(runtimeHost, {
		onShutdownRequested: () => {
			void shutdown();
		},
	});
	await bridge.start();

	const server = await startWebServer({ bridge, host, port: options.port ?? 0, token });

	const displayHost = host === "0.0.0.0" || host === "::" ? "<this-machine>" : host;
	console.log(chalk.bold("pi web UI"));
	console.log();
	console.log(`  ${chalk.cyan(`http://${displayHost}:${server.port}/?token=${token}`)}`);
	console.log();
	if (host === "127.0.0.1") {
		console.log(chalk.dim("  Listening on localhost only. Use --web-host 0.0.0.0 to allow other devices,"));
		console.log(chalk.dim("  or expose it through tailscale serve / a TLS-terminating reverse proxy."));
	} else {
		console.log(chalk.yellow("  Listening on all interfaces without TLS. Anyone with the URL has full"));
		console.log(chalk.yellow("  control of this session. Prefer tailscale serve or a TLS reverse proxy."));
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
