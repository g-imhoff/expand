# Expand

An AI-assisted development workflow tool: a desktop app, a backend service and a CLI that orchestrate coding agents over [ACP](https://agentclientprotocol.com) (JSON-RPC over stdio).

> **Status: early rewrite.** Expand is the second iteration of the project. The core ideas — driving coding agents through ACP, branch comparison, a companion CLI — were validated in a working proof of concept (Yodea) before this clean rewrite.

## Architecture

- **Desktop app** — Electron · Vite · React, connected to the backend over WebSocket.
- **Backend service** — owns all state (SQLite, event bus) and spawns the agent (ACP) subprocesses.
- **CLI** — a thin RPC client over WebSocket, also exposed to coding agents as a tool.
