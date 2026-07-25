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

### Phase 2 — in-process bridge + `pi --web` (NEXT)

- [ ] Refactor rpc-mode event/command translation into a reusable sink
- [ ] `packages/coding-agent/src/web/`: HTTP server (static assets from
      `@earendil-works/pi-web` dist) + WS endpoint + per-share token auth
      (random 128-bit, required on HTTP + WS upgrade)
- [ ] `pi --web [--web-port N] [--web-host 127.0.0.1]`: headless web-only mode,
      prints URL + token (+ QR code)
- [ ] Build/packaging: `packages/web` builds before coding-agent; bridge resolves
      dist via package exports; **Bun single-binary build needs the assets embedded
      (release blocker, check build-binaries.yml)**
- [ ] Decide how `packages/web` is published (currently `private: true`)

### Phase 3 — share a live TUI session

- [ ] UI multiplexer for extension dialogs (TUI + web, first-response-wins,
      "resolved elsewhere" for losers)
- [ ] `/web` slash command in interactive mode: start/stop sharing the current
      session, show URL + QR

### Phase 4 — polish

- [ ] Inline compaction summary entry on live `compaction_end` (currently toast-only;
      historical compactionSummary messages already render)
- [ ] Mobile UX pass: touch targets, safe areas, Enter-vs-send behavior
- [ ] Custom theme dirs (`~/.pi/agent/themes`) in the web theme loader
- [ ] Diff rendering for edit/write tools (args oldText/newText), like the TUI
- [ ] Read-only `.jsonl` session viewer (no agent process), building on session
      format + export_html

### Phase 5 — remote access & convergence

- [ ] `packages/server` convergence: host the same web UI + WS protocol for
      supervised RPC instances; fix `LiveInstance.onUiRequest` single-handler
      limitation (broadcast to all subscribers, first response wins)
- [ ] Radius relay for off-LAN access (presence exists; `capabilities.relay` is
      currently false)
- [ ] Optional: `pi --attach <instance>` making the TUI a client of the server,
      unifying TUI and web as symmetrical clients

## Notes / known gaps

- Web runs at http://localhost:5173 in dev (`npm run dev --workspace=@earendil-works/pi-web`)
  with the bridge on :4464 (`npm run dev:bridge --workspace=@earendil-works/pi-web`).
- `custom()` extension components stay unsupported on web (TUI-coupled), same as RPC.
- Local echo of user messages relies on `message_start` events (verified working).
- Tool partial updates re-render all tool components on each delta; fine so far,
  revisit with per-tool signals if profiling shows it matters.
