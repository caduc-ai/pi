import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core.js";
import bash from "highlight.js/lib/languages/bash.js";
import c from "highlight.js/lib/languages/c.js";
import cpp from "highlight.js/lib/languages/cpp.js";
import csharp from "highlight.js/lib/languages/csharp.js";
import css from "highlight.js/lib/languages/css.js";
import diff from "highlight.js/lib/languages/diff.js";
import dockerfile from "highlight.js/lib/languages/dockerfile.js";
import go from "highlight.js/lib/languages/go.js";
import ini from "highlight.js/lib/languages/ini.js";
import java from "highlight.js/lib/languages/java.js";
import javascript from "highlight.js/lib/languages/javascript.js";
import json from "highlight.js/lib/languages/json.js";
import kotlin from "highlight.js/lib/languages/kotlin.js";
import lua from "highlight.js/lib/languages/lua.js";
import makefile from "highlight.js/lib/languages/makefile.js";
import markdownLang from "highlight.js/lib/languages/markdown.js";
import objectivec from "highlight.js/lib/languages/objectivec.js";
import perl from "highlight.js/lib/languages/perl.js";
import php from "highlight.js/lib/languages/php.js";
import plaintext from "highlight.js/lib/languages/plaintext.js";
import python from "highlight.js/lib/languages/python.js";
import ruby from "highlight.js/lib/languages/ruby.js";
import rust from "highlight.js/lib/languages/rust.js";
import scss from "highlight.js/lib/languages/scss.js";
import shell from "highlight.js/lib/languages/shell.js";
import sql from "highlight.js/lib/languages/sql.js";
import swift from "highlight.js/lib/languages/swift.js";
import typescript from "highlight.js/lib/languages/typescript.js";
import xml from "highlight.js/lib/languages/xml.js";
import yaml from "highlight.js/lib/languages/yaml.js";
import { Marked, type Tokens } from "marked";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("scss", scss);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("go", go);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("lua", lua);
hljs.registerLanguage("makefile", makefile);
hljs.registerLanguage("markdown", markdownLang);
hljs.registerLanguage("objectivec", objectivec);
hljs.registerLanguage("perl", perl);
hljs.registerLanguage("php", php);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const marked = new Marked({
	gfm: true,
	breaks: false,
	renderer: {
		code({ text, lang }: Tokens.Code): string {
			const language = lang && hljs.getLanguage(lang) ? lang : undefined;
			const highlighted = language
				? hljs.highlight(text, { language, ignoreIllegals: true }).value
				: escapeHtml(text);
			return `<pre class="codeblock"><code class="hljs">${highlighted}</code></pre>`;
		},
	},
});

export function renderMarkdown(source: string): string {
	const html = marked.parse(source, { async: false });
	return DOMPurify.sanitize(html);
}
