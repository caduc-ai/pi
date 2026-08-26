/**
 * Clipboard helpers for the chat view.
 *
 * navigator.clipboard requires a secure context; the pi web UI is commonly
 * served over plain HTTP on a LAN/tailnet address, so a hidden-textarea
 * execCommand fallback is kept for insecure origins.
 */

export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// Fall through to the legacy path.
	}
	try {
		const textarea = document.createElement("textarea");
		textarea.value = text;
		textarea.style.position = "fixed";
		textarea.style.opacity = "0";
		document.body.appendChild(textarea);
		textarea.select();
		const ok = document.execCommand("copy");
		textarea.remove();
		return ok;
	} catch {
		return false;
	}
}

/**
 * Copy buttons inside rendered markdown (code blocks) are plain HTML injected
 * by markdown.ts, not preact components, so they are handled with one
 * delegated listener instead of per-render wiring.
 */
export function installCodeblockCopy(): void {
	document.addEventListener("click", (event) => {
		const target = event.target as HTMLElement | null;
		const button = target?.closest?.(".codeblock-copy") as HTMLElement | null;
		if (!button) return;
		const code = button.closest(".codeblock-wrap")?.querySelector("code");
		if (!code) return;
		void copyText(code.textContent ?? "").then((ok) => {
			button.textContent = ok ? "copied" : "failed";
			window.setTimeout(() => {
				button.textContent = "copy";
			}, 1200);
		});
	});
}
