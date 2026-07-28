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

      // When a token arrives, append it to the LAST message (our blank assistant message)
      tokenChannel.onmessage = (token: string) => {
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

        {/* Content */}
        <div className="hud-content">
          <p className="welcome-text">
            Always-on desktop copilot. Currently listening globally for
            <code style={{ background: "rgba(255,255,255,0.06)", padding: "2px 6px", borderRadius: "4px", marginLeft: "4px", marginRight: "4px", fontFamily: "monospace" }}>Ctrl + Space</code>
            to toggle overlay visibility.
          </p>

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
                      // 1. If it's an empty assistant message, show our bouncing loading dots
                      <div className="dot-flashing">
                        <div style={{ backgroundColor: "#a5b4fc" }}></div>
                        <div style={{ backgroundColor: "#a5b4fc" }}></div>
                        <div style={{ backgroundColor: "#a5b4fc" }}></div>
                      </div>
                    ) : (
                      // 2. Otherwise, parse the message as structured Markdown
                      <ReactMarkdown>{msg.content}</ReactMarkdown>
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