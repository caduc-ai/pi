import { createServer as createHttpServer, type Server } from "http";
import { createServer as createTcpServer, type Server as TcpServer, connect as tcpConnect } from "net";
import { afterEach, describe, expect, test } from "vitest";
import {
	applyHttpProxySettings,
	configureHttpDispatcher,
	isSocksProxyUrl,
	normalizeProxyUrl,
} from "../src/core/http-dispatcher.ts";

const PROXY_ENV_VARS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] as const;

const originalProxyEnv = new Map(PROXY_ENV_VARS.map((name) => [name, process.env[name]]));

afterEach(() => {
	for (const [name, value] of originalProxyEnv) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
});

function clearProxyEnv(): void {
	for (const name of PROXY_ENV_VARS) {
		delete process.env[name];
	}
}

describe("normalizeProxyUrl", () => {
	test("returns undefined for empty input", () => {
		expect(normalizeProxyUrl(undefined)).toBeUndefined();
		expect(normalizeProxyUrl("   ")).toBeUndefined();
	});

	// Only SOCKS URLs are rewritten, so http(s) values are handed back byte-for-byte.
	test("preserves http and https proxies verbatim", () => {
		expect(normalizeProxyUrl("http://127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
		expect(normalizeProxyUrl("https://proxy.example:8443")).toBe("https://proxy.example:8443");
		expect(normalizeProxyUrl("  http://127.0.0.1:7890  ")).toBe("http://127.0.0.1:7890");
	});

	// socks5h is the scheme users copy from curl/ssh docs, but undici only accepts socks5.
	test("rewrites socks5h to socks5", () => {
		expect(normalizeProxyUrl("socks5h://127.0.0.1:1080")).toBe("socks5://127.0.0.1:1080");
	});

	test("defaults the SOCKS port to 1080", () => {
		expect(normalizeProxyUrl("socks5://127.0.0.1")).toBe("socks5://127.0.0.1:1080");
		expect(normalizeProxyUrl("socks5h://vpn.internal")).toBe("socks5://vpn.internal:1080");
	});

	test("keeps SOCKS credentials", () => {
		expect(normalizeProxyUrl("socks5h://user:pass@127.0.0.1:1080")).toBe("socks5://user:pass@127.0.0.1:1080");
	});

	test("rejects SOCKS4, which undici cannot tunnel", () => {
		expect(() => normalizeProxyUrl("socks4://127.0.0.1:1080")).toThrow(/SOCKS4 proxies are not supported/);
	});

	test("rejects unsupported protocols and malformed URLs", () => {
		expect(() => normalizeProxyUrl("ftp://127.0.0.1:21")).toThrow(/Unsupported proxy protocol/);
		expect(() => normalizeProxyUrl("127.0.0.1:1080")).toThrow(/Invalid proxy URL/);
	});
});

describe("isSocksProxyUrl", () => {
	test("detects SOCKS schemes only", () => {
		expect(isSocksProxyUrl("socks5://127.0.0.1:1080")).toBe(true);
		expect(isSocksProxyUrl("socks5h://127.0.0.1:1080")).toBe(true);
		expect(isSocksProxyUrl("http://127.0.0.1:7890")).toBe(false);
		expect(isSocksProxyUrl(undefined)).toBe(false);
		expect(isSocksProxyUrl("not a url")).toBe(false);
	});
});

describe("applyHttpProxySettings", () => {
	test("normalizes socks5h into the proxy env vars", () => {
		clearProxyEnv();
		applyHttpProxySettings("socks5h://127.0.0.1:1080");
		expect(process.env.HTTP_PROXY).toBe("socks5://127.0.0.1:1080");
		expect(process.env.HTTPS_PROXY).toBe("socks5://127.0.0.1:1080");
	});

	test("does not override an existing environment proxy", () => {
		clearProxyEnv();
		process.env.HTTP_PROXY = "http://existing:3128";
		applyHttpProxySettings("socks5://127.0.0.1:1080");
		expect(process.env.HTTP_PROXY).toBe("http://existing:3128");
	});

	test("throws on an invalid settings value", () => {
		clearProxyEnv();
		expect(() => applyHttpProxySettings("socks4://127.0.0.1:1080")).toThrow(/SOCKS4 proxies are not supported/);
	});
});

describe("configureHttpDispatcher", () => {
	test("normalizes a socks5h value already present in the environment", () => {
		clearProxyEnv();
		process.env.HTTPS_PROXY = "socks5h://127.0.0.1:1080";
		configureHttpDispatcher();
		expect(process.env.HTTPS_PROXY).toBe("socks5://127.0.0.1:1080");
	});

	// undici parses these vars itself and throws from the EnvHttpProxyAgent constructor,
	// so an unusable value must be dropped rather than passed through.
	test("drops an unparseable environment proxy instead of failing startup", () => {
		clearProxyEnv();
		process.env.HTTPS_PROXY = "not a url";
		expect(() => configureHttpDispatcher()).not.toThrow();
		expect(process.env.HTTPS_PROXY).toBeUndefined();
	});
});

/**
 * Minimal SOCKS5 server (RFC 1928, no-auth) used to prove requests actually tunnel.
 * Records the target it was asked to reach so we can assert the hostname is sent to the
 * proxy rather than resolved locally (the socks5h behaviour that avoids DNS leaks).
 */
function createSocks5Server(): {
	server: TcpServer;
	listen: () => Promise<number>;
	targets: string[];
} {
	const targets: string[] = [];
	const server = createTcpServer((client) => {
		client.once("data", () => {
			client.write(Buffer.from([0x05, 0x00])); // select NO_AUTH
			client.once("data", (request) => {
				const addressType = request[3];
				let host: string;
				let offset: number;
				if (addressType === 0x01) {
					host = `${request[4]}.${request[5]}.${request[6]}.${request[7]}`;
					offset = 8;
				} else if (addressType === 0x03) {
					const length = request[4];
					host = request.subarray(5, 5 + length).toString("utf8");
					offset = 5 + length;
				} else {
					client.destroy();
					return;
				}
				const port = request.readUInt16BE(offset);
				targets.push(`${addressType === 0x03 ? "name" : "ip"}:${host}:${port}`);

				const upstream = tcpConnect(port, host, () => {
					// success, BND.ADDR 0.0.0.0:0
					client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
					upstream.pipe(client);
					client.pipe(upstream);
				});
				upstream.on("error", () => client.destroy());
			});
		});
		client.on("error", () => {});
	});

	return {
		server,
		targets,
		listen: () =>
			new Promise((resolve) => {
				server.listen(0, "127.0.0.1", () => {
					const address = server.address();
					resolve(typeof address === "object" && address ? address.port : 0);
				});
			}),
	};
}

function createOriginServer(): { server: Server; listen: () => Promise<number> } {
	const server = createHttpServer((_req, res) => {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ tunneled: true }));
	});
	return {
		server,
		listen: () =>
			new Promise((resolve) => {
				server.listen(0, "127.0.0.1", () => {
					const address = server.address();
					resolve(typeof address === "object" && address ? address.port : 0);
				});
			}),
	};
}

