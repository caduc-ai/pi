/**
 * Web sharing for interactive (TUI) sessions.
 *
 * Attaches a web server to the live session via RpcBridge in no-bind mode: the
 * TUI keeps owning the extension UI context, while session events and RPC
 * commands fan out to all connected web clients. Extension dialogs are
 * multiplexed by the TUI (see interactive-mode.ts) using offerDialog().
 */

import * as crypto from "node:crypto";
import * as os from "node:os";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { RpcBridge } from "../modes/rpc/rpc-bridge.ts";
import type { RpcExtensionUIResponse } from "../modes/rpc/rpc-types.ts";
import { startWebServer, type WebServerHandle } from "./web-server.ts";

export interface WebShareStartOptions {
	/** Interface to bind. Default 127.0.0.1 (localhost only). */
	host?: string;
	/** Port to bind. Default 0 (random free port). */
	port?: number;
}

/** First non-internal IPv4 address, for display URLs when bound to a wildcard host. */
function getLanAddress(): string | undefined {
	for (const addresses of Object.values(os.networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && !address.internal) {
				return address.address;
			}
		}
	}
	return undefined;
}

export class WebShare {
	private readonly runtimeHost: AgentSessionRuntime;
	private bridge: RpcBridge | undefined;
	private server: WebServerHandle | undefined;
	private token = crypto.randomBytes(16).toString("base64url");

	constructor(runtimeHost: AgentSessionRuntime) {
		this.runtimeHost = runtimeHost;
	}

	get isRunning(): boolean {
		return this.server !== undefined;
	}

	get clientCount(): number {
		return this.bridge?.clientCount ?? 0;
	}

	/** URL including the auth token, for display. Undefined when not running. */
	get url(): string | undefined {
		if (!this.server) return undefined;
		let host = this.server.host;
		if (host === "0.0.0.0" || host === "::") {
			host = getLanAddress() ?? "127.0.0.1";
		}
		return `http://${host}:${this.server.port}/?token=${this.token}`;
	}

	async start(options: WebShareStartOptions = {}): Promise<void> {
		if (this.server) return;
		// Fresh token per share session
		this.token = crypto.randomBytes(16).toString("base64url");
		this.bridge = new RpcBridge(this.runtimeHost, {}, { bindExtensions: false });
		await this.bridge.start();
		try {
			this.server = await startWebServer({
				bridge: this.bridge,
				host: options.host ?? "127.0.0.1",
				port: options.port ?? 0,
				token: this.token,
			});
		} catch (error) {
			await this.bridge.dispose();
			this.bridge = undefined;
			throw error;
		}
	}

	async stop(): Promise<void> {
		await this.server?.close();
		this.server = undefined;
		await this.bridge?.dispose();
		this.bridge = undefined;
	}

	/** Re-subscribe to session events after the session was replaced (new/switch/fork). */
	async rebindSession(): Promise<void> {
		if (this.server) {
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
