# Session Recovery Example

[![Docs](https://img.shields.io/badge/docs-tinfoil.sh-blue)](https://docs.tinfoil.sh/guides/proxy-server)

This example demonstrates **session recovery** for encrypted AI streaming responses. If a user closes their browser tab while a response is streaming, the proxy continues buffering the encrypted response. When the user reopens the page, the client retrieves and decrypts the buffered response.

This builds on the basic encrypted proxy pattern shown in [encrypted-request-proxy-example](https://github.com/tinfoilsh/encrypted-request-proxy-example).

## Project Structure

```
├── server/
│   └── main.go              # Go proxy server with session buffering
└── clients/
    └── typescript/          # Browser chat client with recovery
```

## Quick Start

```bash
# Terminal 1: Start the proxy
export TINFOIL_API_KEY=tk_...
cd server && go run main.go

# Terminal 2: Start the TypeScript client
cd clients/typescript && npm install && npx vite
```

Open http://localhost:5173 and send a message.

## Prerequisites

- Go 1.21+
- Node.js 18+
- A Tinfoil API key

## How It Works

Streaming responses can take several seconds. If the user closes the tab mid-stream, the response is lost — the client can't decrypt partial data, and the enclave won't replay it.

Session recovery solves this by having the proxy buffer a copy of the encrypted response:

**Before streaming starts:**
1. Client generates a random session ID and sends it via the `X-Session-Id` header
2. Proxy creates an in-memory buffer for that session and tee-writes the encrypted response into it
3. Client extracts a 64-byte recovery token (the HPKE exported secret + request enc) from the active encryption context and saves it to `localStorage` along with the session ID

**If the tab closes mid-stream:**
4. The proxy detects the client disconnect but keeps the upstream enclave connection alive (using a background context) and continues buffering
5. A resilient tee-writer ensures the session buffer keeps receiving data even after writes to the client fail

**When the user reopens the page:**
6. Client finds the recovery token in `localStorage` and polls `GET /recovery/{id}/status`
7. Once the proxy reports the session is `complete`, the client fetches the full buffered response from `GET /recovery/{id}`
8. Client reconstructs the HPKE token from `localStorage` and calls `SecureClient.decryptRecoveryResponse()` to decrypt the buffered response
9. The decrypted response is streamed through the same SSE parser and rendered in the chat UI

Sessions expire after 5 minutes if not claimed. The client sends `DELETE /recovery/{id}` after a successful normal completion to clean up early.

## Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/v1/chat/completions` | POST | Forwards encrypted request to the enclave, buffers response if `X-Session-Id` is set |
| `/v1/responses` | POST | Same as above |
| `/attestation` | GET | Proxies attestation bundles from `https://atc.tinfoil.sh/attestation` |
| `/recovery/{id}/status` | GET | Returns `{"status": "not_found\|in_progress\|complete", "bytes": N}` |
| `/recovery/{id}` | GET | Returns the buffered encrypted response (once complete) |
| `/recovery/{id}` | DELETE | Removes the session buffer |

## Headers

| Direction | Header | Purpose |
|-----------|--------|---------|
| Request | `X-Session-Id` | Enables response buffering for recovery |
| Request | `X-Tinfoil-Enclave-Url` | Enclave URL the client verified — used as upstream target |
| Request | `Ehbp-Encapsulated-Key` | HPKE encapsulated key for the enclave to decrypt the request |
| Response | `Ehbp-Response-Nonce` | Nonce for the client to decrypt the response |

## Request Flow

```
Client                    Proxy                     Tinfoil Enclave
  │                         │                              │
  │ POST /v1/chat/completions                              │
  │ X-Session-Id: abc123    │                              │
  │────────────────────────>│                              │
  │                         │ create session buffer abc123 │
  │                         │                              │
  │                         │ POST /v1/chat/completions    │
  │                         │ Authorization: Bearer <key>  │
  │                         │─────────────────────────────>│
  │                         │<─────────────────────────────│
  │                         │ Ehbp-Response-Nonce: <nonce> │
  │                         │ Body: <encrypted stream>     │
  │                         │                              │
  │ (save recovery token    │ tee-write to client          │
  │  to localStorage)       │ + session buffer             │
  │<─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│                              │
  │                         │                              │
  │ (tab closes!)           │                              │
  │          X              │ client write fails,          │
  │                         │ continue buffering           │
  │                         │<─────────────────────────────│
  │                         │ (stream completes)           │
  │                         │ session.done = true          │
  │                         │                              │
  │ (user reopens tab)      │                              │
  │                         │                              │
  │ GET /recovery/abc123/status                            │
  │────────────────────────>│                              │
  │<────────────────────────│ {"status":"complete"}        │
  │                         │                              │
  │ GET /recovery/abc123    │                              │
  │────────────────────────>│                              │
  │<────────────────────────│ buffered encrypted response  │
  │                         │                              │
  │ (decrypt with saved     │                              │
  │  recovery token)        │                              │
  │                         │                              │
  │ (render recovered       │                              │
  │  conversation)          │                              │
```
