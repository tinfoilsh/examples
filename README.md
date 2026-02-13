# Encrypted Proxy with Session Recovery

[![Docs](https://img.shields.io/badge/docs-tinfoil.sh-blue)](https://docs.tinfoil.sh/guides/proxy-server)

This example demonstrates two things:

1. **Encrypted proxying** — Forwarding AI inference requests through your own server while preserving end-to-end encryption via [EHBP](https://github.com/tinfoilsh/encrypted-http-body-protocol). Your proxy can inspect headers and add authentication, but cannot read request or response bodies.

2. **Session recovery** — If a user closes their browser tab while a streaming response is in flight, the proxy continues buffering the encrypted response. When the user reopens the page, the client retrieves and decrypts the buffered response from the proxy.

## Project Structure

```
├── server/
│   └── main.go              # Go proxy server
└── clients/
    └── typescript/          # Browser chat client
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

### Encrypted Proxying

The browser client uses the [tinfoil](https://www.npmjs.com/package/tinfoil) SDK, which encrypts request bodies and decrypts response bodies using HPKE. The proxy sits between the client and the Tinfoil enclave:

1. Client fetches and verifies the enclave's attestation bundle via the proxy (`GET /attestation`)
2. Client encrypts the request body and sends it to the proxy with an `Ehbp-Encapsulated-Key` header
3. Proxy forwards the encrypted request to the enclave URL (from the `X-Tinfoil-Enclave-Url` header), injecting the `TINFOIL_API_KEY` as the Bearer token
4. Proxy streams the encrypted response back to the client, preserving the `Ehbp-Response-Nonce` header
5. Client decrypts the response body locally

The proxy handles routing and authentication but **cannot read the message content**.

### Session Recovery

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

## Proxy Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/attestation` | GET | Proxies attestation bundles from `https://atc.tinfoil.sh/attestation` |
| `/v1/chat/completions` | POST | Forwards encrypted request to the enclave |
| `/v1/responses` | POST | Forwards encrypted request to the enclave |
| `/recovery/{id}/status` | GET | Returns `{"status": "not_found\|in_progress\|complete", "bytes": N}` |
| `/recovery/{id}` | GET | Returns the buffered encrypted response (once complete) |
| `/recovery/{id}` | DELETE | Removes the session buffer |

## Headers

| Direction | Header | Purpose |
|-----------|--------|---------|
| Request | `X-Tinfoil-Enclave-Url` | Enclave URL the client verified — used as upstream target |
| Request | `Ehbp-Encapsulated-Key` | HPKE encapsulated key for the enclave to decrypt the request |
| Request | `X-Session-Id` | Optional. Enables response buffering for recovery |
| Response | `Ehbp-Response-Nonce` | Nonce for the client to decrypt the response |

## Request Flow

```
Client                    Proxy                     Tinfoil Enclave
  │                         │                              │
  │ GET /attestation        │                              │
  │────────────────────────>│ GET /attestation             │
  │                         │─────────────────────────────>│
  │                         │<─────────────────────────────│
  │<────────────────────────│ attestation bundle           │
  │                         │                              │
  │ (verify attestation,    │                              │
  │  derive HPKE keys)      │                              │
  │                         │                              │
  │ POST /v1/chat/completions                              │
  │ X-Session-Id: abc123    │                              │
  │ Ehbp-Encapsulated-Key: <key>                           │
  │ Body: <encrypted>       │                              │
  │────────────────────────>│                              │
  │                         │ create session buffer abc123 │
  │                         │                              │
  │                         │ POST /v1/chat/completions    │
  │                         │ Authorization: Bearer <key>  │
  │                         │ Ehbp-Encapsulated-Key: <key> │
  │                         │ Body: <encrypted>            │
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
