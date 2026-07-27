/**
 * RPC session bridge: speaks the pi RPC protocol (docs/rpc.md) on behalf of an
 * AgentSessionRuntime, fanning events out to any number of attached clients.
 *
 * Used by RPC mode (a single stdout client, see rpc-mode.ts) and by web mode
 * (one client per WebSocket connection, see src/web/).
 *
 * - Session events and extension UI requests are broadcast to all clients.
 * - Command responses are sent only to the requesting client.
 * - Extension UI dialogs are first-response-wins: when one client answers, all
 *   other clients receive `extension_ui_cancel` for that request id.
 */

import * as crypto from "node:crypto";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import {
	disposeTerminal,
	getExistingTerminal,
	getOrCreateTerminal,
	type TmuxTerminal,
} from "../../core/terminal/index.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import {
	RPC_BUILTIN_COMMANDS,
	type RpcCommand,
	type RpcExtensionUICancel,
	type RpcExtensionUIRequest,
	type RpcExtensionUIResponse,
	type RpcResponse,
	type RpcSessionState,
	type RpcSlashCommand,
} from "./rpc-types.ts";

export interface RpcClientConnection {
	/** Send an outbound protocol message (event, response, or extension UI message) to this client. */
	send(message: object): void;
	/** Optional backpressure: resolves when this client is ready to accept more data. */
	drain?(): Promise<void>;
}

export interface RpcClientHandle {
	/** Handle one inbound JSON protocol line from this client. */
	receive(line: string): Promise<void>;
	/** Detach the client. No further messages are sent to it. */
	detach(): void;
}

export interface RpcBridgeCallbacks {
	/** An extension requested shutdown via its shutdown handler. */
	onShutdownRequested?(): void;
}

export interface RpcBridgeOptions {
	/**
	 * Bind extensions with the RPC UI context (default true). Set false when
	 * another frontend (e.g. the TUI) owns the extension UI context; dialogs
	 * can then still be offered to RPC clients via offerDialog().
	 */
	bindExtensions?: boolean;
}

function success<T extends RpcCommand["type"]>(id: string | undefined, command: T, data?: object | null): RpcResponse {
	if (data === undefined) {
		return { id, type: "response", command, success: true } as RpcResponse;
	}
	return { id, type: "response", command, success: true, data } as RpcResponse;
}

function error(id: string | undefined, command: string, message: string): RpcResponse {
	return { id, type: "response", command, success: false, error: message };
}

export class RpcBridge {
	private readonly runtimeHost: AgentSessionRuntime;
	private readonly callbacks: RpcBridgeCallbacks;
	private session: AgentSessionRuntime["session"];
	private readonly clients = new Set<RpcClientConnection>();
	private readonly pendingExtensionRequests = new Map<
		string,
		{ resolve: (response: RpcExtensionUIResponse) => void; reject: (error: Error) => void }
	>();
	private unsubscribe: (() => void) | undefined;
	private unsubscribeBackpressure: (() => void) | undefined;
	/**
	 * Terminal output subscription. The terminal itself is process-scoped and
	 * deliberately outside the session graph, so rebindSession() must not touch it.
	 */
	private unsubscribeTerminal: (() => void) | undefined;

	private readonly options: RpcBridgeOptions;

	constructor(runtimeHost: AgentSessionRuntime, callbacks: RpcBridgeCallbacks = {}, options: RpcBridgeOptions = {}) {
		this.runtimeHost = runtimeHost;
		this.callbacks = callbacks;
		this.options = options;
		this.session = runtimeHost.session;
	}

	get clientCount(): number {
		return this.clients.size;
	}

	async start(): Promise<void> {
		if (this.options.bindExtensions !== false) {
			this.runtimeHost.setRebindSession(async () => {
				await this.rebindSession();
			});
		}
		await this.rebindSession();
	}

