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
	SessionManager,
} from "@earendil-works/pi-coding-agent";
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
							`<a class="meta" href="/review?cwd=${encodeURIComponent(instance.cwd)}&instance=${encodeURIComponent(instance.id)}&start=1">review</a></li>`,
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
		.past-item { display: flex; justify-content: space-between; align-items: center; padding: 0.4em 0; gap: 8px; }
		.past-item + .past-item { border-top: 1px solid #1a1a1a; }
		.past-item span { font-size: 0.9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.past-item button { font-family: inherit; font-size: 0.85em; background: #1a1a1a; color: #8abeb7; border: 1px solid #333; padding: 4px 10px; border-radius: 3px; cursor: pointer; white-space: nowrap; flex-shrink: 0; min-height: 34px; }
		.past-item button:hover { background: #2a2a2a; }
		@media (max-width: 600px) {
			body { padding: 10px; }
			.spawn-form input { max-width: none; }
			.spawn-form button { width: 100%; }
		}
	</style>
</head>
<body>
	<h1>pi</h1>
	<h2 style="font-size:1em;margin-top:1.5em">Active sessions</h2>
	<ul>
${items}
	</ul>
	<h2 style="font-size:1em;margin-top:1.5em">Past sessions <span style="font-weight:400;color:#666;font-size:0.9em" id="past-cwd"></span></h2>
	<div id="past-list"><span class="meta">Loading…</span></div>
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
	function loadPastSessions() {
		function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
		var cwdInput = document.getElementById("spawn-cwd");
		var label = document.getElementById("past-cwd");
		var list = document.getElementById("past-list");
		async function refresh() {
			var cwd = cwdInput.value.trim() || ".";
			try {
				var res = await fetch("/api/sessions?cwd=" + encodeURIComponent(cwd));
				var data = await res.json();
				if (!data.ok || !data.sessions || data.sessions.length === 0) {
					label.textContent = "";
					list.innerHTML = '<span class="meta">No past sessions</span>';
					return;
				}
				label.textContent = "(" + data.sessions.length + ")";
				list.innerHTML = data.sessions.map(function(s) {
					var name = s.name || s.firstMessage || s.id.slice(0, 8);
					var date = new Date(s.modified).toLocaleDateString();
					return '<div class="past-item">' +
					'<span>' + esc(name) + ' <span class="meta">' + s.messageCount + ' msgs \u00b7 ' + date + '</span></span>' +
					'<button data-session-path="' + esc(s.path) + '" data-session-cwd="' + esc(s.cwd || cwd) + '" data-session-name="' + esc(name) + '" onclick="resumeClick(this)">Resume</button>' +
					'</div>';
				}).join("");
			} catch (_err) {
				list.innerHTML = '<span class="meta error">Failed to load sessions</span>';
			}
		}
		cwdInput.addEventListener("change", refresh);
		cwdInput.addEventListener("blur", refresh);
		refresh();
	}

	function resumeClick(btn) {
		resumeSession(btn.getAttribute("data-session-path"), btn.getAttribute("data-session-cwd"), btn.getAttribute("data-session-name"));
	}

	async function resumeSession(path, cwd, name) {
		var resultEl = document.getElementById("spawn-result");
		resultEl.textContent = "Resuming\u2026";
		resultEl.className = "spawn-result";
		try {
			var res = await fetch("/api/spawn", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cwd: cwd, label: name || undefined, sessionFile: path }),
			});
			var data = await res.json();
			if (data.ok && data.instance) {
				resultEl.textContent = "Resumed! Opening\u2026";
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

	loadPastSessions();
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
		header .branch { color: #b294bb; background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 3px; padding: 2px 6px; font-size: 0.85em; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.panel { background: #141414; border: 1px solid #2a2a2a; border-radius: 6px; padding: 1em; margin-bottom: 1em; }
		.panel h2 { font-size: 1em; margin: 0 0 0.6em 0; color: #999; }
		label { display: block; margin: 0.3em 0; font-size: 0.9em; color: #999; }
		input, button { font-family: inherit; font-size: 15px; background: #1a1a1a; color: #e6e6e6; border: 1px solid #444; padding: 10px 12px; border-radius: 4px; }
		input { width: 100%; max-width: 280px; }
		button { cursor: pointer; background: #2a4a3f; border-color: #3a6a5f; white-space: nowrap; min-height: 44px; }
		button:hover { background: #3a6a5f; }
		button.danger { background: #4a2a2a; border-color: #6a3a3a; }
		button.danger:hover { background: #6a3a3a; }
		button:disabled { opacity: 0.5; cursor: default; }
		button:disabled:hover { background: #2a4a3f; }
		.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 0.3em 0; }
		.row label { margin: 0; flex: 1; min-width: 120px; }
		.status { font-size: 0.85em; color: #999; }
		.status.warn { color: #d7a55b; }
		.status .num { color: #e6e6e6; font-weight: bold; }
		.file-list { list-style: none; margin: 0.8em 0 0 0; padding: 0; border: 1px solid #2a2a2a; border-radius: 6px; overflow: hidden; }
		.file-list li { border-top: 1px solid #1f1f1f; }
		.file-list li:first-child { border-top: none; }
		.file-row { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; background: #0a0a0a; border: none; border-radius: 0; color: #e6e6e6; font-size: 0.85em; padding: 10px 12px; min-height: 44px; }
		.file-row:hover { background: #1a1a1a; }
		.file-row .box { color: #666; flex-shrink: 0; }
		.file-row.done .box { color: #60c060; }
		.file-row.done .path { color: #7a7a7a; }
		.file-row .path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
		.file-row .tag { flex-shrink: 0; font-size: 0.85em; color: #d7a55b; }
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
		<a href="#" class="home-btn hidden" id="review-session-link" title="Back to session">
			<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><title>Session</title><rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none" /><path d="M4.5 6.5L6.5 8l-2 1.5M8 9.5h3.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
		</a>
		<span class="branch hidden" id="review-branch"></span>
		<span class="sep" style="margin-left:auto;font-size:0.85em;max-width:50%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" id="review-cwd"></span>
	</header>

	<div class="panel hidden" id="panel-start">
		<h2>Start review</h2>
		<div class="status" style="margin-bottom:0.7em">Leave Base and Head empty to use the current branch's GitHub PR. If no PR exists, pi will create one for the current branch.</div>
		<div class="row">
			<label>Base <input id="start-base" placeholder="current branch PR" /></label>
			<label>Head <input id="start-head" placeholder="current branch PR" /></label>
			<label>Repo <input id="start-repo" placeholder="(cwd)" /></label>
			<button onclick="startReview()">Start</button>
		</div>
		<div id="start-msg" class="msg"></div>
	</div>

	<div class="panel hidden" id="panel-active">
		<div class="row" style="justify-content:space-between">
			<h2 style="margin:0" id="review-title">Review</h2>
			<div>
				<button onclick="swapReview()" id="btn-swap" title="Restart this review with base and head exchanged">Swap base/head</button>
				<button onclick="commitReview()" id="btn-commit" title="Keep what you have reviewed and pick up new commits">Commit review</button>
				<button onclick="mergeReview()" id="btn-merge" title="Merge this branch's pull request on GitHub">Merge PR</button>
				<button class="danger" onclick="clearReview()" title="Discard all review progress and start this review again">Restart</button>
			</div>
		</div>
		<div id="review-status" class="status"></div>
		<ul id="file-list" class="file-list hidden"></ul>
		<div id="review-file" class="hidden">
			<div class="row" style="justify-content:space-between; margin-top:0.8em">
				<div class="row" style="flex:1; min-width:0; gap:8px; margin:0">
					<button onclick="showSummary()" id="btn-back" title="Back to the file list">&larr; Files</button>
					<strong id="file-path" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap"></strong>
				</div>
				<div>
					<button onclick="markFile()" id="btn-mark">Mark reviewed</button>
					<button onclick="nextFile()">Skip</button>
				</div>
			</div>
			<div class="status" id="file-position"></div>
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
		let autoStartReview = params.get("start") === "1";
		if (repoCwd) {
			document.getElementById("review-cwd").textContent = repoCwd;
			document.getElementById("start-repo").value = repoCwd;
		}
		// Shown only when we know which session this review was opened from
		const instanceId = params.get("instance");
		if (instanceId) {
			const sessionLink = document.getElementById("review-session-link");
			sessionLink.href = "/i/" + encodeURIComponent(instanceId) + "/";
			sessionLink.classList.remove("hidden");
		}
		let sessionId = null;
		let currentFile = null;
		let currentFingerprint = null;
		// Every file in the review, newest status first, as returned by cranium status
		let reviewFiles = [];
		// null on the summary view, otherwise the path of the file being reviewed
		let openFile = null;
		// Refs of the active session, so Clear can recreate the same review range
		let activeBaseRef = null;
		let activeHeadRef = null;
		let activeProviderReviewId = null;
		let activeCounts = null;

		function selectedRepo() {
			return document.getElementById("start-repo").value.trim() || repoCwd;
		}

		async function loadBranch() {
			const el = document.getElementById("review-branch");
			const repo = selectedRepo();
			if (!repo) {
				el.classList.add("hidden");
				return;
			}
			try {
				const res = await fetch("/api/git/branch?repo=" + encodeURIComponent(repo));
				const data = await res.json();
				if (data.ok && data.branch) {
					el.textContent = data.branch;
					el.classList.remove("hidden");
					return;
				}
			} catch (_err) {
				// fall through and hide: a missing branch is not a review error
			}
			el.classList.add("hidden");
		}
		document.getElementById("start-repo").addEventListener("change", loadBranch);

		async function api(method, url, body) {
			const repo = selectedRepo();
			if (repo) url += (url.indexOf("?") === -1 ? "?" : "&") + "repo=" + encodeURIComponent(repo);
			const opts = { method, headers: body != null ? { "Content-Type": "application/json" } : {} };
			if (body != null) opts.body = JSON.stringify({ repo: repo || undefined, ...body });
			const res = await fetch(url, opts);
			return res.json();
		}

		async function loadStatus() {
			const data = await api("GET", "/api/review/status");
			if (!data.ok || !data.data) {
				// No active review
				startPanel.classList.remove("hidden");
				activePanel.classList.add("hidden");
				if (autoStartReview) {
					autoStartReview = false;
					await startReview();
				}
				return;
			}
			const r = data.data.result;
			sessionId = r.session.id;
			activeBaseRef = r.session.baseRef;
			activeHeadRef = r.session.headRef;
			activeProviderReviewId = r.session.providerReviewId;
			activeCounts = r.counts;
			startPanel.classList.add("hidden");
			activePanel.classList.remove("hidden");

			document.getElementById("review-title").textContent =
				"Review " + r.session.baseRef + ".." + r.session.headRef;
			document.getElementById("review-status").innerHTML =
				"<span class=num>" + r.counts.unreviewed + "</span> unreviewed &middot; " +
				"<span class=num>" + r.counts.reviewed + "</span> reviewed &middot; " +
				"<span class=num>" + r.counts.changedSinceReview + "</span> changed";

			reviewFiles = Array.isArray(r.files) ? r.files : [];
			renderFileList();

			// A file open before the refresh stays open so marking one file does not
			// throw away the diff the user is reading.
			if (openFile !== null && reviewFiles.some((file) => file.path === openFile)) {
				document.getElementById("file-list").classList.add("hidden");
				document.getElementById("review-empty").classList.add("hidden");
			} else {
				openFile = null;
				document.getElementById("review-file").classList.add("hidden");
				const emptyEl = document.getElementById("review-empty");
				// An empty range is not a finished review: with base and head the wrong way
				// round the diff is empty, which must not look like "nothing left to do".
				if (r.files.length === 0) {
					emptyEl.innerHTML =
						"No files in <strong>" + escapeRef(r.session.baseRef) + ".." + escapeRef(r.session.headRef) +
						"</strong>. This range is empty \u2014 if the branches are the wrong way round, " +
						"Restart the review with base <strong>" + escapeRef(r.session.headRef) + "</strong> and head <strong>" +
						escapeRef(r.session.baseRef) + "</strong>.";
					emptyEl.className = "status warn";
					emptyEl.classList.remove("hidden");
				} else if (r.counts.unreviewed === 0 && r.counts.changedSinceReview === 0) {
					emptyEl.textContent = "All files reviewed.";
					emptyEl.className = "status";
					emptyEl.classList.remove("hidden");
				} else {
					// Files remain: the list itself is the view, so no empty message.
					emptyEl.classList.add("hidden");
				}
			}
		}

		function isReviewed(status) {
			return status === "reviewed" || status === "unchanged";
		}

		/** Files still needing attention, in the order the diff view walks them. */
		function pendingFiles() {
			return reviewFiles.filter((file) => !isReviewed(file.status));
		}

		/**
		 * Render the summary: every file in the review with a tick when reviewed and an
		 * empty box when not. Clicking a row drills into that file's diff.
		 */
		function renderFileList() {
			const list = document.getElementById("file-list");
			list.textContent = "";
			if (reviewFiles.length === 0) {
				list.classList.add("hidden");
				return;
			}
			for (const file of reviewFiles) {
				const done = isReviewed(file.status);
				const item = document.createElement("li");
				const row = document.createElement("button");
				row.className = done ? "file-row done" : "file-row";
				row.onclick = () => openReviewFile(file.path);

				const box = document.createElement("span");
				box.className = "box";
				box.textContent = done ? "[x]" : "[ ]";
				row.appendChild(box);

				// bdi keeps the rtl ellipsis from reordering the path's own characters
				const pathEl = document.createElement("bdi");
				pathEl.className = "path";
				pathEl.textContent = file.path;
				row.appendChild(pathEl);

				if (file.status === "changedSinceReview") {
					const tag = document.createElement("span");
					tag.className = "tag";
					tag.textContent = "changed";
					row.appendChild(tag);
				}

				item.appendChild(row);
				list.appendChild(item);
			}
			list.classList.remove("hidden");
		}

		/** Show the file list and hide any open diff. */
		function showSummary() {
			openFile = null;
			currentFile = null;
			currentFingerprint = null;
			document.getElementById("review-file").classList.add("hidden");
			document.getElementById("review-msg").textContent = "";
			return loadStatus();
		}

		/** Drill into one file's diff. */
		async function openReviewFile(filePath) {
			const file = reviewFiles.find((candidate) => candidate.path === filePath);
			if (!file) return;
			openFile = file.path;
			currentFile = file.path;
			currentFingerprint = file.currentFingerprint;
			document.getElementById("file-path").textContent = file.path;
			document.getElementById("review-file").classList.remove("hidden");
			document.getElementById("file-list").classList.add("hidden");
			document.getElementById("review-empty").classList.add("hidden");
			document.getElementById("btn-mark").disabled = isReviewed(file.status);

			const pending = pendingFiles();
			const position = pending.findIndex((candidate) => candidate.path === file.path);
			document.getElementById("file-position").textContent =
				position === -1
					? "Already reviewed"
					: "File " + (position + 1) + " of " + pending.length + " to review";

			document.getElementById("diff-content").textContent = "Loading\u2026";
			const diffData = await api("GET",
				"/api/review/diff?path=" + encodeURIComponent(file.path) +
				(sessionId ? "&session=" + sessionId : ""));
			// A slower diff for a file the user already navigated away from must not land
			if (openFile !== file.path) return;
			document.getElementById("diff-content").innerHTML =
				highlightDiff((diffData.ok && typeof diffData.data === "string") ? diffData.data : "");
			document.querySelector(".diff-view").scrollTop = 0;
		}

		function escapeRef(value) {
			return String(value == null ? "" : value)
				.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
		}

		/**
		 * Open the next file needing review after afterPath, wrapping to the start.
		 * Returns to the summary when nothing is left.
		 */
		async function openNextPending(afterPath) {
			const pending = pendingFiles();
			if (pending.length === 0) {
				showSummary();
				return;
			}
			// Walk from the file just reviewed so marking advances in list order
			const index = reviewFiles.findIndex((file) => file.path === afterPath);
			const next =
				reviewFiles
					.slice(index + 1)
					.find((file) => !isReviewed(file.status)) ?? pending[0];
			await openReviewFile(next.path);
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
			const base = document.getElementById("start-base").value.trim();
			const head = document.getElementById("start-head").value.trim();
			const repo = selectedRepo();
			const msg = document.getElementById("start-msg");
			msg.textContent = base || head ? "Starting…" : "Finding or creating PR…"; msg.className = "msg";
			const data = await api("POST", "/api/review/start", {
				base: base || undefined,
				head: head || undefined,
				repo: repo || undefined,
				createPr: !base && !head,
			});
			if (!data.ok) {
				msg.textContent = data.error || "Failed"; msg.className = "msg error";
			} else {
				// --create-pr can move HEAD to a new branch
				await loadBranch();
				await loadStatus();
			}
		}

		/** Mark the open file reviewed, then move straight on to the next one. */
		async function markFile() {
			if (!currentFile) return;
			const marked = currentFile;
			const msg = document.getElementById("review-msg");
			const button = document.getElementById("btn-mark");
			button.disabled = true;
			msg.textContent = "Marking…"; msg.className = "msg";
			try {
				const data = await api("POST", "/api/review/mark", {
					path: marked,
					session: sessionId,
					expected: currentFingerprint,
				});
				if (!data.ok) {
					msg.textContent = data.error || "Failed"; msg.className = "msg error";
					button.disabled = false;
					return;
				}
				msg.textContent = "";
				// Refresh statuses so the tick and the remaining count reflect the mark,
				// keeping the current file open so loadStatus does not bounce to the list.
				await loadStatus();
				await openNextPending(marked);
			} finally {
				if (openFile !== null) {
					const file = reviewFiles.find((candidate) => candidate.path === openFile);
					button.disabled = file ? isReviewed(file.status) : false;
				}
			}
		}

		/** Leave the file unreviewed and move to the next one. */
		async function nextFile() {
			document.getElementById("review-msg").textContent = "";
			await openNextPending(currentFile);
		}

		/**
		 * Merge this branch's GitHub pull request into a target branch (default main).
		 *
		 * The merge happens on GitHub and cannot be undone from here, so the target is
		 * confirmed rather than assumed, and outstanding review work is called out.
		 */
		async function mergeReview() {
			const msg = document.getElementById("review-msg");
			const button = document.getElementById("btn-merge");
			const target = window.prompt("Merge this branch's pull request into which branch?", "main");
			if (target === null) return;
			const baseBranch = target.trim() || "main";
			const outstanding = activeCounts
				? activeCounts.unreviewed + activeCounts.changedSinceReview
				: 0;
			const warning = outstanding > 0
				? "\n\n" + outstanding + " file(s) are still unreviewed or changed since you reviewed them."
				: "";
			if (!confirm("Merge the pull request for this branch into " + baseBranch + "?" + warning)) return;
			button.disabled = true;
			msg.textContent = "Merging…"; msg.className = "msg";
			try {
				const data = await api("POST", "/api/review/merge", { base: baseBranch, session: sessionId });
				if (!data.ok) {
					msg.textContent = data.error || "Failed"; msg.className = "msg error";
					return;
				}
				const result = data.data && data.data.result;
				const pull = result && result.pull;
				msg.textContent = pull
					? "Merged " + pull.identity + " into " + baseBranch + "."
					: "Merged into " + baseBranch + ".";
				msg.className = "msg success";
				await loadBranch();
				await loadStatus();
			} finally {
				button.disabled = false;
			}
		}

		/**
		 * Commit the review: re-anchor to the repo's current HEAD while keeping every
		 * checkpoint. Files reviewed at an older revision come back as "changed" showing
		 * only what moved since you reviewed them, and new commits add new files.
		 */
		async function commitReview() {
			const msg = document.getElementById("review-msg");
			const button = document.getElementById("btn-commit");
			button.disabled = true;
			msg.textContent = "Committing review\u2026"; msg.className = "msg";
			try {
				const data = await api("POST", "/api/review/refresh", sessionId ? { session: sessionId } : {});
				if (!data.ok) {
					msg.textContent = data.error || "Failed"; msg.className = "msg error";
					return;
				}
				msg.textContent = "Review committed."; msg.className = "msg success";
				// HEAD may have moved to a different branch since the review started
				await loadBranch();
				await loadStatus();
			} finally {
				button.disabled = false;
			}
		}

		/**
		 * Restart the review with base and head exchanged. Fixes a review created with
		 * the branches the wrong way round, which produces an empty range.
		 */
		async function swapReview() {
			const base = activeBaseRef;
			const head = activeHeadRef;
			if (!base || !head) {
				const msg = document.getElementById("review-msg");
				msg.textContent = "This review has no explicit base and head to swap.";
				msg.className = "msg error";
				return;
			}
			if (!confirm("Restart this review as " + head + ".." + base + "? Review progress will be discarded.")) return;
			await restartReview({ base: head, head: base });
		}

		/**
		 * Discard all review progress and start the same review over from scratch.
		 *
		 * cranium's start is idempotent (it refreshes an existing session instead of
		 * recreating it), so the old session must be deleted first. The session's own
		 * refs are reused so the new review covers the same range; a PR-backed session
		 * re-resolves the PR instead.
		 */
		async function clearReview() {
			if (!confirm("Discard all review progress and start this review again?")) return;
			const fromPullRequest = activeProviderReviewId !== null && activeProviderReviewId !== undefined;
			const base = activeBaseRef;
			const head = activeHeadRef;
			// A PR-backed session re-resolves its existing PR, so creation is never needed here.
			await restartReview(fromPullRequest || !base || !head ? {} : { base: base, head: head });
		}

		/** Delete the current session, then start a new one with the given refs. */
		async function restartReview(startBody) {
			const msg = document.getElementById("review-msg");
			msg.textContent = "Clearing\u2026"; msg.className = "msg";
			const cleared = await api("POST", "/api/review/clear", sessionId ? { session: sessionId } : {});
			if (!cleared.ok) {
				msg.textContent = cleared.error || "Failed to clear"; msg.className = "msg error";
				return;
			}
			sessionId = null;
			currentFile = null;
			currentFingerprint = null;

			msg.textContent = "Starting review\u2026";
			const started = await api("POST", "/api/review/start", startBody);
			if (!started.ok) {
				// The review is gone; fall back to the start panel so it can be recreated by hand
				msg.textContent = started.error || "Cleared, but failed to start again";
				msg.className = "msg error";
				await loadStatus();
				return;
			}
			msg.textContent = "";
			await loadBranch();
			await loadStatus();
		}

		// Keyboard shortcuts mirroring the spacemacs review bindings: q returns to the
		// file list, m marks reviewed and advances, n skips to the next file.
		document.addEventListener("keydown", (event) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const tag = event.target && event.target.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA") return;
			if (openFile === null) return;
			if (event.key === "q" || event.key === "Escape") {
				event.preventDefault();
				showSummary();
			} else if (event.key === "m") {
				event.preventDefault();
				markFile();
			} else if (event.key === "n") {
				event.preventDefault();
				nextFile();
			}
		});

		loadBranch();
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

		// GET /api/git/branch?repo=<path> — current branch of a repo, for the review header
		if (request.method === "GET" && url.pathname === "/api/git/branch") {
			const repo = url.searchParams.get("repo") || process.cwd();
			response.writeHead(200, { "content-type": "application/json" });
			try {
				// Detached HEAD exits non-zero, which the catch below reports as no branch.
				const branch = execFileSync("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
					cwd: repo,
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "ignore"],
				}).trim();
				response.end(JSON.stringify({ ok: true, branch: branch || undefined }));
			} catch {
				response.end(JSON.stringify({ ok: true, branch: undefined }));
			}
			return;
		}

		// GET /api/sessions?cwd=<path> — list past sessions
		if (request.method === "GET" && url.pathname === "/api/sessions") {
			response.writeHead(200, { "content-type": "application/json" });
			const cwd = url.searchParams.get("cwd") || process.cwd();
			SessionManager.list(cwd)
				.then((sessions: Awaited<ReturnType<typeof SessionManager.list>>) => {
					response.end(
						JSON.stringify({
							ok: true,
							sessions: sessions.map((s: (typeof sessions)[number]) => ({
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
				})
				.catch((error: unknown) => {
					response.end(JSON.stringify({ ok: false, error: String(error) }));
				});
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
				const { base, head, repo, createPr } = JSON.parse(body) as {
					base?: string;
					head?: string;
					repo?: string;
					createPr?: boolean;
				};
				const args = ["review", "start"];
				if (base !== undefined || head !== undefined) {
					if (base === undefined || head === undefined) {
						response.writeHead(200, { "content-type": "application/json" });
						response.end(
							JSON.stringify({ ok: false, error: "Base and Head must both be set for a manual review" }),
						);
						return;
					}
					args.push("--base", base, "--head", head);
				} else if (createPr) {
					args.push("--create-pr");
				}
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
		// Re-anchor the review to the repo's current HEAD, keeping existing checkpoints:
		// reviewed files whose content moved become changedSinceReview, and files touched
		// by new commits are added as unreviewed.
		if (url.pathname === "/api/review/refresh" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				const { session, repo } = JSON.parse(body || "{}") as { session?: string; repo?: string };
				const cwd = reviewCwd(url, repo);
				const args = ["review", "refresh", "--json"];
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
