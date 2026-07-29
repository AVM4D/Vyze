import { useState, useRef, useEffect } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown"; // Import markdown parser
import "./App.css";

// 1. Define what a Message looks like
interface Message {
  role: "user" | "assistant";
  content: string;
}

function App() {
  const [prompt, setPrompt] = useState("");
  // 2. Change response state to an array of messages
  const [messages, setMessages] = useState<Message[]>([]);
  const [provider, setProvider] = useState("gemini");
  const [isLoading, setIsLoading] = useState(false);

  const [autoCopy, setAutoCopy] = useState(false); // Controls if Vyze auto-copies responses
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null); // Tracks which message was copied

  // Helper: Copy a specific text back to the system clipboard
  async function handleCopy(text: string, index: number) {
    try {
      await invoke("write_clipboard", { text });
      setCopiedIndex(index); // Set the active copied index to trigger checkmark display
      setTimeout(() => {
        setCopiedIndex(null); // Reset back to clipboard icon after 1.5 seconds
      }, 1500);
    } catch (err) {
      console.error("Failed to copy to clipboard:", err);
    }
  }
  // Create a reference pointer pointing to the bottom of the chat list
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Scroll to the bottom of the chat container whenever messages list changes
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;

    // A. Create the user's message object
    const userMsg: Message = { role: "user", content: prompt };

    // B. Create the new history list, adding a blank bot message at the end
    const newHistory = [...messages, userMsg];
    setMessages([...newHistory, { role: "assistant", content: "" }]);
    setPrompt(""); // Clear input box immediately
    setIsLoading(true);

    try {
      const tokenChannel = new Channel<string>();
      let fullResponse = ""; // Accumulates the full response text for auto-copying

      // When a token arrives, append it to the LAST message (our blank assistant message)
      tokenChannel.onmessage = (token: string) => {
        fullResponse += token; // Append token to our local tracker string
        setMessages((prev) => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (lastIdx >= 0 && updated[lastIdx].role === "assistant") {
            // Create a clean copy of the assistant message instead of mutating it directly
            updated[lastIdx] = {
              ...updated[lastIdx],
              content: updated[lastIdx].content + token
            };
          }
          return updated;
        });
      };

      // C. Call our Rust command, sending the history (without the blank bot message)
      await invoke("ask_vyze", {
        history: newHistory,
        provider: provider,
        onToken: tokenChannel
      });

      // D. Auto-copy the response text to the system clipboard if checked
      if (autoCopy && fullResponse.trim()) {
        await invoke("write_clipboard", { text: fullResponse });
      }
    } catch (err) {
      // If an error happens, write it inside the bot's bubble
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
        {/* Header */}
        <div className="hud-header">
          <div className="logo-section">
            <div className="logo-glow"></div>
            <span className="hud-title">VYZE</span>
          </div>

          {/* Controls Section (Model + Auto-Copy) */}
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            {/* Auto-Copy Toggle Switch */}
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
                <option value="gemini">Gemini (Cloud)</option>
                <option value="ollama">Ollama (Local)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="hud-content">
          {messages.length === 0 && (
            <p className="welcome-text">
              Always-on desktop copilot. Currently listening globally for
              <code style={{ background: "rgba(255,255,255,0.06)", padding: "2px 6px", borderRadius: "4px", marginLeft: "4px", marginRight: "4px", fontFamily: "monospace" }}>Ctrl + Space</code>
              to toggle overlay visibility.
            </p>
          )}

          {/* 3. Render the scrollable Chat List */}
          <div className="chat-container">
            {messages.length === 0 ? (
              <div className="response-card" style={{ border: "none", background: "transparent", padding: 0, textAlign: "center", color: "#555555" }}>
                Ask Vyze anything to start a conversation...
              </div>
            ) : (
              messages.map((msg, index) => (
                <div key={index} className={`message-row ${msg.role}`}>
                  <div className={`chat-bubble ${msg.role}`}>
                    {msg.content === "" && msg.role === "assistant" ? (
                      <div className="dot-flashing">
                        <div style={{ backgroundColor: "#a5b4fc" }}></div>
                        <div style={{ backgroundColor: "#a5b4fc" }}></div>
                        <div style={{ backgroundColor: "#a5b4fc" }}></div>
                      </div>
                    ) : (
                      <>
                        <ReactMarkdown>{msg.content}</ReactMarkdown>
                        {/* If it's an assistant bubble and not empty, add a copy button */}
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
            {/* The scroll target anchor */}
            <div ref={messagesEndRef} />
          </div>

          {/* Input Area */}
          <form onSubmit={handleSubmit} className="prompt-area">
            <input
              type="text"
              className="prompt-input"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={provider === "gemini" ? "Ask Gemini anything..." : "Ask local Ollama..."}
              disabled={isLoading}
            />
            <button type="submit" className="send-button" disabled={isLoading}>
              {isLoading ? (
                <div className="dot-flashing">
                  <div></div>
                  <div></div>
                  <div></div>
                </div>
              ) : "Send"}
            </button>
          </form>
        </div>

          <div className="footer-hint">
            Right-click tray icon to Toggle or Exit.
          </div>
        </div>
      </div>
      );
}

      export default App;