	async dispose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribeBackpressure?.();
		this.unsubscribeTerminal?.();
		this.unsubscribeTerminal = undefined;
		this.clients.clear();
		// The terminal is scoped to the pi run; a graceful shutdown ends it so a
		// tmux session is not leaked per run.
		await disposeTerminal();
	}

	/**
	 * Stream terminal output to all clients. Attached once per terminal, not per
	 * client: every client shares the one terminal, like `tmux attach`.
	 */
	private attachTerminalStream(terminal: TmuxTerminal): void {
		if (this.unsubscribeTerminal) return;
		const unsubscribeOutput = terminal.subscribe((data) => {
			this.broadcast({ type: "terminal_output", data: data.toString("base64") });
		});
		const unsubscribeExit = terminal.onExit((reason) => {
			this.broadcast({ type: "terminal_exit", reason });
			this.unsubscribeTerminal?.();
			this.unsubscribeTerminal = undefined;
		});
		this.unsubscribeTerminal = () => {
			unsubscribeOutput();
			unsubscribeExit();
		};
	}

	attachClient(connection: RpcClientConnection): RpcClientHandle {
		this.clients.add(connection);
		return {
			receive: (line) => this.handleInputLine(connection, line),
			detach: () => {
				this.clients.delete(connection);
			},
		};
	}

	private broadcast(message: object, except?: RpcClientConnection): void {
		for (const client of this.clients) {
			if (client !== except) {
				client.send(message);
			}
		}
	}

	private broadcastCancel(id: string, except?: RpcClientConnection): void {
		const message: RpcExtensionUICancel = { type: "extension_ui_cancel", id };
		this.broadcast(message, except);
	}

	/** Helper for dialog methods with signal/timeout support */
	private createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				this.pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				this.broadcastCancel(id);
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					this.broadcastCancel(id);
					resolve(defaultValue);
				}, opts.timeout);
			}

			this.pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			this.broadcast({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	private createExtensionUIContext(): ExtensionUIContext {
		const bridge = this;
		return {
			select: (title, options, opts) =>
				this.createDialogPromise(
					opts,
					undefined,
					{ method: "select", title, options, timeout: opts?.timeout },
					(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
				),

			confirm: (title, message, opts) =>
				this.createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
					"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
				),

			input: (title, placeholder, opts) =>
				this.createDialogPromise(
					opts,
					undefined,
					{ method: "input", title, placeholder, timeout: opts?.timeout },
					(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
				),

			notify(message: string, type?: "info" | "warning" | "error"): void {
				// Fire and forget - no response needed
				bridge.broadcast({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "notify",
					message,
					notifyType: type,
				} as RpcExtensionUIRequest);
			},

			onTerminalInput(): () => void {
				// Raw terminal input not supported over RPC
				return () => {};
			},

			setStatus(key: string, text: string | undefined): void {
				// Fire and forget - no response needed
				bridge.broadcast({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setStatus",
					statusKey: key,
					statusText: text,
				} as RpcExtensionUIRequest);
			},

			setWorkingMessage(_message?: string): void {
				// Working message not supported over RPC - requires TUI loader access
			},

			setWorkingVisible(_visible: boolean): void {
				// Working visibility not supported over RPC - requires TUI loader access
			},

			setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
				// Working indicator customization not supported over RPC - requires TUI loader access
			},

			setHiddenThinkingLabel(_label?: string): void {
				// Hidden thinking label not supported over RPC - requires TUI message rendering access
			},

			setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
				// Only support string arrays over RPC - factory functions are ignored
				if (content === undefined || Array.isArray(content)) {
					bridge.broadcast({
						type: "extension_ui_request",
						id: crypto.randomUUID(),
						method: "setWidget",
						widgetKey: key,
						widgetLines: content as string[] | undefined,
						widgetPlacement: options?.placement,
					} as RpcExtensionUIRequest);
				}
				// Component factories are not supported over RPC - would need TUI access
			},

			setFooter(_factory: unknown): void {
				// Custom footer not supported over RPC - requires TUI access
			},

			setHeader(_factory: unknown): void {
				// Custom header not supported over RPC - requires TUI access
			},

			setTitle(title: string): void {
				// Fire and forget - host can implement terminal title control
				bridge.broadcast({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setTitle",
					title,
				} as RpcExtensionUIRequest);
			},

			async custom() {
				// Custom UI not supported over RPC
				return undefined as never;
			},

			pasteToEditor(text: string): void {
				// Paste handling not supported over RPC - falls back to setEditorText
				this.setEditorText(text);
			},

			setEditorText(text: string): void {
				// Fire and forget - host can implement editor control
				bridge.broadcast({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "set_editor_text",
					text,
				} as RpcExtensionUIRequest);
			},

			getEditorText(): string {
				// Synchronous method can't wait for RPC response
				// Host should track editor state locally if needed
				return "";
			},

			async editor(title: string, prefill?: string): Promise<string | undefined> {
				const id = crypto.randomUUID();
				return new Promise((resolve, reject) => {
					bridge.pendingExtensionRequests.set(id, {
						resolve: (response: RpcExtensionUIResponse) => {
							if ("cancelled" in response && response.cancelled) {
								resolve(undefined);
							} else if ("value" in response) {
								resolve(response.value);
							} else {
								resolve(undefined);
							}
						},
						reject,
					});
					bridge.broadcast({
						type: "extension_ui_request",
						id,
						method: "editor",
						title,
						prefill,
					} as RpcExtensionUIRequest);
				});
			},

			addAutocompleteProvider(): void {
				// Autocomplete provider composition is not supported over RPC
			},

			setEditorComponent(): void {
				// Custom editor components not supported over RPC
			},

			getEditorComponent() {
				// Custom editor components not supported over RPC
				return undefined;
			},

			get theme() {
				return theme;
			},

			getAllThemes() {
				return [];
			},

			getTheme(_name: string) {
				return undefined;
			},

			setTheme(_theme: string | Theme) {
				// Theme switching not supported over RPC
				return { success: false, error: "Theme switching not supported over RPC" };
			},

			getToolsExpanded() {
				// Tool expansion not supported over RPC - no TUI
				return false;
			},

			setToolsExpanded(_expanded: boolean) {
				// Tool expansion not supported over RPC - no TUI
			},
		};
	}

	async rebindSession(): Promise<void> {
		this.session = this.runtimeHost.session;
		const session = this.session;
		if (this.options.bindExtensions === false) {
			this.resubscribe(session);
			return;
		}
		await session.bindExtensions({
			uiContext: this.createExtensionUIContext(),
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (options) => this.runtimeHost.newSession(options),
				fork: async (entryId, forkOptions) => {
					const result = await this.runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					return this.runtimeHost.switchSession(sessionPath, options);
				},
				reload: async () => {
					await session.reload();
				},
			},
			shutdownHandler: () => {
				this.callbacks.onShutdownRequested?.();
			},
			onError: (err) => {
				this.broadcast({
					type: "extension_error",
					extensionPath: err.extensionPath,
					event: err.event,
					error: err.error,
				});
			},
		});

		this.resubscribe(session);
	}

	private resubscribe(session: AgentSessionRuntime["session"]): void {
		this.unsubscribe?.();
		this.unsubscribeBackpressure?.();
		this.unsubscribe = session.subscribe((event) => {
			this.broadcast(event);
		});
		this.unsubscribeBackpressure = session.agent.subscribe(async () => {
			const drains: Promise<void>[] = [];
			for (const client of this.clients) {
				if (client.drain) drains.push(client.drain());
			}
			await Promise.all(drains);
		});
	}

	/**
	 * Offer a dialog to all attached clients. First response wins; other clients
	 * are cancelled automatically by the response path. Used when the extension
	 * UI context is owned elsewhere (e.g. the TUI) and dialogs are multiplexed.
	 */
	offerDialog(request: Record<string, unknown>, onResponse: (response: RpcExtensionUIResponse) => void): string {
		const id = crypto.randomUUID();
		this.pendingExtensionRequests.set(id, { resolve: onResponse, reject: () => {} });
		this.broadcast({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		return id;
	}

	/** Dismiss a dialog previously offered via offerDialog on all clients (e.g. answered locally). */
	dismissDialog(id: string): void {
		this.pendingExtensionRequests.delete(id);
		this.broadcastCancel(id);
	}

	/** Broadcast a fire-and-forget extension UI request (notify, setStatus, setWidget, ...). */
	broadcastUiRequest(request: Record<string, unknown>): void {
		this.broadcast({ type: "extension_ui_request", id: crypto.randomUUID(), ...request } as RpcExtensionUIRequest);
	}

	private async handleCommand(command: RpcCommand, client: RpcClientConnection): Promise<RpcResponse | undefined> {
		const id = command.id;
		const session = this.session;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Start prompt handling immediately, but emit the authoritative response only after
				// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
				let preflightSucceeded = false;
				void session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
						preflightResult: (didSucceed) => {
							if (didSucceed) {
								preflightSucceeded = true;
								client.send(success(id, "prompt"));
							}
						},
					})
					.catch((e) => {
						if (!preflightSucceeded) {
							client.send(error(id, "prompt", e.message));
						}
					});
				return undefined;
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await this.runtimeHost.newSession(options);
				if (!result.cancelled) {
					await this.rebindSession();
				}
				return success(id, "new_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					cwd: session.sessionManager.getCwd(),
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
				};
				return success(id, "get_state", state);
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = await session.modelRuntime.getAvailable();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = await session.modelRuntime.getAvailable();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			case "get_available_thinking_levels": {
				const levels = session.getAvailableThinkingLevels();
				return success(id, "get_available_thinking_levels", { levels });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext,
					id,
				});
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Terminal
			//
			// A persistent interactive shell, separate from `bash` above: it keeps
			// cwd, environment and running processes across commands, and its output
			// never enters session history or the model's context.
			// =================================================================

			case "terminal_open": {
				try {
					const terminal = await getOrCreateTerminal({
						cwd: session.sessionManager.getCwd(),
						cols: command.cols,
						rows: command.rows,
					});
					// Resize to this client's viewport; last writer wins across clients.
					if (command.cols !== undefined && command.rows !== undefined) {
						await terminal.resize(command.cols, command.rows);
					}
					this.attachTerminalStream(terminal);
					// Replay scrollback so a reconnecting client sees a coherent screen.
					const replay = await terminal.captureReplay();
					const { cols, rows } = terminal.size;
					return success(id, "terminal_open", {
						termId: terminal.id,
						cols,
						rows,
						replay: Buffer.from(replay, "utf8").toString("base64"),
					});
				} catch (e) {
					return error(id, "terminal_open", e instanceof Error ? e.message : String(e));
				}
			}

			case "terminal_input": {
				const terminal = getExistingTerminal();
				if (!terminal) {
					return error(id, "terminal_input", "No terminal is open");
				}
				await terminal.write(Buffer.from(command.data, "base64"));
				return success(id, "terminal_input");
			}

			case "terminal_resize": {
				const terminal = getExistingTerminal();
				if (!terminal) {
					return error(id, "terminal_resize", "No terminal is open");
				}
				await terminal.resize(command.cols, command.rows);
				return success(id, "terminal_resize");
			}

			case "terminal_close": {
				this.unsubscribeTerminal?.();
				this.unsubscribeTerminal = undefined;
				await disposeTerminal();
				return success(id, "terminal_close");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const result = await this.runtimeHost.switchSession(command.sessionPath);
				if (!result.cancelled) {
					await this.rebindSession();
				}
				return success(id, "switch_session", result);
			}

			case "change_cwd": {
				try {
					const result = await this.runtimeHost.changeCwd(command.cwd);
					if (!result.cancelled) {
						await this.rebindSession();
					}
					return success(id, "change_cwd", result);
				} catch (e) {
					return error(id, "change_cwd", e instanceof Error ? e.message : String(e));
				}
			}

			case "fork": {
				const result = await this.runtimeHost.fork(command.entryId);
				if (!result.cancelled) {
					await this.rebindSession();
				}
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				const result = await this.runtimeHost.fork(leafId, { position: "at" });
				if (!result.cancelled) {
					await this.rebindSession();
				}
				return success(id, "clone", { cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_entries": {
				const sessionManager = session.sessionManager;
				let entries = sessionManager.getEntries();
				if (command.since !== undefined) {
					const sinceIndex = entries.findIndex((e) => e.id === command.since);
					if (sinceIndex === -1) {
						return error(id, "get_entries", `Entry not found: ${command.since}`);
					}
					entries = entries.slice(sinceIndex + 1);
				}
				return success(id, "get_entries", { entries, leafId: sessionManager.getLeafId() });
			}

			case "get_tree": {
				const sessionManager = session.sessionManager;
				return success(id, "get_tree", { tree: sessionManager.getTree(), leafId: sessionManager.getLeafId() });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				for (const command of session.extensionRunner.getRegisteredCommands()) {
					commands.push({
						name: command.invocationName,
						description: command.description,
						source: "extension",
						sourceInfo: command.sourceInfo,
					});
				}

				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}

				for (const builtin of RPC_BUILTIN_COMMANDS) {
					commands.push({ ...builtin, source: "builtin" });
				}

				return success(id, "get_commands", { commands });
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	}

	private async handleInputLine(client: RpcClientConnection, line: string): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			client.send(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			await client.drain?.();
			return;
		}

		// Handle extension UI responses (first response wins, others are cancelled)
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			const response = parsed as RpcExtensionUIResponse;
			const pending = this.pendingExtensionRequests.get(response.id);
			if (pending) {
				this.pendingExtensionRequests.delete(response.id);
				pending.resolve(response);
				this.broadcastCancel(response.id, client);
			}
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await this.handleCommand(command, client);
			if (response) {
				client.send(response);
				await client.drain?.();
			}
		} catch (commandError: unknown) {
			client.send(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
			await client.drain?.();
		}
	}
}
