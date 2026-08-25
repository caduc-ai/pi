# Changelog

## [Unreleased]

### Added

- Added a file-list summary to the review page, modelled on the cranium spacemacs UI: the top-level view now lists every file in the review with a tick when reviewed and an empty box when not, marking files changed since review with a "changed" tag. Clicking a file drills into its diff, a "Files" button (or `q`/`Escape`) returns to the list, and "Mark reviewed" (or `m`) now advances straight to the next file needing review instead of leaving the review on one file at a time. `n` skips to the next file without marking.
- Added a `git pull` after a successful merge on the review page. The merge happens on GitHub, so the local branches were left behind; the base branch is fast-forwarded too (unless it is checked out), which otherwise leaves reviews diffing against the pre-merge commit.
- Added pull request creation to the review page's "Merge PR": when the branch has no open pull request, it offers to create one and merge it, instead of only reporting that none exists. Requires the matching `cranium review merge --create-pr` support.
- Fixed review action results (merge, commit review, swap, restart) being reported at the bottom of the panel, below the file list and diff, where they were off-screen and looked like nothing had happened. They now appear directly under the action buttons.
- Fixed the review page's merge silently doing nothing: the merge endpoint did not pass `--json`, so cranium emitted human-readable output and the success path could not read the merged pull request. Merge failures now also explain the cause, including an origin remote GitHub cannot be parsed from (for example `git@github.com:/owner/repo`, with a slash after the colon) and a branch with no open pull request.
- Changed the review page's "Merge" button to "Merge PR": it now asks which branch to merge into (defaulting to `main`) instead of assuming `main`, confirms first, warns when files are still unreviewed, and reports which pull request was merged. Merging targets this branch's GitHub pull request, as before.
- Added a "Swap base/head" button to the review page, and an explicit empty-range warning: a review whose range contains no files now says so and names the reversed range, instead of reporting "All files reviewed" as though the review were complete.
- Added a session icon to the review page header, linking back to the session the review was opened from. The dashboard and session-view review links now carry the instance id; the icon is hidden when the review page is opened without one.
- Added a "Commit review" button to the review page (see below), and changed the review page's "Clear" button to "Restart": it now discards the session and immediately starts a new review over the same range (or the same pull request), instead of leaving no review behind. It asks for confirmation first, and falls back to the start panel if the new review cannot be created.
- Added a "Commit review" button to the review page, backed by a new `POST /api/review/refresh` endpoint (`cranium review refresh`). It re-anchors the review to the repository's current HEAD while keeping existing checkpoints, so files reviewed at an older revision come back as changed showing only what moved since you reviewed them, and files touched by new commits are added as unreviewed.
- Added the current git branch to the review page header, backed by a new `GET /api/git/branch?repo=<path>` endpoint. The badge is hidden on detached HEAD or outside a git repo, and refreshes when the repo changes or `--create-pr` moves HEAD.
- Added tracking of a session's working location: when a session changes location with `/cd`, the supervised instance record follows it, so the dashboard's review link targets the session's current directory.
- Added `server serve --web [--web-port <port>] [--web-host <host>]`: serves the pi web UI for all supervised instances with token auth (instance index at `/`, per-instance UI at `/i/<id>/`, RPC protocol over WebSocket at `/i/<id>/ws`).
- Added PWA asset serving for per-instance web UI paths, so installing `/i/<id>/` to a mobile home screen keeps the standalone app scoped to that session.
- Added PWA metadata and service worker registration to the server home page, so Android browsers can install it from Add to home screen on supported secure origins.

### Fixed

- Fixed the server web dashboard's past-sessions list being scoped to the working-directory field, which hid sessions from other projects; it now lists every session across all project directories, newest first, and scopes to a single directory only when one is typed.
- Fixed the server review page to start from the current branch's GitHub PR by default, creating the PR when one does not already exist.
- Removed the standalone terminal link from the server home page.
- Fixed extension UI requests only reaching the last attached rpc_stream client: requests now fan out to all stream clients, dialog responses are first-response-wins, and other clients receive `extension_ui_cancel`.
- Fixed spawning RPC child processes under Node (the `./rpc-entry` package subpath only declares an `import` condition; resolution now uses `import.meta.resolve`).
- Fixed the `/theme/<name>.json` endpoint (used by the web UI's theme picker) always returning 404: it appended `.json` to a theme name that already carried it from the request path.
- Fixed the supervised instance record (cwd, session id/file) going stale after closing the TUI view from the web UI, since `tui_close` can change any of those (the TUI can `/cd` or `/new` while attached) but was not in the set of commands that refresh it.

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
