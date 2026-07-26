#!/usr/bin/env -S node --import tsx
/**
 * Smoke test for server web module output.
 * Starts the server, fetches pages, validates HTML structure.
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname!, "../../..");
const tsxBin = resolve(repoRoot, "node_modules/.bin/tsx");
const serverEntry = resolve(repoRoot, "packages/server/src/cli.ts");

let exitCode = 0;
function fail(msg: string): void {
	console.error(`FAIL: ${msg}`);
	exitCode = 1;
}
function pass(msg: string): void {
	console.error(`PASS: ${msg}`);
}

// Remove existing socket
rmSync(resolve(homedir(), ".pi/server/server.sock"), { force: true });

// Start server
const child = spawn("node", [tsxBin, "--tsconfig", resolve(repoRoot, "tsconfig.json"), serverEntry, "serve", "--web"], {
	cwd: repoRoot,
	env: { ...process.env },
	stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout?.on("data", (chunk: Buffer) => {
	stdout += chunk.toString();
});
child.stderr?.on("data", (chunk: Buffer) => {
	stderr += chunk.toString();
});

let serverUrl: string;
try {
	const port = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Server startup timed out")), 15_000);
		child.stdout?.on("data", () => {
			const match = /web UI: http:\/\/[^:]+:(\d+)\//.exec(stdout);
			if (match) {
				clearTimeout(timer);
				resolve(match[1]!);
			}
		});
		child.once("error", reject);
	});
	serverUrl = `http://127.0.0.1:${port}`;
	console.error(`Server at ${serverUrl}`);
} catch (_err) {
	console.error(`Server stderr:\n${stderr.slice(0, 2000)}`);
	console.error(`Server stdout:\n${stdout.slice(0, 2000)}`);
	fail("Server failed to start");
	child.kill();
	process.exit(1);
}

async function fetchPage(path: string): Promise<string> {
	const res = await fetch(`${serverUrl}${path}`);
	assert.equal(res.status, 200, `Expected 200 for ${path}, got ${res.status}`);
	return res.text();
}

function cssBracesBalanced(html: string): boolean {
	const styleRegex = /<style>([\s\S]*?)<\/style>/g;
	let match: RegExpExecArray | null = styleRegex.exec(html);
	while (match !== null) {
		const css = match[1]!;
		let depth = 0;
		for (const ch of css) {
			if (ch === "{") depth++;
			if (ch === "}") depth--;
			if (depth < 0) return false;
		}
		if (depth !== 0) return false;
		match = styleRegex.exec(html);
	}
	return true;
}

try {
	// ---- Index page tests ----
	const indexHtml = await fetchPage("/");

	if (indexHtml.includes("function loadPastSessions()")) pass("index: loadPastSessions present");
	else fail("index: loadPastSessions missing");

	if (indexHtml.includes("function resumeClick(")) pass("index: resumeClick present");
	else fail("index: resumeClick missing");

	if (indexHtml.includes("function resumeSession(")) pass("index: resumeSession present");
	else fail("index: resumeSession missing");

	if (indexHtml.includes("loadPastSessions();")) pass("index: calls loadPastSessions()");
	else fail("index: loadPastSessions() call missing");

	if (indexHtml.includes("data-session-path")) pass("index: data-session-path attrs present");
	else fail("index: data-session-path attrs missing");

	if (indexHtml.includes('<div id="past-list">')) pass("index: past-list container present");
	else fail("index: past-list container missing");

	if (cssBracesBalanced(indexHtml)) pass("index: CSS braces balanced");
	else fail("index: CSS braces unbalanced");

	// ---- Terminal page tests ----
	const terminalHtml = await fetchPage("/terminal");

	if (cssBracesBalanced(terminalHtml)) pass("terminal: CSS braces balanced");
	else fail("terminal: CSS braces unbalanced");

	if (terminalHtml.includes("box-sizing: border-box")) pass("terminal: box-sizing present");
	else fail("terminal: box-sizing missing");

	if (terminalHtml.includes("100dvh")) pass("terminal: dynamic viewport height present");
	else fail("terminal: 100dvh missing");

	if (terminalHtml.includes("{") && terminalHtml.match(/<style>[\s\S]*?<\/style>/g)?.every((b) => b.includes("{"))) {
		pass("terminal: CSS has opening braces");
	} else {
		fail("terminal: CSS missing opening braces");
	}

	if (terminalHtml.includes("home-btn")) pass("terminal: home button present");
	else fail("terminal: home button missing");

	// ---- Review page tests ----
	const reviewHtml = await fetchPage("/review");

	if (cssBracesBalanced(reviewHtml)) pass("review: CSS braces balanced");
	else fail("review: CSS braces unbalanced");

	if (reviewHtml.includes("function loadStatus()")) pass("review: loadStatus present");
	else fail("review: loadStatus missing");

	if (reviewHtml.includes("function startReview()")) pass("review: startReview present");
	else fail("review: startReview missing");

	if (reviewHtml.includes("home-btn")) pass("review: home button present");
	else fail("review: home button missing");

	// ---- API tests ----
	const sessionsRes = await fetch(`${serverUrl}/api/sessions?cwd=.`);
	const sessionsData = (await sessionsRes.json()) as { ok: boolean; sessions: unknown[] };
	if (sessionsData.ok && Array.isArray(sessionsData.sessions)) pass("API: /api/sessions returns valid response");
	else fail("API: /api/sessions returned invalid response");

	const spawnRes = await fetch(`${serverUrl}/api/spawn`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ cwd: ".", label: "smoke test" }),
	});
	const spawnData = (await spawnRes.json()) as { ok: boolean; instance?: { id: string } };
	if (spawnData.ok && spawnData.instance && spawnData.instance.id) pass("API: /api/spawn works");
	else fail("API: /api/spawn failed");
} catch (err) {
	fail(`Exception: ${err instanceof Error ? err.message : String(err)}`);
	console.error(err);
}

child.kill();

if (exitCode === 0) console.error("\nAll tests passed!");
else console.error("\nSome tests failed.");
process.exit(exitCode);
