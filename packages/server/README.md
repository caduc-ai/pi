# @earendil-works/pi-server

Experimental. This package is under active development and may change or be removed without notice. Its CLI, APIs, and behavior are not yet stable.

Server package for pi.

## CLI

```bash
server --help
```

## Web UI

`server serve --web [--web-port <port>] [--web-host <host>]` additionally serves the pi web UI (`@earendil-works/pi-web`) over HTTP/WebSocket and prints a URL with a per-run auth token. The index page lists running instances; each instance is available at `/i/<instance-id>/` and speaks the pi RPC protocol (see `packages/coding-agent/docs/rpc.md`) over WebSocket at `/i/<instance-id>/ws`. Multiple web clients can attach to the same instance; extension dialogs are first-response-wins across all of them.