describe("SOCKS5 tunneling", () => {
	test("routes fetch through a SOCKS5 proxy and resolves the target remotely", async () => {
		const socks = createSocks5Server();
		const origin = createOriginServer();
		const socksPort = await socks.listen();
		const originPort = await origin.listen();

		clearProxyEnv();
		applyHttpProxySettings(`socks5h://127.0.0.1:${socksPort}`);
		configureHttpDispatcher();

		try {
			const response = await fetch(`http://localhost:${originPort}/ping`);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ tunneled: true });
			// Hostname (not a pre-resolved IP) reached the proxy: DNS stays inside the tunnel.
			expect(socks.targets).toEqual([`name:localhost:${originPort}`]);
		} finally {
			socks.server.close();
			origin.server.close();
			clearProxyEnv();
			configureHttpDispatcher();
		}
	});

	// Regression: undici's Socks5ProxyAgent creates its own Pool and drops the agent-level
	// bodyTimeout/headersTimeout, so without per-request options a stalled tunnel hangs forever.
	test("applies the idle timeout to stalled SOCKS5 connections", async () => {
		const socks = createSocks5Server();
		const stalling = createHttpServer(() => {
			// Accept the request and never respond.
		});
		const socksPort = await socks.listen();
		const stallingPort = await new Promise<number>((resolve) => {
			stalling.listen(0, "127.0.0.1", () => {
				const address = stalling.address();
				resolve(typeof address === "object" && address ? address.port : 0);
			});
		});

		clearProxyEnv();
		applyHttpProxySettings(`socks5://127.0.0.1:${socksPort}`);
		configureHttpDispatcher(1000);

		try {
			const started = Date.now();
			await expect(fetch(`http://localhost:${stallingPort}/hang`)).rejects.toThrow();
			expect(Date.now() - started).toBeLessThan(15_000);
		} finally {
			socks.server.close();
			stalling.close();
			clearProxyEnv();
			configureHttpDispatcher();
		}
	});
});
