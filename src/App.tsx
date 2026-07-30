import { useState, useRef, useEffect } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event"; // Listen to selection wake events
import ReactMarkdown from "react-markdown"; // Parse markdown output
import "./App.css";

// Structure of chat history messages
interface Message {
  role: "user" | "assistant";
  content: string;
}

function App() {
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [provider, setProvider] = useState("gemini");
  const [isLoading, setIsLoading] = useState(false);
  const [autoCopy, setAutoCopy] = useState(false); // Auto-copy AI responses
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null); // Track copied bubble index
  const [selectedText, setSelectedText] = useState(""); // Track highlighted selection
  const inputRef = useRef<HTMLInputElement>(null); // Ref to auto-focus prompt bar

  // 1. Listen for the global selection capture event from the Rust hotkey wake
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;

    async function setupListener() {
      const unlisten = await listen<string>("selection-captured", (event) => {
        const text = event.payload;
        if (text && text.trim()) {
          setSelectedText(text.trim());
        }

        // Auto-Focus the input field as soon as the HUD wakes up
        setTimeout(() => {
          inputRef.current?.focus();
        }, 50);
      });
      unlistenFn = unlisten;
    }

    setupListener();

    // Clean up event listener on unmount
    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, []);

  // 2. Clipboard copy action helper
  async function handleCopy(text: string, index: number) {
    try {
      await invoke("write_clipboard", { text });
      setCopiedIndex(index);
      setTimeout(() => {
        setCopiedIndex(null); // Revert copy checkmark icon back to clipboard after 1.5s
      }, 1500);
    } catch (err) {
      console.error("Failed to copy text:", err);
    }
  }

  // 3. Auto-scroll list anchor
  const messagesEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 4. Handle prompt submit
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;

    // Create the clean bubble prompt shown on the screen
    const userMsg: Message = { role: "user", content: prompt };

    // Inject selection context into the payload history array sent to Rust/AI
    const userMsgWithContext: Message = {
      role: "user",
      content: selectedText
        ? `[Selected Text Context: "${selectedText}"]\n\n${prompt}`
        : prompt
    };

    const newHistory = [...messages, userMsg];
    const payloadHistory = [...messages, userMsgWithContext];

    setMessages([...newHistory, { role: "assistant", content: "" }]);
    setPrompt(""); // Reset input field
    setSelectedText(""); // Clear selected context since it was consumed
    setIsLoading(true);

    try {
      const tokenChannel = new Channel<string>();
      let fullResponse = "";

      // Append incoming streaming tokens to assistant bubble
      tokenChannel.onmessage = (token: string) => {
        fullResponse += token;
        setMessages((prev) => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (lastIdx >= 0 && updated[lastIdx].role === "assistant") {
            updated[lastIdx] = {
              ...updated[lastIdx],
              content: updated[lastIdx].content + token
            };
          }
          return updated;
        });
      };

      // Call AI streaming command in Rust
      await invoke("ask_vyze", {
        history: payloadHistory,
        provider: provider,
        onToken: tokenChannel
      });

      // Auto-copy response to clipboard if active
      if (autoCopy && fullResponse.trim()) {
        await invoke("write_clipboard", { text: fullResponse });
      }
    } catch (err) {
      setMessages((prev) => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (lastIdx >= 0) {
          updated[lastIdx].content = `Error: ${err}`;
        }
        return updated;
      });
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="hud-container">
      <div className="hud-card">
        {/* Absolute Crooked Sticker Tab Header (Pops out of the card container) */}
        <div className="hud-header">
          <div className="hud-brand">
            <span className="hud-title">VYZE</span>
          </div>
        </div>

        {/* Content Section */}
        <div className="hud-content">
          {/* Controls Bar (Dropdown Select + Auto-Copy Toggle Switch) */}
          <div className="controls-bar">
            <label className="autocopy-container">
              <input
                type="checkbox"
                className="autocopy-checkbox"
                checked={autoCopy}
                onChange={(e) => setAutoCopy(e.target.checked)}
              />
              <span>Auto-Copy</span>
            </label>

            <div className="provider-select-container">
              <select
                className="provider-select"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                disabled={isLoading}
              >
                <option value="gemini">Gemini</option>
                <option value="ollama">Ollama</option>
              </select>
            </div>
          </div>

          {/* Welcome overlay text instructions */}
          {messages.length === 0 && (
            <p className="welcome-text">
              Highlight text and press
              <code style={{ background: "#ffe600", color: "#000", border: "1px solid #000", padding: "1px 4px", borderRadius: "2px", marginLeft: "4px", marginRight: "4px", fontFamily: "monospace", fontWeight: "bold" }}>Ctrl+Space</code>
              to capture selection context.
            </p>
          )}

          {/* High-Contrast Selected Text Context Banner Card */}
          {selectedText && (
            <div className="context-box">
              <div className="context-header">
                <span className="context-label">SELECTED CONTEXT</span>
                <button
                  className="context-clear-btn"
                  type="button"
                  onClick={() => setSelectedText("")}
                  title="Clear context"
                >
                  ✕
                </button>
              </div>
              <div className="context-body">
                "{selectedText}"
              </div>
            </div>
          )}

          {/* Scrollable Chat Bubbles List */}
          <div className="chat-container">
            {messages.length === 0 ? (
              <div style={{ textAlign: "center", color: "#a1a1aa", fontSize: "0.72em", fontWeight: "700", padding: "12px 0" }}>
                Ask Vyze anything to start...
              </div>
            ) : (
              messages.map((msg, index) => (
                <div key={index} className={`message-row ${msg.role}`}>
                  <div className={`chat-bubble ${msg.role}`}>
                    {msg.content === "" && msg.role === "assistant" ? (
                      <div className="dot-flashing">
                        <div></div>
                        <div></div>
                        <div></div>
                      </div>
                    ) : (
                      <>
                        <ReactMarkdown>{msg.content}</ReactMarkdown>
                        {/* Copy button positioned absolutely in the bubble top-right corner */}
                        {msg.role === "assistant" && (
                          <button
                            className="copy-button"
                            type="button"
                            onClick={() => handleCopy(msg.content, index)}
                            title="Copy response"
                          >
                            {copiedIndex === index ? "✅" : "📋"}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Dark Console Command input field */}
          <form onSubmit={handleSubmit} className="prompt-area">
            <input
              ref={inputRef}
              autoFocus
              type="text"
              className="prompt-input"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={provider === "gemini" ? "Ask Gemini..." : "Ask Ollama..."}
              disabled={isLoading}
            />
            <button type="submit" className="send-button" disabled={isLoading}>
              {isLoading ? (
                <div className="dot-flashing">
                  <div style={{ width: "4px", height: "4px" }}></div>
                  <div style={{ width: "4px", height: "4px" }}></div>
                  <div style={{ width: "4px", height: "4px" }}></div>
                </div>
              ) : "Send"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

export default App;
