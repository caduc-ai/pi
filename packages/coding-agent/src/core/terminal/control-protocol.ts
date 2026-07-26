/**
 * tmux control mode (`tmux -C`) protocol parsing.
 *
 * Control mode emits one notification per line. The lines we care about:
 *
 *   %output %0 <escaped-pane-bytes>
 *   %begin <ts> <cmd-id> <flags>   ... command reply lines ...   %end/%error <ts> <cmd-id> <flags>
 *   %exit [reason]
 *
 * Everything else (%window-add, %layout-change, %sessions-changed, ...) is
 * informational for our purposes.
 */

/** Pane output bytes. `data` is raw terminal bytes, already unescaped. */
export interface TmuxOutputNotification {
	kind: "output";
	pane: string;
	data: Buffer;
}

/** A completed command reply, correlated by the id tmux echoed in %begin. */
export interface TmuxReplyNotification {
	kind: "reply";
	commandId: string;
	/** Reply body lines, without a trailing newline. */
	lines: string[];
	/** True when the block terminated with %error rather than %end. */
	isError: boolean;
}

/** The tmux server or session went away. */
export interface TmuxExitNotification {
	kind: "exit";
	reason: string | undefined;
}

/** Any other notification, surfaced for logging without being interpreted. */
export interface TmuxOtherNotification {
	kind: "other";
	line: string;
}

export type TmuxNotification =
	| TmuxOutputNotification
	| TmuxReplyNotification
	| TmuxExitNotification
	| TmuxOtherNotification;

/**
 * Decode the escaping tmux applies to %output payloads.
 *
 * tmux writes non-printable bytes as three-digit octal escapes (\015) and
 * escapes backslash as \\. Decoding to a Buffer rather than a string is
 * required: a multi-byte UTF-8 character arrives as several escaped bytes and
 * must be reassembled before any text decoding.
 */
export function unescapeOutput(payload: string): Buffer {
	const bytes: number[] = [];
	for (let index = 0; index < payload.length; index++) {
		const char = payload[index];
		if (char !== "\\") {
			// Non-ASCII can appear literally; re-encode it as UTF-8 bytes.
			const code = payload.codePointAt(index) as number;
			if (code < 0x80) {
				bytes.push(code);
			} else {
				const encoded = Buffer.from(String.fromCodePoint(code), "utf8");
				for (const byte of encoded) bytes.push(byte);
				// Advance past a surrogate pair's low half.
				if (code > 0xffff) index++;
			}
			continue;
		}

		const next = payload[index + 1];
		if (next === "\\") {
			bytes.push(0x5c);
			index++;
			continue;
		}
		// Three octal digits, per tmux's output escaping.
		if (next !== undefined && next >= "0" && next <= "7") {
			const octal = payload.slice(index + 1, index + 4);
			if (octal.length === 3 && /^[0-7]{3}$/.test(octal)) {
				bytes.push(Number.parseInt(octal, 8) & 0xff);
				index += 3;
				continue;
			}
		}
		// Lone backslash: pass through rather than dropping data.
		bytes.push(0x5c);
	}
	return Buffer.from(bytes);
}

/**
 * Incremental line-oriented parser for a `tmux -C` stdout stream.
 *
 * Buffers partial lines across chunk boundaries and groups %begin/%end blocks
 * into single reply notifications.
 */
export class TmuxControlParser {
	private buffer = "";
	private pendingReply: { commandId: string; lines: string[] } | undefined;

	/** Feed a stdout chunk, returning every notification it completed. */
	push(chunk: string): TmuxNotification[] {
		this.buffer += chunk;
		const notifications: TmuxNotification[] = [];

		for (;;) {
			const newlineIndex = this.buffer.indexOf("\n");
			if (newlineIndex === -1) break;
			let line = this.buffer.slice(0, newlineIndex);
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			const notification = this.parseLine(line);
			if (notification) notifications.push(notification);
		}

		return notifications;
	}

	private parseLine(line: string): TmuxNotification | undefined {
		// Inside a %begin block every line is reply body until %end/%error.
		if (this.pendingReply) {
			if (line.startsWith("%end ") || line.startsWith("%error ")) {
				const isError = line.startsWith("%error ");
				const reply: TmuxReplyNotification = {
					kind: "reply",
					commandId: this.pendingReply.commandId,
					lines: this.pendingReply.lines,
					isError,
				};
				this.pendingReply = undefined;
				return reply;
			}
			this.pendingReply.lines.push(line);
			return undefined;
		}

		if (line.startsWith("%output ")) {
			// %output %<pane> <data>; data may contain spaces, so split twice only.
			const rest = line.slice("%output ".length);
			const separator = rest.indexOf(" ");
			if (separator === -1) {
				return { kind: "output", pane: rest, data: Buffer.alloc(0) };
			}
			return {
				kind: "output",
				pane: rest.slice(0, separator),
				data: unescapeOutput(rest.slice(separator + 1)),
			};
		}

		if (line.startsWith("%begin ")) {
			// %begin <timestamp> <command-id> <flags>
			const parts = line.split(" ");
			this.pendingReply = { commandId: parts[2] ?? "", lines: [] };
			return undefined;
		}

		if (line.startsWith("%exit")) {
			const reason = line.slice("%exit".length).trim();
			return { kind: "exit", reason: reason || undefined };
		}

		if (line.length === 0) return undefined;
		return { kind: "other", line };
	}
}
