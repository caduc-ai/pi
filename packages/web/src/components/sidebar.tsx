import { useEffect } from "preact/hooks";
import {
	instanceId,
	pinnedSessions,
	pinnedSidebarOpen,
	refreshPinnedSessions,
	startPinnedSessionsPolling,
	stopPinnedSessionsPolling,
} from "../state.ts";

/**
 * Slim left sidebar for quickly switching between pinned sessions. Only shown
 * when served by pi-server (instanceId defined) and only lists pinned + live
 * sessions; see refreshPinnedSessions for why. Inline on desktop; below 900px
 * (see .pinned-sidebar in style.css) it becomes an off-canvas drawer opened via
 * the header's sessions toggle (see Header in app.tsx) so pinned sessions stay
 * reachable without crowding the chat area.
 */
export function PinnedSidebar() {
	useEffect(() => {
		if (!instanceId) return;
		void refreshPinnedSessions();
		startPinnedSessionsPolling();
		return () => stopPinnedSessionsPolling();
	}, []);

	if (!instanceId) return null;
	const sessions = pinnedSessions.value;
	if (sessions.length === 0) return null;
	const isOpen = pinnedSidebarOpen.value;

	return (
		<>
			{isOpen ? (
				<button
					type="button"
					class="pinned-sidebar-backdrop"
					aria-label="Close pinned sessions"
					onClick={() => {
						pinnedSidebarOpen.value = false;
					}}
				/>
			) : null}
			<nav class={`pinned-sidebar${isOpen ? " open" : ""}`} aria-label="Pinned sessions">
				<div class="pinned-sidebar-title">Pinned</div>
				{sessions.map((session) => (
					<a
						key={session.id}
						href={`/i/${session.id}/`}
						class={`pinned-sidebar-item${session.id === instanceId ? " current" : ""}`}
						title={session.namespace ? `${session.name} (${session.namespace})` : session.name}
						onClick={() => {
							pinnedSidebarOpen.value = false;
						}}
					>
						{session.name}
						{session.namespace ? <span class="pinned-sidebar-item-ns">{session.namespace}</span> : null}
					</a>
				))}
			</nav>
		</>
	);
}
