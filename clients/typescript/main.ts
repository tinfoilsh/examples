import {
  SecureClient,
  FetchError,
  AttestationError,
  serializeSessionRecoveryToken,
  deserializeSessionRecoveryToken,
  decryptResponseWithToken,
} from "tinfoil";

type Role = "user" | "assistant";

// ---------------------------------------------------------------------------
// Session recovery: localStorage persistence
// ---------------------------------------------------------------------------

const PROXY_ORIGIN = "http://localhost:8080";
const RECOVERY_STORAGE_KEY = "tinfoil_recovery";
const CONVERSATION_STORAGE_KEY = "tinfoil_conversation";

interface ChatMessage {
  role: Role;
  content: string;
}

let conversation: ChatMessage[] = [];

function saveConversation(): void {
  localStorage.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify(conversation));
}

function loadConversation(): ChatMessage[] {
  const raw = localStorage.getItem(CONVERSATION_STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ChatMessage[];
  } catch {
    return [];
  }
}

function clearAll(): void {
  localStorage.removeItem(CONVERSATION_STORAGE_KEY);
  localStorage.removeItem(RECOVERY_STORAGE_KEY);
  conversation = [];
  messages.innerHTML = "";
  clearStatus();
}

interface StoredRecovery {
  sessionId: string;
  token: string;
  userMessage: string;
}

function generateSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function saveRecovery(data: StoredRecovery): void {
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

const messages = requireElement<HTMLDivElement>("#messages");
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

  // Clean up any previous recovery session now that the user is sending a new message
  const previousRecovery = loadRecovery();
  if (previousRecovery) {
    console.log("[recovery] cleaning up previous session:", previousRecovery.sessionId);
    fetch(`${PROXY_ORIGIN}/recovery/${previousRecovery.sessionId}`, { method: "DELETE" }).catch(() => {});
    clearRecovery();
  }

  conversation.push({ role: "user", content: text });
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
    console.log("[session] created:", sessionId);
    setStatus(`session: ${sessionId}`, "streaming");

    const response = await client.fetch("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
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
      saveRecovery({ sessionId, token: serializeSessionRecoveryToken(token), userMessage: text });
      console.log("[recovery] token saved for session:", sessionId);
    } catch (err) {
      console.warn("[recovery] could not save token:", err);
    }

    if (!response.ok) {
      clearRecovery();
      const errorText = await response.text();
      throw new Error(errorText || `HTTP ${response.status}`);
    }

    const assistantBubble = appendMessage("", "assistant");
    const contentType = response.headers.get("Content-Type") ?? "";

    let assistantText = "";

    if (contentType.includes("text/event-stream")) {
      await streamResponse(response, (chunk) => {
        assistantText += chunk;
        assistantBubble.textContent = assistantText;
        messages.scrollTop = messages.scrollHeight;
      });
    } else {
      const json = await response.json();
      assistantText = json.choices?.[0]?.message?.content ?? "No content";
      assistantBubble.textContent = assistantText;
    }

    conversation.push({ role: "assistant", content: assistantText });
    saveConversation();
    clearRecovery();
    clearStatus();
    console.log("[session] stream complete, deleting recovery buffer:", sessionId);
    fetch(`${PROXY_ORIGIN}/recovery/${sessionId}`, { method: "DELETE" }).catch(() => {});
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
clearButton.addEventListener("click", clearAll);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    void sendMessage();
  }
});

// ---------------------------------------------------------------------------
// Restore conversation and attempt session recovery on page load
// ---------------------------------------------------------------------------

conversation = loadConversation();
for (const msg of conversation) {
  appendMessage(msg.content, msg.role);
}

async function attemptRecovery(): Promise<void> {
  const stored = loadRecovery();
  if (!stored) {
    console.log("[recovery] no recovery token found, skipping");
    return;
  }

  const { sessionId, token: serializedToken, userMessage } = stored;
  console.log("[recovery] attempting recovery for session:", sessionId);
  setStatus(`recovering session: ${sessionId}`, "recovering");

  try {
    // Fetch the buffered response directly — the proxy streams bytes as
    // they arrive, so this works whether the upstream is still in progress
    // or already complete.
    const recoveryResp = await fetch(
      `${PROXY_ORIGIN}/recovery/${sessionId}`,
    );
    if (!recoveryResp.ok) {
      console.warn("[recovery] proxy returned", recoveryResp.status, "— session may have expired");
      clearRecovery();
      return;
    }

    console.log("[recovery] got buffered response, decrypting...");
    setStatus(`recovered session: ${sessionId}`, "recovered");

    const token = deserializeSessionRecoveryToken(serializedToken);
    const decrypted = await decryptResponseWithToken(recoveryResp, token);

    conversation.push({ role: "user", content: userMessage });
    appendMessage(userMessage, "user");
    const assistantBubble = appendMessage("", "assistant");
    const contentType = decrypted.headers.get("Content-Type") ?? "";
    let assistantText = "";

    if (contentType.includes("text/event-stream")) {
      await streamResponse(decrypted, (chunk) => {
        assistantText += chunk;
        assistantBubble.textContent = assistantText;
        messages.scrollTop = messages.scrollHeight;
      });
    } else {
      const json = await decrypted.json();
      assistantText = json.choices?.[0]?.message?.content ?? "No content";
      assistantBubble.textContent = assistantText;
    }

    console.log("[recovery] success, recovered", assistantText.length, "chars");
    conversation.push({ role: "assistant", content: assistantText });
    saveConversation();
  } catch (err) {
    console.warn("[recovery] failed:", err);
    setStatus(`recovery failed: ${sessionId}`, "");
  }
}

attemptRecovery().then(() => input.focus());
