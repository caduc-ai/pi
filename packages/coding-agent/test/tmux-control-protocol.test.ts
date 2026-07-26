import { describe, expect, it } from "vitest";
import {
	TmuxControlParser,
	type TmuxOutputNotification,
	type TmuxReplyNotification,
	unescapeOutput,
} from "../src/core/terminal/control-protocol.ts";
import { chunkHexArgs, parseTmuxVersion, toSendKeysHex } from "../src/core/terminal/tmux-cli.ts";

function outputs(notifications: ReturnType<TmuxControlParser["push"]>): TmuxOutputNotification[] {
	return notifications.filter((n): n is TmuxOutputNotification => n.kind === "output");
}

describe("unescapeOutput", () => {
	it("decodes octal escapes to raw bytes", () => {
		expect(unescapeOutput("hi\\015\\012")).toEqual(Buffer.from([0x68, 0x69, 0x0d, 0x0a]));
	});

	it("decodes an escaped backslash without consuming following digits", () => {
		// \\015 is a literal backslash followed by the characters 0,1,5
		expect(unescapeOutput("\\\\015").toString("utf8")).toBe("\\015");
	});

	it("reassembles a multi-byte UTF-8 character split across escapes", () => {
		// U+2603 SNOWMAN is e2 98 83
		expect(unescapeOutput("\\342\\230\\203").toString("utf8")).toBe("☃");
	});

	it("passes literal non-ASCII through as UTF-8 bytes", () => {
		expect(unescapeOutput("héllo ☃").toString("utf8")).toBe("héllo ☃");
	});

	it("preserves a lone trailing backslash instead of dropping data", () => {
		expect(unescapeOutput("end\\").toString("utf8")).toBe("end\\");
	});

	it("decodes escape sequences used by real terminal output", () => {
		expect(unescapeOutput("\\033[1;31mred\\033[0m").toString("utf8")).toBe("\u001b[1;31mred\u001b[0m");
	});

	it("returns an empty buffer for empty input", () => {
		expect(unescapeOutput("")).toEqual(Buffer.alloc(0));
	});
});

describe("TmuxControlParser", () => {
	it("parses an %output notification", () => {
		const parser = new TmuxControlParser();
		const result = outputs(parser.push("%output %0 hello\\015\\012\n"));
		expect(result).toHaveLength(1);
		expect(result[0].pane).toBe("%0");
		expect(result[0].data.toString("utf8")).toBe("hello\r\n");
	});

	it("keeps payload spaces intact", () => {
		const parser = new TmuxControlParser();
		const result = outputs(parser.push("%output %0 a b  c\n"));
		expect(result[0].data.toString("utf8")).toBe("a b  c");
	});

	it("buffers a line split across chunks", () => {
		const parser = new TmuxControlParser();
		expect(outputs(parser.push("%output %0 par"))).toHaveLength(0);
		const result = outputs(parser.push("tial\n"));
		expect(result[0].data.toString("utf8")).toBe("partial");
	});

	it("handles several notifications in one chunk", () => {
		const parser = new TmuxControlParser();
		const result = outputs(parser.push("%output %0 one\n%output %0 two\n"));
		expect(result.map((n) => n.data.toString("utf8"))).toEqual(["one", "two"]);
	});

	it("groups a %begin/%end block into one reply", () => {
		const parser = new TmuxControlParser();
		const notifications = parser.push("%begin 123 7 1\nline-a\nline-b\n%end 123 7 1\n");
		const replies = notifications.filter((n): n is TmuxReplyNotification => n.kind === "reply");
		expect(replies).toHaveLength(1);
		expect(replies[0].commandId).toBe("7");
		expect(replies[0].lines).toEqual(["line-a", "line-b"]);
		expect(replies[0].isError).toBe(false);
	});

	it("marks a %error block as an error reply", () => {
		const parser = new TmuxControlParser();
		const notifications = parser.push("%begin 1 2 1\nno such session\n%error 1 2 1\n");
		const replies = notifications.filter((n): n is TmuxReplyNotification => n.kind === "reply");
		expect(replies[0].isError).toBe(true);
		expect(replies[0].lines).toEqual(["no such session"]);
	});

	it("does not treat %output inside a reply block as pane output", () => {
		const parser = new TmuxControlParser();
		const notifications = parser.push("%begin 1 2 1\n%output %0 not-really\n%end 1 2 1\n");
		expect(outputs(notifications)).toHaveLength(0);
		const replies = notifications.filter((n): n is TmuxReplyNotification => n.kind === "reply");
		expect(replies[0].lines).toEqual(["%output %0 not-really"]);
	});

	it("reports %exit with and without a reason", () => {
		expect(new TmuxControlParser().push("%exit\n")).toEqual([{ kind: "exit", reason: undefined }]);
		expect(new TmuxControlParser().push("%exit server-exited\n")).toEqual([
			{ kind: "exit", reason: "server-exited" },
		]);
	});

	it("classifies unknown notifications as other", () => {
		const parser = new TmuxControlParser();
		expect(parser.push("%sessions-changed\n")).toEqual([{ kind: "other", line: "%sessions-changed" }]);
	});

	it("tolerates CRLF line endings", () => {
		const parser = new TmuxControlParser();
		const result = outputs(parser.push("%output %0 hi\r\n"));
		expect(result[0].data.toString("utf8")).toBe("hi");
	});

	it("parses a realistic startup transcript", () => {
		const parser = new TmuxControlParser();
		const transcript = [
			"%begin 1785073777 278 0",
			"%end 1785073777 278 0",
			"%window-add @0",
			"%sessions-changed",
			"%session-changed $0 cctest",
			"%output %0 \\033[?2004hbash-5.1$ ",
			"%output %0 echo HELLO\\015\\012\\033[?2004l\\015",
			"%output %0 HELLO\\015\\012",
			"%exit",
		].join("\n");
		const notifications = parser.push(`${transcript}\n`);
		expect(outputs(notifications).map((n) => n.data.toString("utf8"))).toEqual([
			"\u001b[?2004hbash-5.1$ ",
			"echo HELLO\r\n\u001b[?2004l\r",
			"HELLO\r\n",
		]);
		expect(notifications.some((n) => n.kind === "exit")).toBe(true);
	});
});

describe("send-keys hex encoding", () => {
	it("encodes bytes as zero-padded hex pairs", () => {
		expect(toSendKeysHex(Buffer.from([0x03, 0x1b, 0x0d]))).toEqual(["03", "1b", "0d"]);
	});

	it("encodes multi-byte UTF-8 as one pair per byte", () => {
		expect(toSendKeysHex(Buffer.from("☃", "utf8"))).toEqual(["e2", "98", "83"]);
	});

	it("chunks hex pairs to stay clear of argv limits", () => {
		const hex = toSendKeysHex(Buffer.alloc(1100, 0x61));
		const chunks = chunkHexArgs(hex, 512);
		expect(chunks.map((c) => c.length)).toEqual([512, 512, 76]);
		expect(chunks.flat()).toEqual(hex);
	});

	it("returns no chunks for empty input", () => {
		expect(chunkHexArgs([])).toEqual([]);
	});
});

describe("parseTmuxVersion", () => {
	it("parses release and suffixed versions", () => {
		expect(parseTmuxVersion("tmux 3.2a")).toBe(3.2);
		expect(parseTmuxVersion("tmux 3.4")).toBe(3.4);
		expect(parseTmuxVersion("tmux next-3.5")).toBe(3.5);
	});

	it("returns undefined when no version is present", () => {
		expect(parseTmuxVersion("tmux")).toBeUndefined();
	});
});
