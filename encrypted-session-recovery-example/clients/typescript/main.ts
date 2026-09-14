import {
  SecureClient,
  AttestationError,
  serializeSessionRecoveryToken,
  deserializeSessionRecoveryToken,
  decryptResponseWithToken,
} from "tinfoil";
import { createParser } from "eventsource-parser";

type Role = "user" | "assistant";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROXY_ORIGIN = "http://localhost:8080";
const RECOVERY_STORAGE_KEY = "tinfoil_recovery";
const CONVERSATION_STORAGE_KEY = "tinfoil_conversation";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: Role;
  content: string;
}

interface StoredRecovery {
  sessionId: string;
  token: string;
  userMessage: string;
}

let conversation: ChatMessage[] = [];

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element for selector: ${selector}`);
  }
  return element;
}

const messagesDiv = requireElement<HTMLDivElement>("#messages");
const input = requireElement<HTMLInputElement>("#messageInput");
const sendButton = requireElement<HTMLButtonElement>("#sendBtn");
const clearButton = requireElement<HTMLButtonElement>("#clearBtn");
const statusBar = requireElement<HTMLDivElement>("#statusBar");

function setStatus(text: string, style: "streaming" | "recovered" | "recovering" | ""): void {
  statusBar.textContent = text;
  statusBar.className = "status-bar" + (style ? ` ${style}` : "");
}

function clearStatus(): void {
  statusBar.textContent = "";
  statusBar.className = "status-bar";
}

let scrollQueued = false;
function scrollToBottom(): void {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    scrollQueued = false;
  });
}

function appendMessage(text: string, role: Role): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "message-content";
  bubble.textContent = text;

  wrapper.appendChild(bubble);
  messagesDiv.appendChild(wrapper);
  scrollToBottom();

  return bubble;
}

// ---------------------------------------------------------------------------
// Secure client
// ---------------------------------------------------------------------------

const client = new SecureClient({
  baseURL: "http://localhost:8080/",
  attestationBundleURL: "http://localhost:8080",
});

// ---------------------------------------------------------------------------
// SSE stream consumption
// ---------------------------------------------------------------------------

async function streamResponse(
  response: Response,
  onChunk: (text: string) => void,
) {
  const body = response.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let finished = false;

  const parser = createParser({
    onEvent(event) {
      if (event.data === "[DONE]") {
        finished = true;
        return;
      }

      try {
        const message = JSON.parse(event.data);
        const text =
          message.choices?.[0]?.delta?.content ??
          message.choices?.[0]?.message?.content ??
          "";

        if (text) {
          onChunk(text);
        }

        if (message.error?.message) {
          onChunk(`\nError: ${message.error.message}`);
          finished = true;
        }
      } catch {
        // skip unparseable events
      }
    },
  });

  while (!finished) {
    const { value, done } = await reader.read();
    if (value) {
      parser.feed(decoder.decode(value, { stream: true }));
    }
    if (done) break;
  }

  parser.feed(decoder.decode());
  parser.reset({ consume: true });
}

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

function generateSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function deleteProxyBuffer(sessionId: string): void {
  fetch(`${PROXY_ORIGIN}/recovery/${sessionId}`, { method: "DELETE" }).catch(() => {});
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

  // Clean up any previous recovery session now that the user is sending a new message
  const previousRecovery = localStorage.getItem(RECOVERY_STORAGE_KEY);
  if (previousRecovery) {
    const { sessionId } = JSON.parse(previousRecovery) as StoredRecovery;
    console.log("[recovery] cleaning up previous session:", sessionId);
    deleteProxyBuffer(sessionId);
    localStorage.removeItem(RECOVERY_STORAGE_KEY);
  }

  conversation.push({ role: "user", content: text });
  appendMessage(text, "user");
  sendButton.disabled = true;

  try {
    try {
      await client.ready();
    } catch (err) {
      if (err instanceof AttestationError) {
        client.reset();
      }
      await client.ready();
    }

    const sessionId = generateSessionId();
    console.log("[session] created:", sessionId);
    setStatus(`session: ${sessionId}`, "streaming");

    const response = await client.fetch("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        // X-Session-Id is an application-level convention used by this proxy
        // for stream recovery — not part of the tinfoil protocol.
        "X-Session-Id": sessionId,
      },
      body: JSON.stringify({
        model: "gpt-oss-120b",
        messages: conversation,
        stream: true,
      }),
    });

    // Save recovery token before reading the stream.
    // If the tab closes mid-stream, we can recover from the proxy buffer.
    try {
      const token = await client.getSessionRecoveryToken();
      const stored: StoredRecovery = {
        sessionId,
        token: serializeSessionRecoveryToken(token),
        userMessage: text,
      };
      localStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(stored));
      console.log("[recovery] token saved for session:", sessionId);
    } catch (err) {
      console.warn("[recovery] could not save token:", err);
    }

    if (!response.ok) {
      localStorage.removeItem(RECOVERY_STORAGE_KEY);
      const errorText = await response.text();
      throw new Error(errorText || `HTTP ${response.status}`);
    }

    const assistantBubble = appendMessage("", "assistant");
    let assistantText = "";

    const contentType = response.headers.get("Content-Type") ?? "";
    if (contentType.includes("text/event-stream")) {
      await streamResponse(response, (chunk) => {
        assistantText += chunk;
        assistantBubble.textContent = assistantText;
        scrollToBottom();
      });
    } else {
      const json = await response.json();
      assistantText = json.choices?.[0]?.message?.content ?? "No content";
      assistantBubble.textContent = assistantText;
    }

    conversation.push({ role: "assistant", content: assistantText });
    localStorage.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify(conversation));
    localStorage.removeItem(RECOVERY_STORAGE_KEY);
    clearStatus();
    console.log("[session] stream complete, deleting recovery buffer:", sessionId);
    deleteProxyBuffer(sessionId);
  } catch (error) {
    console.error("Chat request failed", error);
    const message =
      error instanceof Error ? error.message : "Could not connect to server";
    appendMessage(`Error: ${message}`, "assistant");
    clearStatus();
  } finally {
    sendButton.disabled = false;
    input.focus();
  }
}

sendButton.addEventListener("click", () => void sendMessage());
clearButton.addEventListener("click", () => {
  localStorage.removeItem(CONVERSATION_STORAGE_KEY);
  localStorage.removeItem(RECOVERY_STORAGE_KEY);
  conversation = [];
  messagesDiv.innerHTML = "";
  clearStatus();
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    void sendMessage();
  }
});

// ---------------------------------------------------------------------------
// Restore conversation and attempt session recovery on page load
// ---------------------------------------------------------------------------

const savedConversation = localStorage.getItem(CONVERSATION_STORAGE_KEY);
if (savedConversation) {
  try {
    conversation = JSON.parse(savedConversation) as ChatMessage[];
  } catch {
    conversation = [];
  }
}
for (const msg of conversation) {
  appendMessage(msg.content, msg.role);
}

async function attemptRecovery(): Promise<void> {
  const raw = localStorage.getItem(RECOVERY_STORAGE_KEY);
  if (!raw) {
    console.log("[recovery] no recovery token found, skipping");
    return;
  }

  let stored: StoredRecovery;
  try {
    stored = JSON.parse(raw) as StoredRecovery;
  } catch {
    return;
  }

  const { sessionId, token: serializedToken, userMessage } = stored;
  console.log("[recovery] attempting recovery for session:", sessionId);
  setStatus(`recovering session: ${sessionId}`, "recovering");

  try {
    // Check how many bytes the proxy has buffered so we know when we've
    // caught up to the live stream.
    const statusResp = await fetch(`${PROXY_ORIGIN}/recovery/${sessionId}/status`);
    if (!statusResp.ok) {
      console.warn("[recovery] status check failed:", statusResp.status);
      localStorage.removeItem(RECOVERY_STORAGE_KEY);
      return;
    }
    const { bytes: bufferedBytes } = await statusResp.json();
    console.log("[recovery] proxy has", bufferedBytes, "bytes buffered");

    // Fetch the buffered response, wrapping the body to track how many
    // raw bytes we've consumed so we can detect the replay/live boundary.
    const recoveryResp = await fetch(`${PROXY_ORIGIN}/recovery/${sessionId}`);
    if (!recoveryResp.ok) {
      console.warn("[recovery] proxy returned", recoveryResp.status, "— session may have expired");
      localStorage.removeItem(RECOVERY_STORAGE_KEY);
      return;
    }

    let bytesRead = 0;
    let caughtUp = false;
    const originalBody = recoveryResp.body!;
    const countingStream = new ReadableStream({
      async start(controller) {
        const reader = originalBody.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          bytesRead += value.byteLength;
          if (!caughtUp && bytesRead >= bufferedBytes) {
            caughtUp = true;
            console.log("[recovery] caught up to live stream at", bytesRead, "bytes");
            setStatus(`recovered session: ${sessionId}`, "recovered");
          }
          controller.enqueue(value);
        }
      },
    });
    const wrappedResp = new Response(countingStream, {
      headers: recoveryResp.headers,
      status: recoveryResp.status,
    });

    console.log("[recovery] decrypting...");
    const token = deserializeSessionRecoveryToken(serializedToken);
    const decrypted = await decryptResponseWithToken(wrappedResp, token);

    conversation.push({ role: "user", content: userMessage });
    appendMessage(userMessage, "user");
    const assistantBubble = appendMessage("", "assistant");
    let assistantText = "";

    const contentType = decrypted.headers.get("Content-Type") ?? "";
    if (contentType.includes("text/event-stream")) {
      await streamResponse(decrypted, (chunk) => {
        assistantText += chunk;
        assistantBubble.textContent = assistantText;
        scrollToBottom();
      });
    } else {
      const json = await decrypted.json();
      assistantText = json.choices?.[0]?.message?.content ?? "No content";
      assistantBubble.textContent = assistantText;
    }

    console.log("[recovery] complete, recovered", assistantText.length, "chars");
    conversation.push({ role: "assistant", content: assistantText });
    localStorage.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify(conversation));
    localStorage.removeItem(RECOVERY_STORAGE_KEY);
    clearStatus();
    deleteProxyBuffer(sessionId);
  } catch (err) {
    console.warn("[recovery] failed:", err);
    setStatus(`recovery failed: ${sessionId}`, "");
  }
}

attemptRecovery().then(() => input.focus());
