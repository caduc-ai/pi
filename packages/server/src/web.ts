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
 */

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
}

export interface ServerWebHandle {
	host: string;
	port: number;
	close(): Promise<void>;
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
			? "<li>No instances.</li>"
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
		h1 { font-size: 1.2em; margin-bottom: 1em; }
		ul { list-style: none; padding: 0; }
		li { margin: 0.6em 0; }
		a { color: #8abeb7; }
		.meta { color: #666; font-size: 0.85em; margin-left: 0.5em; }
		.spawn-form { margin-top: 2em; padding-top: 1.5em; border-top: 1px solid #333; }
		.spawn-form h2 { font-size: 1em; margin-bottom: 0.5em; }
		.spawn-form label { display: block; margin: 0.4em 0; font-size: 0.9em; color: #999; }
		.spawn-form input, .spawn-form button { font-family: inherit; font-size: 0.9em; background: #1a1a1a; color: #e6e6e6; border: 1px solid #444; padding: 0.4em 0.6em; border-radius: 3px; }
		.spawn-form input { width: 300px; }
		.spawn-form button { cursor: pointer; background: #2a4a3f; border-color: #3a6a5f; margin-top: 0.5em; }
		.spawn-form button:hover { background: #3a6a5f; }
		.spawn-result { margin-top: 0.5em; font-size: 0.9em; }
		.spawn-result.error { color: #e06060; }
		.spawn-result.success { color: #60c060; }
	</style>
</head>
<body>
	<h1>pi server instances</h1>
	<ul>
${items}
	</ul>
	<div class="spawn-form">
		<h2>New session</h2>
		<form method="POST" action="/api/spawn" onsubmit="spawnSession(event)">
			<label>Working directory<br><input type="text" name="cwd" id="spawn-cwd" placeholder="${escapeHtml(process.cwd())}"/></label>
			<label>Label (optional)<br><input type="text" name="label" id="spawn-label" placeholder="My project"/></label>
			<button type="submit">Spawn</button>
		</form>
		<div class="spawn-result" id="spawn-result"></div>
	</div>
	<script>
		async function spawnSession(event) {
			event.preventDefault();
			const resultEl = document.getElementById("spawn-result");
			resultEl.textContent = "Spawning…";
			resultEl.className = "spawn-result";
			try {
				const formData = new FormData(event.target);
				const res = await fetch("/api/spawn", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						cwd: formData.get("cwd") || "",
						label: formData.get("label") || undefined,
					}),
				});
				const data = await res.json();
				if (data.ok && data.instance) {
					resultEl.textContent = "Spawned! Opening…";
					resultEl.className = "spawn-result success";
					window.location.href = "/i/" + data.instance.id + "/";
				} else {
					resultEl.textContent = "Error: " + (data.error || "unknown");
					resultEl.className = "spawn-result error";
				}
			} catch (error) {
				resultEl.textContent = "Error: " + error.message;
				resultEl.className = "spawn-result error";
			}
		}
	</script>
</body>
</html>`;
}

const INSTANCE_PATH_PATTERN = /^\/i\/([0-9a-f-]{36})(\/|$)/;

export async function startServerWeb(options: ServerWebOptions): Promise<ServerWebHandle> {
	const { host } = options;
	const staticDir = getWebDistDir();
	const indexPath = path.join(staticDir, "index.html");
	if (!fs.existsSync(indexPath)) {
		throw new Error(
			`Web UI assets not found at ${staticDir}. Build them with: npm run build --workspace=@earendil-works/pi-web`,
		);
	}

	const server = http.createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");

		// POST /api/spawn — spawn a new instance from the web dashboard
		if (request.method === "POST" && url.pathname === "/api/spawn") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				void (async () => {
					try {
						const parsed = JSON.parse(body) as { cwd?: string; label?: string };
						const cwd = parsed.cwd?.trim() || process.cwd();
						const instance = await supervisor.spawnInstance({ cwd, label: parsed.label });
						response.writeHead(200, { "content-type": "application/json" });
						response.end(
							JSON.stringify({
								ok: true,
								instance: {
									id: instance.id,
									status: instance.status,
									cwd: instance.cwd,
									label: instance.label,
								},
							}),
						);
					} catch (error: unknown) {
						response.writeHead(500, { "content-type": "application/json" });
						response.end(
							JSON.stringify({
								ok: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						);
					}
				})();
			});
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
		if (!isWsPath || !instanceId) {
			socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
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
