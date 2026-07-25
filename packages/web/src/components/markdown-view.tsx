import { useMemo } from "preact/hooks";
import { renderMarkdown } from "../markdown.ts";

export function MarkdownView({ text }: { text: string }) {
	const html = useMemo(() => renderMarkdown(text), [text]);
	return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
