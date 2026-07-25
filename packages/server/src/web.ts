/**
 * Web hosting for supervised instances: serves the pi web UI (static assets
 * from @earendil-works/pi-web) and proxies each instance's RPC protocol over a
 * WebSocket endpoint (same JSON messages as docs/rpc.md, one per frame).
 *
 * Layout:
 * - GET /                     instance index (links to each instance)
 * - GET /i/<id>/              the pi web UI for that instance (SPA)
 * - WS  /i/<id>/ws            RPC protocol stream for that instance
 * - GET /themes, /theme/*     TUI theme files, shared by all instances
 *
 * Auth: a per-run random token. Visiting /?token=<token> sets an HttpOnly
 * cookie; all other HTTP requests and WebSocket upgrades require it.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import {
	getCustomThemesDir,
	getThemesDir,
	getWebDistDir,
	type RpcCommand,
	type RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";
import { WebSocketServer } from "ws";
import { supervisor } from "./supervisor.ts";

const COOKIE_NAME = "pi_server_token";

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
	".woff2": "font/woff2",
	".ico": "image/x-icon",
};

export interface ServerWebOptions {
	host: string;
	port: number;
	token: string;
}

export interface ServerWebHandle {
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

function listThemeNames(): string[] {
	const names = new Set<string>();
	for (const dir of [getThemesDir(), getCustomThemesDir()]) {
		try {
			for (const file of fs.readdirSync(dir)) {
				if (file.endsWith(".json") && !file.startsWith("theme-schema")) {
					names.add(file.slice(0, -".json".length));
				}
			}
		} catch {
			// dir does not exist
		}
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

function resolveThemeFile(name: string): string | undefined {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) return undefined;
	// Built-in themes take precedence on name conflicts, matching the TUI
	for (const dir of [getThemesDir(), getCustomThemesDir()]) {
		const candidate = path.join(dir, `${name}.json`);
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
			return candidate;
		}
	}
	return undefined;
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderIndexPage(): string {
	const instances = supervisor.listLiveInstances();
	const items =
		instances.length === 0
			? "<li>No running instances. Spawn one with: server spawn --cwd /path/to/project</li>"
			: instances
					.map(
						(instance) =>
							`<li><a href="/i/${escapeHtml(instance.id)}/">${escapeHtml(instance.label ?? instance.cwd)}</a> ` +
							`<span class="meta">${escapeHtml(instance.status)} · ${escapeHtml(instance.cwd)}</span></li>`,
					)
					.join("\n");
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>pi server</title>
	<style>
		body { font-family: ui-monospace, monospace; background: #0d0d0d; color: #e6e6e6; margin: 2em; }
		h1 { font-size: 1.2em; }
		ul { list-style: none; padding: 0; }
		li { margin: 0.6em 0; }
		a { color: #8abeb7; }
		.meta { color: #666; font-size: 0.85em; margin-left: 0.5em; }
	</style>
</head>
<body>
	<h1>pi server instances</h1>
	<ul>
${items}
	</ul>
</body>
</html>`;
}

const INSTANCE_PATH_PATTERN = /^\/i\/([0-9a-f-]{36})(\/|$)/;

export async function startServerWeb(options: ServerWebOptions): Promise<ServerWebHandle> {
	const { host, token } = options;
	const staticDir = getWebDistDir();
	const indexPath = path.join(staticDir, "index.html");
	if (!fs.existsSync(indexPath)) {
		throw new Error(
			`Web UI assets not found at ${staticDir}. Build them with: npm run build --workspace=@earendil-works/pi-web`,
		);
	}

	const server = http.createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");

		// Token login: set the auth cookie and redirect
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

		if (url.pathname === "/") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
			response.end(renderIndexPage());
			return;
		}

		if (url.pathname === "/themes") {
			response.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
			response.end(JSON.stringify({ themes: listThemeNames() }));
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

		// Instance SPA paths fall through to index.html; static assets are global
		const instanceMatch = INSTANCE_PATH_PATTERN.exec(url.pathname);
		const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
		const filePath = path.normalize(path.join(staticDir, relativePath));
		if (!filePath.startsWith(staticDir)) {
			sendText(response, 403, "Forbidden\n");
			return;
		}
		if (!instanceMatch && relativePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
			sendFile(response, filePath, relativePath.startsWith("assets/"));
			return;
		}
		if (instanceMatch && !supervisor.getLiveInstance(instanceMatch[1])) {
			sendText(response, 404, "Unknown instance\n");
			return;
		}
		sendFile(response, indexPath, false);
	});

	const wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		const instanceMatch = INSTANCE_PATH_PATTERN.exec(url.pathname);
		const instanceId = instanceMatch?.[1];
		const isWsPath = instanceMatch !== null && url.pathname === `/i/${instanceId}/ws`;
		if (!isWsPath || !instanceId || !tokenMatches(cookieToken(request), token)) {
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => {
			const stream = supervisor.openRpcStream(
				instanceId,
				(event) => {
					if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
				},
				(message) => {
					if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
				},
			);
			if (!stream) {
				ws.close(4404, "Unknown instance");
				return;
			}
			ws.on("message", (data) => {
				void (async () => {
					try {
						const parsed = JSON.parse(data.toString()) as RpcCommand | RpcExtensionUIResponse;
						if (parsed.type === "extension_ui_response") {
							stream.handleUiResponse(parsed as RpcExtensionUIResponse);
							return;
						}
						const response = await stream.handleRpc(parsed as RpcCommand);
						if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(response));
					} catch (error: unknown) {
						if (ws.readyState === ws.OPEN) {
							ws.send(
								JSON.stringify({
									type: "response",
									command: "parse",
									success: false,
									error: error instanceof Error ? error.message : String(error),
								}),
							);
						}
					}
				})();
			});
			ws.on("close", () => stream.close());
			ws.on("error", () => stream.close());
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
