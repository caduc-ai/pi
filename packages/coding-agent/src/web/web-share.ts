/**
 * Web sharing for interactive (TUI) sessions.
 *
 * Registers the live session with the local pi server so it appears on the
 * server's web dashboard alongside spawned instances. Session events and RPC
 * commands fan out to all connected web clients through the server.
 *
 * Extension dialogs are multiplexed by the TUI (see interactive-mode.ts) using
 * offerDialog(). The bridge is created in no-bind mode so the TUI keeps owning
 * the extension UI context.
 */

import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import type { RpcClientConnection } from "../modes/rpc/rpc-bridge.ts";
import { RpcBridge } from "../modes/rpc/rpc-bridge.ts";
import type { RpcExtensionUIResponse } from "../modes/rpc/rpc-types.ts";
import type { RegistrationResult } from "./server-registration.ts";
import { registerWithServer } from "./server-registration.ts";

export interface WebShareStartOptions {
	/** Interface to bind. Default 127.0.0.1 (localhost only). */
	host?: string;
	/** Port to bind. Default 0 (random free port). */
	port?: number;
}

export class WebShare {
	private readonly runtimeHost: AgentSessionRuntime;
	private bridge: RpcBridge | undefined;
	private registration: RegistrationResult | undefined;
	private url_: string | undefined;

	constructor(runtimeHost: AgentSessionRuntime) {
		this.runtimeHost = runtimeHost;
	}

	get isRunning(): boolean {
		return this.registration !== undefined;
	}

	get clientCount(): number {
		return this.bridge?.clientCount ?? 0;
	}

	/** URL for accessing this session on the server dashboard. Undefined when not running. */
	get url(): string | undefined {
		return this.url_;
	}

	async start(options: WebShareStartOptions = {}): Promise<void> {
		if (this.registration) return;
		const host = options.host ?? "127.0.0.1";
		const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;

		try {
			this.bridge = new RpcBridge(this.runtimeHost, {}, { bindExtensions: false });
			await this.bridge.start();

			const session = this.runtimeHost.session;
			const reg = await registerWithServer({
				cwd: process.cwd(),
				label: undefined,
				sessionId: session.sessionId,
				sessionFile: session.sessionFile,
				webHost: options.host,
				webPort: options.port,
			});

			// Attach the server socket as an RPC client: commands from the socket
			// go to the bridge, events/responses from the bridge go to the socket.
			const connection: RpcClientConnection = {
				send: (message) => {
					if (!reg.socket.destroyed) {
						reg.socket.write(`${JSON.stringify(message)}\n`);
					}
				},
			};

			const clientHandle = this.bridge.attachClient(connection);

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

			this.registration = reg;

			if (reg.webPort !== undefined) {
				const tokenParam = reg.token ? `?token=${reg.token}` : "";
				this.url_ = `http://${displayHost}:${reg.webPort}/i/${reg.instanceId}/${tokenParam}`;
			}
		} catch (error) {
			await this.bridge?.dispose();
			this.bridge = undefined;
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.registration) {
			this.registration.socket.destroy();
			this.registration = undefined;
		}
		await this.bridge?.dispose();
		this.bridge = undefined;
		this.url_ = undefined;
	}

	/** Re-subscribe to session events after the session was replaced (new/switch/fork). */
	async rebindSession(): Promise<void> {
		if (this.registration) {
			await this.bridge?.rebindSession();
		}
	}

	/** Offer a dialog to all connected web clients. First response wins. */
	offerDialog(request: Record<string, unknown>, onResponse: (response: RpcExtensionUIResponse) => void): string {
		if (!this.bridge) throw new Error("Web sharing is not active");
		return this.bridge.offerDialog(request, onResponse);
	}

	/** Dismiss a dialog on all web clients (e.g. answered in the TUI). */
	dismissDialog(id: string): void {
		this.bridge?.dismissDialog(id);
	}

	/** Broadcast a fire-and-forget extension UI request (notify, setStatus, setWidget, ...). */
	broadcastUiRequest(request: Record<string, unknown>): void {
		this.bridge?.broadcastUiRequest(request);
	}
}
