/**
 * Local picker overlays for builtin commands: model selection (/model) and
 * fork entry selection (/fork). Unlike the extension dialogs, these are driven
 * entirely client-side.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import type { Model } from "../protocol.ts";
import { client, forkPickerOpen, modelPickerOpen, pushToast, selectForkEntry, selectModel } from "../state.ts";

interface PickerEntry {
	key: string;
	label: string;
	detail?: string;
}

function PickerOverlay({
	title,
	placeholder,
	entries,
	loading,
	onSelect,
	onClose,
}: {
	title: string;
	placeholder: string;
	entries: PickerEntry[];
	loading: boolean;
	onSelect(key: string): void;
	onClose(): void;
}) {
	const [filter, setFilter] = useState("");
	const [index, setIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const normalized = filter.toLowerCase();
	const filtered = entries.filter(
		(entry) =>
			entry.label.toLowerCase().includes(normalized) || (entry.detail ?? "").toLowerCase().includes(normalized),
	);
	const clampedIndex = Math.min(index, Math.max(filtered.length - 1, 0));

	const handleKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
			return;
		}
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setIndex((clampedIndex + 1) % Math.max(filtered.length, 1));
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			setIndex((clampedIndex - 1 + filtered.length) % Math.max(filtered.length, 1));
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			const entry = filtered[clampedIndex];
			if (entry) onSelect(entry.key);
		}
	};

	return (
		<div class="picker-root">
			<button type="button" class="picker-backdrop" aria-label="Close picker" onClick={onClose} />
			<div class="picker">
				<div class="picker-title">{title}</div>
				<input
					ref={inputRef}
					class="picker-input"
					placeholder={placeholder}
					value={filter}
					onInput={(event) => {
						setFilter((event.target as HTMLInputElement).value);
						setIndex(0);
					}}
					onKeyDown={handleKeyDown}
				/>
				<div class="picker-list">
					{loading && <div class="picker-empty">Loading…</div>}
					{!loading && filtered.length === 0 && <div class="picker-empty">No matches</div>}
					{filtered.map((entry, entryIndex) => (
						<button
							key={entry.key}
							type="button"
							class={`picker-entry ${entryIndex === clampedIndex ? "selected" : ""}`}
							onMouseEnter={() => setIndex(entryIndex)}
							onClick={() => onSelect(entry.key)}
						>
							<span class="picker-label">{entry.label}</span>
							{entry.detail && <span class="picker-detail">{entry.detail}</span>}
						</button>
					))}
				</div>
			</div>
		</div>
	);
}

export function ModelPicker() {
	const [models, setModels] = useState<Model[] | undefined>(undefined);
	const open = modelPickerOpen.value;

	useEffect(() => {
		if (!open) {
			setModels(undefined);
			return;
		}
		void client.command({ type: "get_available_models" }).then((response) => {
			if (response.success && response.command === "get_available_models") {
				setModels((response.data as { models: Model[] }).models);
			} else {
				pushToast("Failed to load models", "error");
				modelPickerOpen.value = false;
			}
		});
	}, [open]);

	if (!open) return null;
	const entries = (models ?? []).map((model) => ({
		key: `${model.provider}/${model.id}`,
		label: model.name,
		detail: `${model.provider}/${model.id}${model.reasoning ? " · reasoning" : ""}`,
	}));
	return (
		<PickerOverlay
			title="Select model"
			placeholder="Filter models…"
			entries={entries}
			loading={models === undefined}
			onSelect={(key) => {
				const [provider, ...rest] = key.split("/");
				void selectModel(provider, rest.join("/"));
			}}
			onClose={() => {
				modelPickerOpen.value = false;
			}}
		/>
	);
}

export function ForkPicker() {
	const [messages, setMessages] = useState<Array<{ entryId: string; text: string }> | undefined>(undefined);
	const open = forkPickerOpen.value;

	useEffect(() => {
		if (!open) {
			setMessages(undefined);
			return;
		}
		void client.command({ type: "get_fork_messages" }).then((response) => {
			if (response.success && response.command === "get_fork_messages") {
				setMessages((response.data as { messages: Array<{ entryId: string; text: string }> }).messages);
			} else {
				pushToast("Failed to load messages", "error");
				forkPickerOpen.value = false;
			}
		});
	}, [open]);

	if (!open) return null;
	const entries = (messages ?? [])
		.map((message) => ({
			key: message.entryId,
			label: message.text.replace(/\s+/g, " ").trim() || "(empty message)",
		}))
		.reverse();
	return (
		<PickerOverlay
			title="Fork from message"
			placeholder="Filter messages…"
			entries={entries}
			loading={messages === undefined}
			onSelect={(key) => void selectForkEntry(key)}
			onClose={() => {
				forkPickerOpen.value = false;
			}}
		/>
	);
}
