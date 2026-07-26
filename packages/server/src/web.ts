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

import { execFileSync, execSync } from "node:child_process";
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
import { SessionManager } from "@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { WebSocketServer } from "ws";
import { supervisor } from "./supervisor.ts";

const CRANIUM_BIN = process.env.PI_CRANIUM_BIN || path.join(homedir(), "dev", "cranium", "dist", "src", "cli.js");

function runCranium(
	args: string[],
	opts?: { input?: string; cwd?: string },
): { ok: true; data: unknown } | { ok: false; error: string } {
	try {
		const stdout = execFileSync(process.execPath, [CRANIUM_BIN, ...args], {
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
			cwd: opts?.cwd,
			input: opts?.input,
		});
		return parseCraniumOutput(stdout);
	} catch (error) {
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
							`<a class="meta" href="/review?cwd=${encodeURIComponent(instance.cwd)}">review</a></li>`,
					)
					.join("\n");
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>pi server</title>
	<style>
		*, *::before, *::after { box-sizing: border-box; }
		body { font-family: ui-monospace, monospace; background: #0d0d0d; color: #e6e6e6; margin: 0; padding: 16px; }
		h1 { font-size: 1.2em; margin-bottom: 1em; }
		h2 { font-size: 1em; }
		a { color: #8abeb7; }
		.nav { margin-bottom: 1.5em; font-size: 0.95em; }
		.nav a { margin-right: 12px; }
		ul { list-style: none; padding: 0; }
		li { margin: 0.6em 0; word-break: break-all; }
		.meta { color: #666; font-size: 0.85em; margin-left: 0.5em; }
		.spawn-form { margin-top: 2em; padding-top: 1.5em; border-top: 1px solid #333; }
		.spawn-form h2 { font-size: 1em; margin-bottom: 0.5em; }
		.spawn-form label { display: block; margin: 0.4em 0; font-size: 0.9em; color: #999; }
		.spawn-form input, .spawn-form button { font-family: inherit; font-size: 15px; background: #1a1a1a; color: #e6e6e6; border: 1px solid #444; padding: 10px 12px; border-radius: 4px; }
		.spawn-form input { width: 100%; max-width: 320px; }
		.spawn-form button { cursor: pointer; background: #2a4a3f; border-color: #3a6a5f; margin-top: 0.8em; min-height: 44px; }
		.spawn-form button:hover { background: #3a6a5f; }
		.spawn-result { margin-top: 0.5em; font-size: 0.9em; }
		.spawn-result.error { color: #e06060; }
		.spawn-result.success { color: #60c060; }
		@media (max-width: 600px) {
			body { padding: 10px; }
			.spawn-form input { max-width: none; }
			.spawn-form button { width: 100%; }
		}
	</style>
</head>
<body>
	<h1>pi</h1>
	<p class="nav"><a href="/review">Code review</a> <a href="/terminal">Terminal</a></p>
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
	<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
	<title>pi review</title>
	<style>
		*, *::before, *::after { box-sizing: border-box; }
		body { font-family: ui-monospace, monospace; background: #0d0d0d; color: #e6e6e6; margin: 0; padding: 16px; }
		header { display: flex; gap: 6px; align-items: center; margin-bottom: 1em; font-size: 13px; color: #999; }
		header a { color: #8abeb7; text-decoration: none; font-weight: 500; }
		header a:hover { color: #a0d8cf; }
		header .sep { color: #555; }
		header .home-btn { display: inline-flex; align-items: center; padding: 4px 6px; border-radius: 4px; color: #999; }
		header .home-btn:hover { color: #e6e6e6; background: #1a1a1a; }
		.panel { background: #141414; border: 1px solid #2a2a2a; border-radius: 6px; padding: 1em; margin-bottom: 1em; }
		.panel h2 { font-size: 1em; margin: 0 0 0.6em 0; color: #999; }
		label { display: block; margin: 0.3em 0; font-size: 0.9em; color: #999; }
		input, button { font-family: inherit; font-size: 15px; background: #1a1a1a; color: #e6e6e6; border: 1px solid #444; padding: 10px 12px; border-radius: 4px; }
		input { width: 100%; max-width: 280px; }
		button { cursor: pointer; background: #2a4a3f; border-color: #3a6a5f; white-space: nowrap; min-height: 44px; }
		button:hover { background: #3a6a5f; }
		button.danger { background: #4a2a2a; border-color: #6a3a3a; }
		button.danger:hover { background: #6a3a3a; }
		.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 0.3em 0; }
		.row label { margin: 0; flex: 1; min-width: 120px; }
		.status { font-size: 0.85em; color: #999; }
		.status .num { color: #e6e6e6; font-weight: bold; }
		.diff-view { background: #0a0a0a; border: 1px solid #2a2a2a; border-radius: 6px; padding: 0; overflow: auto; max-height: 60vh; -webkit-overflow-scrolling: touch; }
		.diff-view pre { margin: 0; padding: 12px; font-size: 0.8em; line-height: 1.5; white-space: pre-wrap; word-break: break-all; }
		.add { color: #60c060; }
		.del { color: #e06060; }
		.hdr { color: #8abeb7; }
		.msg { margin-top: 0.5em; font-size: 0.9em; }
		.msg.error { color: #e06060; }
		.msg.success { color: #60c060; }
		.hidden { display: none; }
		@media (max-width: 600px) {
			body { padding: 10px; }
			.panel { padding: 0.8em; border-radius: 4px; }
			.row { flex-direction: column; align-items: stretch; gap: 6px; }
			.row button { width: 100%; }
			input { max-width: none; }
			button { min-height: 44px; }
		}
	</style>
</head>
<body>
	<header>
		<a href="/" class="home-btn" title="Home">
			<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><title>Home</title><path d="M2 6l6-4 6 4v8H2V6z" stroke="currentColor" stroke-width="1.2" fill="none" /><rect x="6" y="9" width="4" height="5" stroke="currentColor" stroke-width="1.2" fill="none" /></svg>
		</a>
		<span class="sep">/</span> review
		<span class="sep" style="margin-left:auto;font-size:0.85em;max-width:50%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" id="review-cwd"></span>
	</header>

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
		const params = new URLSearchParams(location.search);
		const repoCwd = params.get("cwd") || "";
		if (repoCwd) {
			document.getElementById("review-cwd").textContent = repoCwd;
			document.getElementById("start-repo").value = repoCwd;
		}
		let sessionId = null;
		let currentFile = null;
		let currentFingerprint = null;

		async function api(method, url, body) {
			if (repoCwd) url += (url.indexOf("?") === -1 ? "?" : "&") + "repo=" + encodeURIComponent(repoCwd);
			const opts = { method, headers: body != null ? { "Content-Type": "application/json" } : {} };
			if (body != null) opts.body = JSON.stringify({ repo: repoCwd || undefined, ...body });
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
			const repo = document.getElementById("start-repo").value.trim() || repoCwd;
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

function renderTerminalPage(): string {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
	<title>pi terminal</title>
	<style>
		*, *::before, *::after { box-sizing: border-box; }
		body { font-family: ui-monospace, monospace; background: #0d0d0d; color: #e6e6e6; margin: 0; display: flex; flex-direction: column; height: 100vh; height: 100dvh; }
		header { padding: 10px 14px; border-bottom: 1px solid #2a2a2a; font-size: 13px; color: #999; display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
		header a { color: #8abeb7; text-decoration: none; font-weight: 500; }
		header a:hover { color: #a0d8cf; }
		header .sep { color: #555; }
		header .home-btn { display: inline-flex; align-items: center; padding: 6px 6px; border-radius: 4px; color: #999; }
		header .home-btn:hover { color: #e6e6e6; background: #1a1a1a; }
		header .cwd-wrap { flex: 1; text-align: right; }
		header input { font-family: inherit; font-size: 13px; background: #1a1a1a; color: #e6e6e6; border: 1px solid #444; padding: 6px 8px; border-radius: 4px; width: 160px; }
		#output { flex: 1; overflow-y: auto; padding: 12px; font-size: 0.85em; line-height: 1.5; white-space: pre-wrap; word-break: break-all; }
		#input-line { display: flex; border-top: 1px solid #2a2a2a; flex-shrink: 0; }
		#input-line span { padding: 12px 10px 12px 14px; color: #60c060; font-size: 15px; user-select: none; }
		#input-line input { flex: 1; font-family: inherit; font-size: 15px; background: transparent; color: #e6e6e6; border: none; padding: 12px 0; outline: none; }
		.dim { color: #666; }
		.err { color: #e06060; }
		@media (max-width: 600px) {
			header { padding: 8px 10px; }
			header input { width: 120px; font-size: 12px; }
			#output { padding: 8px; font-size: 0.8em; }
		}
	</style>
</head>
<body>
	<header>
		<a href="/" class="home-btn" title="Home">
			<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><title>Home</title><path d="M2 6l6-4 6 4v8H2V6z" stroke="currentColor" stroke-width="1.2" fill="none" /><rect x="6" y="9" width="4" height="5" stroke="currentColor" stroke-width="1.2" fill="none" /></svg>
		</a>
		<span class="sep">/</span> terminal
		<span class="cwd-wrap"><input id="cwd" placeholder="cwd" title="Working directory" value="${escapeHtml(process.cwd())}" /></span>
	</header>
	<div id="output"></div>
	<div id="input-line">
		<span>$</span>
		<input id="cmd" autofocus placeholder="Enter command…" spellcheck="false" />
	</div>
	<script>
		const output = document.getElementById("output");
		const cmd = document.getElementById("cmd");
		const cwdInput = document.getElementById("cwd");
		let history = [];
		let historyIdx = -1;

		function append(text, cls) {
			const el = document.createElement("div");
			if (cls) el.className = cls;
			el.textContent = text;
			output.appendChild(el);
			output.scrollTop = output.scrollHeight;
		}

		async function run() {
			const command = cmd.value.trim();
			if (!command) return;
			history.push(command);
			historyIdx = history.length;
			cmd.value = "";
			append("$ " + command, "dim");
			cmd.disabled = true;
			try {
				const cwd = cwdInput.value.trim() || "";
				const res = await fetch("/api/bash", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ command, cwd: cwd || undefined }),
				});
				const data = await res.json();
				if (data.output) append(data.output.trimEnd());
				if (data.error) append(data.error, "err");
			} catch (err) {
				append(err.message || "Failed", "err");
			}
			cmd.disabled = false;
			cmd.focus();
		}

		cmd.addEventListener("keydown", function(e) {
			if (e.key === "Enter") { e.preventDefault(); run(); }
			else if (e.key === "ArrowUp") {
				e.preventDefault();
				if (historyIdx > 0) { historyIdx--; cmd.value = history[historyIdx]; }
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				if (historyIdx < history.length - 1) { historyIdx++; cmd.value = history[historyIdx]; }
				else { historyIdx = history.length; cmd.value = ""; }
			}
		});
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
						const parsed = JSON.parse(body) as { cwd?: string; label?: string; sessionFile?: string };
						const cwd = parsed.cwd?.trim() || process.cwd();
						const instance = await supervisor.spawnInstance({
							cwd,
							label: parsed.label,
							sessionFile: parsed.sessionFile,
						});
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

		// GET /api/sessions?cwd=<path> — list past sessions
		if (request.method === "GET" && url.pathname === "/api/sessions") {
			const cwd = url.searchParams.get("cwd") || process.cwd();
			response.writeHead(200, { "content-type": "application/json" });
			try {
				const sessions = await SessionManager.list(cwd);
				response.end(
					JSON.stringify({
						ok: true,
						sessions: sessions.map((s) => ({
							id: s.id,
							path: s.path,
							cwd: s.cwd,
							name: s.name,
							messageCount: s.messageCount,
							firstMessage: s.firstMessage,
							modified: s.modified,
						})),
					}),
				);
			} catch (error: unknown) {
				response.end(JSON.stringify({ ok: false, error: String(error) }));
			}
			return;
		}
		// Terminal API
		if (url.pathname === "/api/bash" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				const { command, cwd } = JSON.parse(body) as { command: string; cwd?: string };
				try {
					const stdout = execSync(command, {
						cwd: cwd || process.cwd(),
						encoding: "utf-8",
						maxBuffer: 10 * 1024 * 1024,
						timeout: 30_000,
					});
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify({ ok: true, output: stdout }));
				} catch (error) {
					const err = error as { stdout?: string; stderr?: string; message?: string };
					response.writeHead(200, { "content-type": "application/json" });
					response.end(
						JSON.stringify({
							ok: false,
							output: (err.stdout || "") + (err.stderr || ""),
							error: err.message || String(error),
						}),
					);
				}
			});
			return;
		}

		// Cranium review API — all endpoints accept ?repo= or body.repo to set the working directory
		function reviewCwd(url: URL, bodyRepo?: string): string | undefined {
			return bodyRepo || url.searchParams.get("repo") || undefined;
		}
		if (url.pathname === "/api/review/status" && request.method === "GET") {
			const cwd = reviewCwd(url);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(runCranium(["review", "status", "--json"], { cwd })));
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
				response.end(JSON.stringify(runCranium(args, { cwd: repo || undefined })));
			});
			return;
		}
		if (url.pathname === "/api/review/next" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				const { session, repo } = JSON.parse(body || "{}") as { session?: string; repo?: string };
				const cwd = reviewCwd(url, repo);
				const args = ["review", "next", "--json"];
				if (session) args.push("--session", session);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify(runCranium(args, { cwd })));
			});
			return;
		}
		if (url.pathname === "/api/review/diff" && request.method === "GET") {
			const filePath = url.searchParams.get("path");
			const session = url.searchParams.get("session");
			const cwd = reviewCwd(url);
			if (!filePath) {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ ok: false, error: "Missing path parameter" }));
				return;
			}
			const args = ["review", "diff", filePath];
			if (session) args.push("--session", session);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(runCranium(args, { cwd })));
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
					repo,
				} = JSON.parse(body) as {
					path: string;
					session?: string;
					expected?: string;
					repo?: string;
				};
				const cwd = reviewCwd(url, repo);
				const args = ["review", "mark", filePath];
				if (expected) args.push("--expected", expected);
				if (session) args.push("--session", session);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify(runCranium(args, { cwd })));
			});
			return;
		}
		if (url.pathname === "/api/review/clear" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				const { session, repo } = JSON.parse(body || "{}") as { session?: string; repo?: string };
				const cwd = reviewCwd(url, repo);
				const args = ["review", "clear", "--yes"];
				if (session) args.push("--session", session);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify(runCranium(args, { cwd })));
			});
			return;
		}
		if (url.pathname === "/api/review/merge" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				const { base, session, repo } = JSON.parse(body) as {
					base: string;
					session?: string;
					repo?: string;
				};
				const cwd = reviewCwd(url, repo);
				const args = ["review", "merge", "--base", base, "--yes"];
				if (session) args.push("--session", session);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify(runCranium(args, { cwd })));
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

		if (url.pathname === "/terminal") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
			response.end(renderTerminalPage());
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
