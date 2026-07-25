#!/usr/bin/env node
/**
 * Dev bridge: spawns `pi --mode rpc` and exposes it to the web UI.
 *
 * - WebSocket /ws: bidirectional bridge, one JSON message per frame.
 *   Client -> bridge messages are written to pi's stdin as JSONL.
 *   pi stdout JSONL events are broadcast to all connected clients.
 * - GET /theme/<name>.json: serves the TUI theme files from packages/coding-agent.
 *
 * Environment:
 *   PI_WEB_BRIDGE_PORT  bridge listen port (default 4464)
 *   PI_WEB_CWD          working directory for the pi process (default: process cwd)
 *   PI_WEB_PI_ARGS      extra args for pi, space-separated (e.g. "--provider anthropic --model claude-...")
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const themeDir = join(repoRoot, "packages", "coding-agent", "src", "modes", "interactive", "theme");

const port = Number(process.env.PI_WEB_BRIDGE_PORT ?? 4464);
const targetCwd = process.env.PI_WEB_CWD ?? process.cwd();
const extraArgs = (process.env.PI_WEB_PI_ARGS ?? "").split(" ").filter((arg) => arg !== "");

const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const cliEntry = join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

const child = spawn(tsxBin, ["--tsconfig", join(repoRoot, "tsconfig.json"), cliEntry, "--mode", "rpc", ...extraArgs], {
	cwd: targetCwd,
	stdio: ["pipe", "pipe", "inherit"],
});

child.on("exit", (code, signal) => {
	console.error(`pi exited (code=${code}, signal=${signal})`);
	process.exit(code ?? 1);
});

const decoder = new StringDecoder("utf8");
let stdoutBuffer = "";
const clients = new Set<import("ws").WebSocket>();

child.stdout.on("data", (chunk: Buffer) => {
	stdoutBuffer += decoder.write(chunk);
	while (true) {
		const newlineIndex = stdoutBuffer.indexOf("\n");
		if (newlineIndex === -1) break;
		let line = stdoutBuffer.slice(0, newlineIndex);
		stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (line === "") continue;
		// Validate JSON before forwarding so parse errors surface here, not in clients
		try {
			JSON.parse(line);
		} catch {
			console.error(`dropping non-JSON stdout line: ${line.slice(0, 120)}`);
			continue;
		}
		for (const client of clients) {
			if (client.readyState === client.OPEN) {
				client.send(line);
			}
		}
	}
});

async function handleTheme(request: IncomingMessage, response: ServerResponse): Promise<void> {
	const match = /^\/theme\/([a-z-]+)\.json$/.exec(request.url ?? "");
	if (!match) {
		response.writeHead(404).end("not found");
		return;
	}
	try {
		const content = await readFile(join(themeDir, `${match[1]}.json`), "utf-8");
		response.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
		response.end(content);
	} catch {
		response.writeHead(404).end("theme not found");
	}
}

const server = createServer((request, response) => {
	if (request.url?.startsWith("/theme/")) {
		void handleTheme(request, response);
		return;
	}
	response.writeHead(426).end("websocket required");
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket) => {
	clients.add(socket);
	socket.on("message", (data) => {
		const text = data.toString();
		try {
			JSON.parse(text);
		} catch {
			return;
		}
		child.stdin.write(`${text}\n`);
	});
	socket.on("close", () => {
		clients.delete(socket);
	});
});

server.listen(port, () => {
	console.log(`pi-web bridge listening on http://localhost:${port} (pi cwd: ${targetCwd})`);
});

function shutdown(): void {
	child.kill("SIGINT");
	server.close();
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
