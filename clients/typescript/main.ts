import { SecureClient, FetchError, AttestationError } from "tinfoil";
import type { SessionRecoveryToken } from "tinfoil";

type Role = "user" | "assistant";

// ---------------------------------------------------------------------------
// Session recovery: localStorage persistence
// ---------------------------------------------------------------------------

const PROXY_ORIGIN = "http://localhost:8080";
const RECOVERY_STORAGE_KEY = "tinfoil_recovery";

interface StoredRecovery {
  sessionId: string;
  exportedSecret: number[];
  requestEnc: number[];
  userMessage: string;
}

function generateSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function saveRecovery(
  sessionId: string,
  token: SessionRecoveryToken,
  userMessage: string,
): void {
  const data: StoredRecovery = {
    sessionId,
    exportedSecret: Array.from(token.exportedSecret),
    requestEnc: Array.from(token.requestEnc),
    userMessage,
  };
  localStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(data));
}

function loadRecovery(): StoredRecovery | null {
  const raw = localStorage.getItem(RECOVERY_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredRecovery;
  } catch {
    return null;
  }
}

function clearRecovery(): void {
  localStorage.removeItem(RECOVERY_STORAGE_KEY);
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element for selector: ${selector}`);
  }
  return element;
}

const TOAST_DISPLAY_MS = 3000;

function showToast(text: string): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("visible"));
  setTimeout(() => {
    el.classList.remove("visible");
    el.addEventListener("transitionend", () => el.remove());
  }, TOAST_DISPLAY_MS);
}

const messages = requireElement<HTMLDivElement>("#messages");
const input = requireElement<HTMLInputElement>("#messageInput");
const sendButton = requireElement<HTMLButtonElement>("#sendBtn");

const client = new SecureClient({
  baseURL: "http://localhost:8080/",
  attestationBundleURL: "http://localhost:8080",
});

function appendMessage(text: string, role: Role): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "message-content";
  bubble.textContent = text;

  wrapper.appendChild(bubble);
  messages.appendChild(wrapper);
  messages.scrollTop = messages.scrollHeight;

  return bubble;
}

// ---------------------------------------------------------------------------
// SSE stream parsing
// ---------------------------------------------------------------------------

function processEvent(
  payload: string,
  onChunk: (text: string) => void,
): boolean {
  if (payload === "[DONE]") {
    return true;
  }

  try {
    const message = JSON.parse(payload);
    const text =
      message.choices?.[0]?.delta?.content ??
      message.choices?.[0]?.message?.content ??
      "";

    if (text) {
      onChunk(text);
    }

    if (message.error?.message) {
      onChunk(`\nError: ${message.error.message}`);
      return true;
    }
  } catch (error) {
    console.warn("Could not parse SSE chunk", payload, error);
  }

  return false;
}

async function streamResponse(
  response: Response,
  onChunk: (text: string) => void,
) {
  const body = response.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  const flush = (final = false) => {
    const segments = buffer.split("\n\n");
    buffer = final ? "" : (segments.pop() ?? "");

    for (const segment of segments) {
      const dataLines = segment
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());

      if (dataLines.length === 0) {
        continue;
      }

      const payload = dataLines.join("\n");
      finished ||= processEvent(payload, onChunk);
      if (finished) {
        buffer = "";
        return;
      }
    }
  };

  while (!finished) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: true });
      flush();
    }
    if (done) {
      break;
    }
  }

  buffer += decoder.decode();
  flush(true);
}

// ---------------------------------------------------------------------------
// Send message with session recovery support
// ---------------------------------------------------------------------------

async function sendMessage(): Promise<void> {
  const text = input.value.trim();
  if (!text) {
    input.focus();
    return;
  }

  input.value = "";
  appendMessage(text, "user");
  sendButton.disabled = true;

  try {
    try {
      await client.ready();
    } catch (err) {
      if (err instanceof FetchError) {
        await client.ready();
      } else if (err instanceof AttestationError) {
        client.reset();
        await client.ready();
      } else {
        throw err;
      }
    }

    const sessionId = generateSessionId();

    const response = await client.fetch("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-Session-Id": sessionId,
      },
      body: JSON.stringify({
        model: "gpt-oss-120b",
        messages: [{ role: "user", content: text }],
        stream: true,
      }),
    });

    // Save recovery token to localStorage before reading the stream.
    // If the tab closes mid-stream, we can recover from the proxy buffer.
    try {
      const token = client.getSessionRecoveryToken();
      saveRecovery(sessionId, token, text);
    } catch {
      // Token not available (e.g. bodyless request)
    }

    if (!response.ok) {
      clearRecovery();
      const errorText = await response.text();
      throw new Error(errorText || `HTTP ${response.status}`);
    }

    const assistantBubble = appendMessage("", "assistant");
    const contentType = response.headers.get("Content-Type") ?? "";

    if (contentType.includes("text/event-stream")) {
      await streamResponse(response, (chunk) => {
        assistantBubble.textContent += chunk;
        messages.scrollTop = messages.scrollHeight;
      });
      // Stream completed — clean up recovery data and proxy buffer
      clearRecovery();
      fetch(`${PROXY_ORIGIN}/recovery/${sessionId}`, { method: "DELETE" }).catch(() => {});
      return;
    }

    const json = await response.json();
    assistantBubble.textContent =
      json.choices?.[0]?.message?.content ?? "No content";
    clearRecovery();
  } catch (error) {
    console.error("Chat request failed", error);
    const message =
      error instanceof Error ? error.message : "Could not connect to server";
    appendMessage(`Error: ${message}`, "assistant");
  } finally {
    sendButton.disabled = false;
    input.focus();
  }
}

sendButton.addEventListener("click", () => void sendMessage());
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    void sendMessage();
  }
});

// ---------------------------------------------------------------------------
// Attempt session recovery on page load
// ---------------------------------------------------------------------------

async function attemptRecovery(): Promise<void> {
  const stored = loadRecovery();
  if (!stored) return;

  const { sessionId, exportedSecret, requestEnc, userMessage } = stored;

  try {
    const statusResp = await fetch(
      `${PROXY_ORIGIN}/recovery/${sessionId}/status`,
    );
    const statusBody = await statusResp.json();

    if (statusBody.status === "not_found") {
      clearRecovery();
      return;
    }

    if (statusBody.status === "in_progress") {
      await new Promise((r) => setTimeout(r, 2000));
      return attemptRecovery();
    }

    // status === "complete" — fetch and decrypt the buffered response
    const recoveryResp = await fetch(
      `${PROXY_ORIGIN}/recovery/${sessionId}`,
    );
    if (!recoveryResp.ok) {
      clearRecovery();
      return;
    }

    const token: SessionRecoveryToken = {
      exportedSecret: new Uint8Array(exportedSecret),
      requestEnc: new Uint8Array(requestEnc),
    };

    const decrypted = await SecureClient.decryptRecoveryResponse(
      recoveryResp,
      token,
    );

    appendMessage(userMessage, "user");
    const assistantBubble = appendMessage("", "assistant");
    const contentType = decrypted.headers.get("Content-Type") ?? "";

    if (contentType.includes("text/event-stream")) {
      await streamResponse(decrypted, (chunk) => {
        assistantBubble.textContent += chunk;
        messages.scrollTop = messages.scrollHeight;
      });
    } else {
      const json = await decrypted.json();
      assistantBubble.textContent =
        json.choices?.[0]?.message?.content ?? "No content";
    }

    showToast("Recovered from previous session");
  } catch (err) {
    console.warn("Session recovery failed:", err);
  } finally {
    clearRecovery();
  }
}

attemptRecovery().then(() => input.focus());
