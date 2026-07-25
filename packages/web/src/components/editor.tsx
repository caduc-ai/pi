import { computed, signal } from "@preact/signals";
import { useRef } from "preact/hooks";
import type { ImageContent } from "../protocol.ts";
import {
	editorText,
	pushToast,
	queue,
	sendAbort,
	sendPrompt,
	sessionState,
	slashCommands,
	workingMessage,
} from "../state.ts";

const pendingImages = signal<ImageContent[]>([]);
const autocompleteIndex = signal(0);
const autocompleteDismissed = signal(false);
const sending = signal(false);

const autocompleteQuery = computed(() => {
	const text = editorText.value;
	if (!text.startsWith("/") || text.includes(" ") || autocompleteDismissed.value) {
		return undefined;
	}
	return text.slice(1).toLowerCase();
});

const autocompleteMatches = computed(() => {
	const query = autocompleteQuery.value;
	if (query === undefined) return [];
	return slashCommands.value.filter((command) => command.name.toLowerCase().startsWith(query)).slice(0, 8);
});

const autocompleteOpen = computed(() => autocompleteMatches.value.length > 0);

const isBusy = computed(() => sessionState.value?.isStreaming === true || workingMessage.value !== undefined);

function readFileAsImage(file: File): Promise<ImageContent> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = String(reader.result);
			const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
			resolve({ type: "image", data: base64, mimeType: file.type || "image/png" });
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

async function send(): Promise<void> {
	const text = editorText.value.trim();
	const images = pendingImages.value;
	if (sending.value || (text === "" && images.length === 0)) return;
	if (text === "") return;
	sending.value = true;
	editorText.value = "";
	pendingImages.value = [];
	autocompleteDismissed.value = false;
	try {
		await sendPrompt(text, images);
	} catch (error) {
		pushToast(error instanceof Error ? error.message : String(error), "error");
	} finally {
		sending.value = false;
	}
}

export function Editor() {
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const autoGrow = () => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
	};

	const handleKeyDown = (event: KeyboardEvent) => {
		if (autocompleteOpen.value) {
			const matches = autocompleteMatches.value;
			if (event.key === "ArrowDown") {
				event.preventDefault();
				autocompleteIndex.value = (autocompleteIndex.value + 1) % matches.length;
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				autocompleteIndex.value = (autocompleteIndex.value - 1 + matches.length) % matches.length;
				return;
			}
			if (event.key === "Tab" || event.key === "Enter") {
				event.preventDefault();
				const selected = matches[Math.min(autocompleteIndex.value, matches.length - 1)];
				if (selected) {
					editorText.value = `/${selected.name} `;
					autocompleteDismissed.value = true;
					autoGrow();
				}
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				autocompleteDismissed.value = true;
				return;
			}
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void send();
			return;
		}
		if (event.key === "Escape" && isBusy.value) {
			event.preventDefault();
			void sendAbort();
		}
	};

	const handlePaste = (event: ClipboardEvent) => {
		const files = [...(event.clipboardData?.files ?? [])];
		if (files.length === 0) return;
		event.preventDefault();
		for (const file of files) {
			if (!file.type.startsWith("image/")) continue;
			void readFileAsImage(file)
				.then((image) => {
					pendingImages.value = [...pendingImages.value, image];
				})
				.catch(() => pushToast("Failed to read pasted image", "error"));
		}
	};

	const queuedMessages = [...queue.value.steering, ...queue.value.followUp];

	return (
		<div class="editor-area">
			{queuedMessages.length > 0 && (
				<div class="queue-indicator">
					{queuedMessages.map((text, index) => (
						<div key={`${index}-${text}`} class="queue-entry">
							queued: {text}
						</div>
					))}
				</div>
			)}
			{pendingImages.value.length > 0 && (
				<div class="pending-images">
					{pendingImages.value.map((image, index) => (
						<button
							key={`${image.mimeType}-${index}`}
							type="button"
							class="pending-image"
							title="Remove image"
							onClick={() => {
								pendingImages.value = pendingImages.value.filter((_, i) => i !== index);
							}}
						>
							<img src={`data:${image.mimeType};base64,${image.data}`} alt="attachment" />
						</button>
					))}
				</div>
			)}
			{autocompleteOpen.value && (
				<div class="autocomplete">
					{autocompleteMatches.value.map((command, index) => (
						<button
							key={command.name}
							type="button"
							class={`autocomplete-entry ${index === autocompleteIndex.value ? "selected" : ""}`}
							onMouseDown={(event) => {
								event.preventDefault();
								editorText.value = `/${command.name} `;
								autocompleteDismissed.value = true;
								textareaRef.current?.focus();
							}}
						>
							<span class="autocomplete-name">/{command.name}</span>
							{command.description && <span class="autocomplete-description">{command.description}</span>}
						</button>
					))}
				</div>
			)}
			<div class="editor-row">
				<textarea
					ref={textareaRef}
					class="editor-input"
					placeholder={isBusy.value ? "Steer the agent…" : "Send a message…"}
					rows={1}
					enterkeyhint="send"
					value={editorText.value}
					onInput={(event) => {
						editorText.value = (event.target as HTMLTextAreaElement).value;
						autocompleteIndex.value = 0;
						if (!editorText.value.startsWith("/")) {
							autocompleteDismissed.value = false;
						}
						autoGrow();
					}}
					onKeyDown={handleKeyDown}
					onPaste={handlePaste}
				/>
				{isBusy.value ? (
					<button type="button" class="editor-button abort" title="Abort (Esc)" onClick={() => void sendAbort()}>
						■
					</button>
				) : null}
				<button type="button" class="editor-button send" title="Send" onClick={() => void send()}>
					▲
				</button>
			</div>
		</div>
	);
}
