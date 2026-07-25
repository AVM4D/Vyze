import { useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core"; // 1. Added Channel to our imports
import "./App.css";

// This is our main React screen
function App() {
  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState("Select a provider, set your key, and ask Vyze a question...");
  const [provider, setProvider] = useState("gemini");
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;

    setIsLoading(true);
    setResponse(""); // Clear text to prepare for incoming stream

    try {
      // 2. Create a new Channel envelope, giving it our update callback function
      const tokenChannel = new Channel<string>();

      // When a message (token) arrives from Rust, append it to the screen
      tokenChannel.onmessage = (token: string) => {
        setResponse((prev) => prev + token);
      };

      // 3. Invoke ask_vyze and pass the channel envelope
      await invoke("ask_vyze", {
        prompt: prompt,
        provider: provider,
        onToken: tokenChannel // Pass the channel instance
      });
    } catch (err) {
      setResponse(`Error: ${err}`);
    } finally {
      setIsLoading(false);
      setPrompt(""); // Clear the text box
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

          {/* Response Box */}
          <div className="response-card" style={{ overflowY: "auto", maxGain: "150px" }}>
            {response}
          </div>

          {/* Input Box */}
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
              {isLoading ? "..." : "Send"}
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