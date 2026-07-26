/**
 * Web hosting for supervised instances: serves the pi web UI (static assets
 * from @earendil-works/pi-web) and proxies each instance's RPC protocol over a
 * WebSocket endpoint (same JSON messages as docs/rpc.md, one per frame).
 *
 * Layout:
 * - GET /                     instance index (links to each instance)
 * - GET /i/<id>/              the pi web UI for that instance (SPA)
 * - WS  /i/<id>/ws            RPC protocol stream for that instance
 * - GET /review               cranium code review UI
 * - GET /themes, /theme/*     TUI theme files, shared by all instances
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import { homedir } from "node:os";
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

const CRANIUM_BIN = process.env.PI_CRANIUM_BIN || path.join(homedir(), "dev", "cranium", "dist", "src", "cli.js");

function runCranium(args: string[], input?: string): { ok: true; data: unknown } | { ok: false; error: string } {
	try {
		const stdout = execFileSync(process.execPath, [CRANIUM_BIN, ...args], {
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
			input,
		});
		return parseCraniumOutput(stdout);
	} catch (error) {
		// cranium exits non-zero on errors but writes JSON to stdout
		const stdout = (error as { stdout?: string }).stdout;
		if (stdout) {
			const parsed = parseCraniumOutput(stdout);
			if (!parsed.ok) return parsed;
		}
		const stderr = (error as { stderr?: string }).stderr || String(error);
		return { ok: false, error: stderr };
	}
}

function parseCraniumOutput(stdout: string): { ok: true; data: unknown } | { ok: false; error: string } {
	try {
		const parsed = JSON.parse(stdout);
		if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
			return { ok: false, error: parsed.error };
		}
		return { ok: true, data: parsed };
	} catch {
		return { ok: true, data: stdout };
	}
}

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
	<h1>pi server</h1>
	<p><a href="/review">Code review</a></p>
	<h2 style="font-size:1em;margin-top:1.5em">Sessions</h2>
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

function renderReviewPage(): string {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>pi review</title>
	<style>
		body { font-family: ui-monospace, monospace; background: #0d0d0d; color: #e6e6e6; margin: 2em; }
		h1 { font-size: 1.2em; margin-bottom: 1em; }
		h1 a { color: #8abeb7; text-decoration: none; }
		.panel { background: #141414; border: 1px solid #2a2a2a; border-radius: 4px; padding: 1em; margin-bottom: 1em; }
		.panel h2 { font-size: 1em; margin: 0 0 0.8em 0; color: #999; }
		label { display: block; margin: 0.3em 0; font-size: 0.9em; color: #999; }
		input, button { font-family: inherit; font-size: 0.9em; background: #1a1a1a; color: #e6e6e6; border: 1px solid #444; padding: 0.4em 0.6em; border-radius: 3px; }
		input { width: 200px; }
		button { cursor: pointer; background: #2a4a3f; border-color: #3a6a5f; }
		button:hover { background: #3a6a5f; }
		button.danger { background: #4a2a2a; border-color: #6a3a3a; }
		button.danger:hover { background: #6a3a3a; }
		.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 0.3em 0; }
		.row label { margin: 0; }
		.status { font-size: 0.85em; color: #999; }
		.status .num { color: #e6e6e6; font-weight: bold; }
		.diff-view { background: #0a0a0a; border: 1px solid #2a2a2a; border-radius: 4px; padding: 0; overflow: auto; max-height: 70vh; }
		.diff-view pre { margin: 0; padding: 1em; font-size: 0.85em; line-height: 1.5; white-space: pre-wrap; }
		.add { color: #60c060; }
		.del { color: #e06060; }
		.hdr { color: #8abeb7; }
		.msg { margin-top: 0.5em; font-size: 0.9em; }
		.msg.error { color: #e06060; }
		.msg.success { color: #60c060; }
		.hidden { display: none; }
	</style>
</head>
<body>
	<h1><a href="/">pi</a> / review</h1>

	<div class="panel hidden" id="panel-start">
		<h2>Start review</h2>
		<div class="row">
			<label>Base <input id="start-base" value="main" /></label>
			<label>Head <input id="start-head" value="HEAD" /></label>
			<label>Repo <input id="start-repo" placeholder="(cwd)" /></label>
			<button onclick="startReview()">Start</button>
		</div>
		<div id="start-msg" class="msg"></div>
	</div>

	<div class="panel hidden" id="panel-active">
		<div class="row" style="justify-content:space-between">
			<h2 style="margin:0" id="review-title">Review</h2>
			<div>
				<button onclick="mergeReview()" id="btn-merge">Merge</button>
				<button class="danger" onclick="clearReview()">Clear</button>
			</div>
		</div>
		<div id="review-status" class="status"></div>
		<div id="review-file" class="hidden">
			<div class="row" style="justify-content:space-between; margin-top:0.8em">
				<strong id="file-path"></strong>
				<div>
					<button onclick="markFile()" id="btn-mark">Mark reviewed</button>
					<button onclick="nextFile()">Skip</button>
				</div>
			</div>
			<div class="diff-view"><pre id="diff-content"></pre></div>
		</div>
		<div id="review-empty" class="status hidden">All files reviewed.</div>
		<div id="review-msg" class="msg"></div>
	</div>

	<script>
		const startPanel = document.getElementById("panel-start");
		const activePanel = document.getElementById("panel-active");
		let sessionId = null;
		let currentFile = null;
		let currentFingerprint = null;

		async function api(method, url, body) {
			const opts = { method, headers: body ? { "Content-Type": "application/json" } : {} };
			if (body) opts.body = JSON.stringify(body);
			const res = await fetch(url, opts);
			return res.json();
		}

		async function loadStatus() {
			const data = await api("GET", "/api/review/status");
			if (!data.ok || !data.data) {
				// No active review
				startPanel.classList.remove("hidden");
				activePanel.classList.add("hidden");
				return;
			}
			const r = data.data.result;
			sessionId = r.session.id;
			startPanel.classList.add("hidden");
			activePanel.classList.remove("hidden");

			document.getElementById("review-title").textContent =
				"Review " + r.session.baseRef + ".." + r.session.headRef;
			document.getElementById("review-status").innerHTML =
				"<span class=num>" + r.counts.unreviewed + "</span> unreviewed &middot; " +
				"<span class=num>" + r.counts.reviewed + "</span> reviewed &middot; " +
				"<span class=num>" + r.counts.changedSinceReview + "</span> changed";

			if (r.counts.unreviewed > 0 || r.counts.changedSinceReview > 0) {
				document.getElementById("review-empty").classList.add("hidden");
				await loadNext();
			} else {
				document.getElementById("review-file").classList.add("hidden");
				document.getElementById("review-empty").classList.remove("hidden");
			}
		}

		async function loadNext() {
			const data = await api("POST", "/api/review/next", sessionId ? { session: sessionId } : {});
			if (!data.ok || !data.data || !data.data.result) {
				document.getElementById("review-file").classList.add("hidden");
				document.getElementById("review-empty").classList.remove("hidden");
				return;
			}
			const file = data.data.result;
			currentFile = file.path;
			currentFingerprint = file.currentFingerprint;
			document.getElementById("file-path").textContent = file.path;
			document.getElementById("review-file").classList.remove("hidden");
			document.getElementById("review-empty").classList.add("hidden");

			const diffData = await api("GET",
				"/api/review/diff?path=" + encodeURIComponent(file.path) +
				(sessionId ? "&session=" + sessionId : ""));
			document.getElementById("diff-content").innerHTML =
				highlightDiff((diffData.ok && typeof diffData.data === "string") ? diffData.data : "");
		}

		function highlightDiff(text) {
			return text
				.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
				.replace(/^(\\+.*)$/gm, '<span class="add">$1</span>')
				.replace(/^(-.*)$/gm, '<span class="del">$1</span>')
				.replace(/^(@@.*@@.*)$/gm, '<span class="hdr">$1</span>')
				.replace(/^(diff .*)$/gm, '<span class="hdr">$1</span>')
				.replace(/^(index .*)$/gm, '<span class="hdr">$1</span>')
				.replace(/^(---.*)$/gm, '<span class="hdr">$1</span>')
				.replace(/^(\\+\\+\\+.*)$/gm, '<span class="hdr">$1</span>');
		}

		async function startReview() {
			const base = document.getElementById("start-base").value.trim() || "main";
			const head = document.getElementById("start-head").value.trim() || "HEAD";
			const repo = document.getElementById("start-repo").value.trim();
			const msg = document.getElementById("start-msg");
			msg.textContent = "Starting…"; msg.className = "msg";
			const data = await api("POST", "/api/review/start", { base, head, repo: repo || undefined });
			if (!data.ok) {
				msg.textContent = data.error || "Failed"; msg.className = "msg error";
			} else {
				await loadStatus();
			}
		}

		async function markFile() {
			if (!currentFile) return;
			const msg = document.getElementById("review-msg");
			msg.textContent = "Marking…"; msg.className = "msg";
			const data = await api("POST", "/api/review/mark", {
				path: currentFile,
				session: sessionId,
				expected: currentFingerprint,
			});
			if (!data.ok) {
				msg.textContent = data.error || "Failed"; msg.className = "msg error";
			} else {
				msg.textContent = "";
				await loadNext();
			}
		}

		async function nextFile() {
			document.getElementById("review-msg").textContent = "";
			await loadNext();
		}

		async function mergeReview() {
			const msg = document.getElementById("review-msg");
			msg.textContent = "Merging…"; msg.className = "msg";
			const data = await api("POST", "/api/review/merge", { base: "main", session: sessionId });
			if (!data.ok) {
				msg.textContent = data.error || "Failed"; msg.className = "msg error";
			} else {
				msg.textContent = "Merged."; msg.className = "msg success";
				await loadStatus();
			}
		}

		async function clearReview() {
			await api("POST", "/api/review/clear", sessionId ? { session: sessionId } : {});
			sessionId = null;
			currentFile = null;
			await loadStatus();
		}

		loadStatus();
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
		// Cranium review API
		if (url.pathname === "/api/review/status" && request.method === "GET") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(runCranium(["review", "status", "--json"])));
			return;
		}
		if (url.pathname === "/api/review/start" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				const { base, head, repo } = JSON.parse(body) as { base: string; head: string; repo?: string };
				const args = ["review", "start", "--base", base, "--head", head];
				if (repo) args.push("--repo", repo);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify(runCranium(args)));
			});
			return;
		}
		if (url.pathname === "/api/review/next" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				const { session } = JSON.parse(body || "{}") as { session?: string };
				const args = ["review", "next", "--json"];
				if (session) args.push("--session", session);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify(runCranium(args)));
			});
			return;
		}
		if (url.pathname === "/api/review/diff" && request.method === "GET") {
			const filePath = url.searchParams.get("path");
			const session = url.searchParams.get("session");
			if (!filePath) {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ ok: false, error: "Missing path parameter" }));
				return;
			}
			const args = ["review", "diff", filePath];
			if (session) args.push("--session", session);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(runCranium(args)));
			return;
		}
		if (url.pathname === "/api/review/mark" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				const {
					path: filePath,
					session,
					expected,
				} = JSON.parse(body) as {
					path: string;
					session?: string;
					expected?: string;
				};
				const args = ["review", "mark", filePath];
				if (expected) args.push("--expected", expected);
				if (session) args.push("--session", session);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify(runCranium(args)));
			});
			return;
		}
		if (url.pathname === "/api/review/clear" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				const { session } = JSON.parse(body || "{}") as { session?: string };
				const args = ["review", "clear", "--yes"];
				if (session) args.push("--session", session);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify(runCranium(args)));
			});
			return;
		}
		if (url.pathname === "/api/review/merge" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				const { base, session } = JSON.parse(body) as { base: string; session?: string };
				const args = ["review", "merge", "--base", base, "--yes"];
				if (session) args.push("--session", session);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify(runCranium(args)));
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

		if (url.pathname === "/review") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
			response.end(renderReviewPage());
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
