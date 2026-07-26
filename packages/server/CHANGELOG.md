# Changelog

## [Unreleased]

### Added

- Added `server serve --web [--web-port <port>] [--web-host <host>]`: serves the pi web UI for all supervised instances with token auth (instance index at `/`, per-instance UI at `/i/<id>/`, RPC protocol over WebSocket at `/i/<id>/ws`).

### Fixed

- Fixed the server review page to start from the current branch's GitHub PR by default, creating the PR when one does not already exist.
- Removed the standalone terminal link from the server home page.
- Fixed extension UI requests only reaching the last attached rpc_stream client: requests now fan out to all stream clients, dialog responses are first-response-wins, and other clients receive `extension_ui_cancel`.
- Fixed spawning RPC child processes under Node (the `./rpc-entry` package subpath only declares an `import` condition; resolution now uses `import.meta.resolve`).

## [0.82.1] - 2026-07-25

## [0.82.0] - 2026-07-24

## [0.81.1] - 2026-07-21

## [0.81.0] - 2026-07-21

### Changed

- Renamed the orchestrator workspace package and internal server references to server ([#6898](https://github.com/earendil-works/pi/pull/6898) by [@cristinaponcela](https://github.com/cristinaponcela)).

## [0.80.10] - 2026-07-16

## [0.80.9] - 2026-07-16

## [0.80.8] - 2026-07-16

## [0.80.7] - 2026-07-14

## [0.80.6] - 2026-07-09

## [0.80.5] - 2026-07-09

## [0.80.4] - 2026-07-09

## [0.80.3] - 2026-06-30
