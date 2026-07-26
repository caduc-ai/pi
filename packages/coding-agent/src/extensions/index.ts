import type { InlineExtension } from "../core/extensions/types.ts";
import claudeBridgeExtension from "./claude-bridge/index.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "claude-bridge", factory: claudeBridgeExtension, hidden: true },
];
