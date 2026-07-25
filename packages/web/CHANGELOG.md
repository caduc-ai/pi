# Changelog

## [Unreleased]

### Added

- Initial release: Preact web UI for pi sessions, speaking the pi RPC protocol over WebSocket. Served by `pi --web`, `/web` in the TUI, and `server serve --web` (per-instance under `/i/<id>/`); includes TUI-mirrored rendering (markdown, syntax highlighting, tool executions with edit/write diffs, themes from the TUI theme JSONs including custom themes), prompting with steering and abort, slash command autocomplete, extension UI dialogs (select/confirm/input/editor) with first-response-wins semantics across clients, inline compaction summaries, and a mobile layout (touch targets, safe areas, send button).
- Added builtin slash commands in the web UI: `/compact`, `/new`, `/name`, `/model` (picker with fuzzy search, or `/model provider/id` directly), `/session` (stats card), `/export`, `/copy`, `/fork` (message picker, forked text lands in the editor), `/clone`, plus `!<cmd>` bash execution.
