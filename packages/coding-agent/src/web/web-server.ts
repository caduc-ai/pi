/**
 * Web server for pi web mode: serves the pi-web static assets over HTTP and the
 * pi RPC protocol (docs/rpc.md) over a WebSocket endpoint, backed by RpcBridge.
 *
 * Auth: a per-run random token. Visiting `/?token=<token>` sets an HttpOnly
 * cookie and redirects to `/`. All other HTTP requests and the WebSocket upgrade
 * require the cookie. TLS termination and network exposure are left to external
 * tooling (e.g. tailscale serve, Caddy).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
import { getCustomThemesDir, getThemesDir, getWebDistDir } from "../config.ts";
import type { RpcBridge } from "../modes/rpc/rpc-bridge.ts";

const COOKIE_NAME = "pi_web_token";
const WS_HIGH_WATER_BYTES = 16 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".map": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ico": "image/x-icon",
};

export interface WebServerOptions {
	bridge: RpcBridge;
	host: string;
	port: number;
	token: string;
	/** Static asset directory. Defaults to the @earendil-works/pi-web dist. */
	staticDir?: string;
}

export interface WebServerHandle {
	host: string;
	port: number;
	close(): Promise<void>;
}

function tokenMatches(provided: string | undefined, token: string): boolean {
	if (!provided) return false;
	const providedBuffer = Buffer.from(provided);
	const tokenBuffer = Buffer.from(token);
	return providedBuffer.length === tokenBuffer.length && crypto.timingSafeEqual(providedBuffer, tokenBuffer);
}

function cookieToken(request: http.IncomingMessage): string | undefined {
	const header = request.headers.cookie;
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const eqIndex = part.indexOf("=");
		if (eqIndex === -1) continue;
		if (part.slice(0, eqIndex).trim() === COOKIE_NAME) {
			return part.slice(eqIndex + 1).trim();
		}
	}
	return undefined;
}

function waitForSocketDrain(ws: WebSocket): Promise<void> {
	if (ws.readyState !== ws.OPEN || ws.bufferedAmount < WS_HIGH_WATER_BYTES) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		const check = () => {
			if (ws.readyState !== ws.OPEN || ws.bufferedAmount < WS_HIGH_WATER_BYTES / 2) {
				resolve();
			} else {
				setTimeout(check, 25);
			}
		};
		check();
	});
}

function sendText(response: http.ServerResponse, statusCode: number, text: string): void {
	response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
	response.end(text);
}

function sendFile(response: http.ServerResponse, filePath: string, immutable: boolean): void {
	const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
	const cacheControl = immutable ? "public, max-age=31536000, immutable" : "no-cache";
	response.writeHead(200, { "content-type": contentType, "cache-control": cacheControl });
	fs.createReadStream(filePath).pipe(response);
}

/** Serve a theme JSON by name from the built-in themes dir, then custom themes dir. */
function resolveThemeFile(name: string): string | undefined {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(name)) return undefined;
	for (const dir of [getThemesDir(), getCustomThemesDir()]) {
		const candidate = path.join(dir, name);
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
			return candidate;
		}
	}
	return undefined;
}

export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
	const { bridge, host, token } = options;
	const staticDir = options.staticDir ?? getWebDistDir();
	const indexPath = path.join(staticDir, "index.html");
	if (!fs.existsSync(indexPath)) {
		throw new Error(
			`Web UI assets not found at ${staticDir}. Build them with: npm run build --workspace=@earendil-works/pi-web`,
		);
	}

	const server = http.createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");

		// Token login: set the auth cookie and redirect to the app
		if (url.pathname === "/" && url.searchParams.has("token")) {
			const provided = url.searchParams.get("token") ?? undefined;
			if (!tokenMatches(provided, token)) {
				sendText(response, 401, "Invalid token\n");
				return;
			}
			response.writeHead(302, {
				location: "/",
				"set-cookie": `${COOKIE_NAME}=${provided}; Path=/; HttpOnly; SameSite=Strict`,
			});
			response.end();
			return;
		}

		if (!tokenMatches(cookieToken(request), token)) {
			sendText(response, 401, "Unauthorized\n");
			return;
		}

		if (request.method !== "GET" && request.method !== "HEAD") {
			sendText(response, 405, "Method not allowed\n");
			return;
		}

		if (url.pathname.startsWith("/theme/")) {
			const themeFile = resolveThemeFile(decodeURIComponent(url.pathname.slice("/theme/".length)));
			if (!themeFile) {
				sendText(response, 404, "Theme not found\n");
				return;
			}
			sendFile(response, themeFile, false);
			return;
		}

		// Static assets with SPA fallback
		const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
		const filePath = path.normalize(path.join(staticDir, relativePath));
		if (!filePath.startsWith(staticDir)) {
			sendText(response, 403, "Forbidden\n");
			return;
		}
		if (relativePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
			sendFile(response, filePath, relativePath.startsWith("assets/"));
			return;
		}
		sendFile(response, indexPath, false);
	});

	const wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname !== "/ws" || !tokenMatches(cookieToken(request), token)) {
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => {
			const client = bridge.attachClient({
				send: (message) => {
					if (ws.readyState === ws.OPEN) {
						ws.send(JSON.stringify(message));
					}
				},
				drain: () => waitForSocketDrain(ws),
			});
			ws.on("message", (data) => {
				void client.receive(data.toString());
			});
			ws.on("close", () => client.detach());
			ws.on("error", () => client.detach());
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, host, () => resolve());
	});

	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : options.port;

	return {
		host,
		port,
		close: () =>
			new Promise<void>((resolve) => {
				for (const client of wss.clients) {
					client.terminate();
				}
				server.close(() => resolve());
			}),
	};
}
