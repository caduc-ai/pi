# Plan: stream pi sessions to a web UI

Goal: view and fully control a pi session from another device (phone/desktop) via a
web app that mirrors the TUI's visual language and works on mobile and desktop.

## Decisions (locked)

- **Full control**, not view-only: prompt, steer, abort, and extension dialog
  responses (select/confirm/input/editor) from the web.
- **Expose the current session**: a command (`/web` in the TUI, `pi --web` headless)
  shares the live session. Not limited to server-spawned sessions.
- **Internet-designed, simple auth**: per-share random token; TLS termination and
  network access are external (tailscale serve / Caddy). Access is "my devices only".
- **Frontend stack**: Preact + Vite + `@preact/signals`, for extensibility.
- **Multi-client**: fan-out events to all attached web clients; dialogs are
  first-response-wins, losers get "resolved elsewhere".
- **Wire protocol**: the exact pi RPC protocol (docs/rpc.md), one JSON message per
  WebSocket frame. No second protocol.

## Architecture

```
browser (packages/web, Preact)
   │  WebSocket, RPC protocol verbatim
   ▼
packages/coding-agent/src/web/  (in-process bridge: HTTP static + WS + token auth)
   │  subscribes to the live AgentSession (multi-subscriber supported)
   ▼
pi process (TUI or headless --web)
```

Key seams:

- `AgentSession.subscribe()` supports multiple listeners, so the web bridge attaches
  in-process alongside the TUI frontend.
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts` already translates AgentSession
  events/commands to the JSON protocol; refactor it to write to a sink (stdout today,
  WS next) and reuse it for the web bridge.
- Extension UI dialogs: interactive mode builds one `ExtensionUIContext`
  (`createExtensionUIContext`). Wrap it in a multiplexer that offers dialogs to TUI +
  all web clients (first response wins) and broadcasts fire-and-forget methods
  (notify/setStatus/setWidget/setTitle).
- Themes: the TUI theme JSONs (`dark.json`/`light.json`, semantic color names) map
  1:1 to CSS custom properties.
- Reconnects self-heal: client re-syncs `get_state` + `get_messages`; `message_update`
  events carry the accumulated partial message.

## Phases & progress

### Phase 1 — `packages/web` scaffold + protocol client + rendering (DONE)

- [x] Preact + Vite package, signals store, WS client with reconnect + re-sync
- [x] Components mirroring TUI: user/assistant/bash/custom/compaction/branch-summary
      messages, collapsible thinking, tool blocks (pending/success/error, expand),
      markdown (marked + highlight.js + DOMPurify), footer, loader
- [x] Editor: slash autocomplete (`get_commands`), image paste, steer-while-streaming,
      abort (Esc / button), queue indicator
- [x] Extension UI: select/confirm/input/editor dialogs, notify toasts, setStatus,
      setWidget, setTitle, set_editor_text
- [x] Theme loader: TUI theme JSON -> CSS vars, dark/light toggle, persisted
- [x] Dev bridge (`src/bridge.ts`): spawns `pi --mode rpc`, WS<->stdio, serves theme
      JSONs. Env: `PI_WEB_CWD`, `PI_WEB_BRIDGE_PORT`, `PI_WEB_PI_ARGS`
- [x] Self-contained wire types in `src/protocol.ts` (workspace type imports pulled
      Node sources into the DOM-lib type-check; keep in sync with rpc-types.ts)
- [x] Root wiring: biome covers `.tsx`; `packages/web` excluded from root tsconfig
      (own tsconfig with DOM lib); `npm run check` runs `tsgo -p packages/web`;
      `RpcSlashCommand` exported from coding-agent
- [x] Verified: `npm run check` clean; end-to-end prompt/stream/tool events through
      bridge and Vite proxy; `vite build` (75KB gzip)

### Phase 2 — in-process bridge + `pi --web` (DONE)

- [x] Refactored rpc-mode: protocol implementation extracted to `RpcBridge`
      (`src/modes/rpc/rpc-bridge.ts`), multi-client by design (broadcast events/UI
      requests, targeted command responses, per-client `drain()` backpressure);
      rpc-mode.ts is now a thin stdin/stdout wrapper. RPC tests pass.
- [x] `packages/coding-agent/src/web/`: `web-server.ts` (HTTP static + WS + theme
      endpoint) and `web-mode.ts` (runWebMode). Auth: per-run 128-bit token,
      `/?token=` sets an HttpOnly SameSite=Strict cookie; all HTTP + WS upgrade
      require it (timing-safe compare).
- [x] `pi --web [--web-port N] [--web-host 127.0.0.1]` headless mode, prints URL +
      token; conflicts with --mode/--print rejected. (QR code deferred to phase 3.)
- [x] Protocol addition: `extension_ui_cancel` broadcast when a dialog is answered
      by another client, times out, or is aborted (first-response-wins). Documented
      in rpc.md; handled by the web client.
- [x] Packaging: `@earendil-works/pi-web` is a real published package (dist files),
      built before coding-agent in root build scripts, added to publish.mjs; Bun
      binary gets `web/` copied next to the executable (mirrors theme/ handling,
      resolved via `getWebDistDir()` in config.ts)
- [x] Verified: `npm run check` clean; RPC tests pass; e2e — auth (401/302/cookie,
      traversal safe), static + SPA fallback + theme endpoint, WS prompt flow,
      two-client fan-out, dialog broadcast + first-response-wins cancel, targeted
      responses
- [ ] Publish dry-run of pi-web on next release (first-time publish of the package)

### Phase 3 — share a live TUI session (DONE)

- [x] `RpcBridge` no-bind mode (`bindExtensions: false`) + `offerDialog`/
      `dismissDialog`/`broadcastUiRequest` API; `WebShare` class
      (`src/web/web-share.ts`) wraps bridge + server + per-share token
- [x] UI multiplexer in interactive mode: select/confirm/input/editor race TUI
      vs web clients (first response wins, TUI dialog dismissed on web answer,
      `extension_ui_cancel` on TUI answer); notify/setStatus/setWidget/setTitle/
      set_editor_text forwarded to web clients; TUI keeps owning the UI context
- [x] `/web [off|<host>]` command: start/stop sharing, reprints info when
      already running, shows URL + QR (qrcode-generator, truecolor half-blocks,
      LAN IP substituted when bound to wildcard), stops on TUI shutdown,
      re-subscribes on session replace (new/switch/fork)
- [x] Verified in tmux: /web shows URL+QR, web client get_state/prompt streams
      into TUI, dialog race both directions (TUI dialog dismissed on web win,
      cancel on TUI win), /web off + restart with fresh token/port

### Phase 4 — polish (DONE)

- [x] Inline compaction summary entry on live `compaction_end` (synthesized
      compactionSummary message appended; historical ones already rendered)
- [x] Mobile UX pass: touch targets (36-44px), safe-area insets, Enter=newline +
      send button on coarse pointers, 16px editor font (no iOS zoom),
      overscroll containment
- [x] Theme list endpoint (`GET /themes`, built-in + custom + registered,
      TUI resolution semantics) + theme picker in the web footer; custom theme
      dirs work; theme-schema.json excluded
- [x] Diff rendering for edit (oldText/newText line diff via `diff` package)
      and write (all-added) tools, mirroring TUI colors
- [x] Read-only `.jsonl` session viewer: `pi --web --view <file>`, no agent
      process/model/auth needed (SessionManager.open + buildSessionContext,
      write commands rejected); verified against a real session file

### Phase 5 — remote access & convergence (MOSTLY DONE)

- [x] `packages/server` convergence: `server serve --web [--web-port] [--web-host]`
      hosts the pi web UI for supervised instances (index at `/`, per-instance
      SPA at `/i/<id>/`, RPC-over-WS at `/i/<id>/ws`, token auth); web client
      derives its WS path from the page base path
- [x] Fixed `LiveInstance.onUiRequest` single-handler limitation: uiSubscribers
      fan-out, first-response-wins, synthesized `extension_ui_cancel` (the
      child's own cancel only reaches the answering channel); also fixed RPC
      child spawn under Node (`import.meta.resolve` for the exports map)
- [x] Verified e2e: two web clients through the server, event fan-out, dialog
      broadcast + first-response-wins cancel, notify broadcast
- [ ] Radius relay for off-LAN access — BLOCKED externally: requires relay
      support in the hosted radius service (capabilities.relay stays false)
- [ ] Optional (deferred): `pi --attach <instance>` making the TUI a client of
      the server — large architectural change, superseded for now by the web UI

## Notes / known gaps

- Web runs at http://localhost:5173 in dev (`npm run dev --workspace=@earendil-works/pi-web`)
  with the bridge on :4464 (`npm run dev:bridge --workspace=@earendil-works/pi-web`).
- `custom()` extension components stay unsupported on web (TUI-coupled), same as RPC.
- Local echo of user messages relies on `message_start` events (verified working).
- Tool partial updates re-render all tool components on each delta; fine so far,
  revisit with per-tool signals if profiling shows it matters.
