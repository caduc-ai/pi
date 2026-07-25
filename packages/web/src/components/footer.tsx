import { sessionState, stats, statusEntries, workingMessage } from "../state.ts";
import { applyTheme, availableThemes, themeName } from "../theme.ts";

function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}

export function Footer() {
	const state = sessionState.value;
	const sessionStats = stats.value;
	const statusTexts = Object.values(statusEntries.value);
	const context = sessionStats?.contextUsage;

	return (
		<footer class="footer">
			{workingMessage.value && (
				<div class="working-indicator">
					{workingMessage.value}
					<span class="working-dots" />
				</div>
			)}
			{statusTexts.length > 0 && <div class="status-entries">{statusTexts.join(" · ")}</div>}
			<div class="footer-row">
				<span class="footer-left">
					{state?.model ? `${state.model.name} · ${state.thinkingLevel}` : "no model"}
				</span>
				<span class="footer-right">
					{context && context.percent !== null && context.percent !== undefined && (
						<span title={`${context.tokens ?? "?"} / ${context.contextWindow} tokens`}>
							{context.percent}% ctx
						</span>
					)}
					{sessionStats && <span title="Session cost">${sessionStats.cost.toFixed(4)}</span>}
					{sessionStats && <span title="Total tokens">{formatTokens(sessionStats.tokens.total)}</span>}
					<select
						class="theme-toggle"
						title="Theme"
						value={themeName.value}
						onChange={(event) => {
							void applyTheme((event.target as HTMLSelectElement).value);
						}}
					>
						{availableThemes.value.map((name) => (
							<option key={name} value={name}>
								{name}
							</option>
						))}
					</select>
				</span>
			</div>
		</footer>
	);
}
