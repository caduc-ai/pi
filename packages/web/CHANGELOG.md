# Changelog

## [Unreleased]

### Added

- Initial release: Preact web UI for pi sessions, speaking the pi RPC protocol over WebSocket. Served by `pi --web`, `/web` in the TUI, and `server serve --web` (per-instance under `/i/<id>/`); includes TUI-mirrored rendering (markdown, syntax highlighting, tool executions with edit/write diffs, themes from the TUI theme JSONs including custom themes), prompting with steering and abort, slash command autocomplete, extension UI dialogs (select/confirm/input/editor) with first-response-wins semantics across clients, inline compaction summaries, and a mobile layout (touch targets, safe areas, send button).
- Added builtin slash commands in the web UI: `/compact`, `/new`, `/name`, `/model` (picker with fuzzy search, or `/model provider/id` directly), `/session` (stats card), `/export`, `/copy`, `/fork` (message picker, forked text lands in the editor), `/clone`, plus `!<cmd>` bash execution.
- Added a review icon to the session header, left of the terminal icon, linking to the review page for the session's working location. Under `pi-server` it passes the instance id so the review page can link back.
- Added the `/gas` builtin slash command, staging all changes, committing with a `😊` message, and pushing.
- Added the `/cd [path]` builtin slash command, changing the session's working location (or reporting it when called with no argument).
- Added a terminal panel (xterm.js), toggled from the header. It attaches to a persistent shell that keeps `cd`, environment variables, and running processes across commands and runs interactive programs like `vim` and `htop`. The shell lives for the whole pi run, so closing the panel or reconnecting from another device resumes the same session with its scrollback replayed. On narrow screens a key bar supplies `Esc`, `Tab`, `Ctrl-C`/`Ctrl-D`/`Ctrl-Z`, and arrow keys. Requires `tmux` on the host.
- Added PWA metadata, icons, and a service worker so the web UI can be installed to a mobile home screen in standalone mode on supported secure origins.
- Added a `tui` header button that swaps the chat area (message list, command result card, widgets, editor) for an xterm.js view of the real pi interactive TUI attached to the same session. Toggling it off (or the TUI process exiting) closes the attachment and resyncs the chat view with whatever happened in the TUI. The header, footer, dialogs, terminal panel, and subagents panel are unaffected and remain reachable while the TUI is showing.

### Fixed

- Fixed web slash command autocomplete to keep scrolling through all matches and order commands like the TUI.
