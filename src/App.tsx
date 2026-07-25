import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

function App() {
  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState("Select a provider, set your key, and ask Vyze a question...");
  const [provider, setProvider] = useState("gemini"); // Stores "gemini" or "ollama"
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;

    setIsLoading(true);
    setResponse(""); // Clear previous text to start a clean stream!

    try {
      // Call our Rust command ask_vyze
      await invoke("ask_vyze", {
        prompt: prompt,
        provider: provider,
        // The callback callback mapping to our Rust Channel
        onToken: (token: string) => {
          setResponse((prev) => prev + token); // Append each word token as it arrives
        }
      });
    } catch (err) {
      setResponse(`Error: ${err}`);
    } finally {
      setIsLoading(false);
      setPrompt(""); // Clear input box
    }
  }

  return (
    <div className="hud-container">
      <div className="hud-card">
        {/* Header with Title and Model Dropdown Selector */}
        <div className="hud-header">
          <div className="logo-section">
            <div className="logo-glow"></div>
            <span className="hud-title">VYZE</span>
          </div>

          {/* Dropdown Selector */}
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

        {/* Content Area */}
        <div className="hud-content">
          <p className="welcome-text">
            Always-on desktop copilot. Currently listening globally for
            <code style={{ background: "rgba(255,255,255,0.06)", padding: "2px 6px", borderRadius: "4px", marginLeft: "4px", marginRight: "4px", fontFamily: "monospace" }}>Ctrl + Space</code>
            to toggle overlay visibility.
          </p>

          {/* Response card (updates live as tokens stream in) */}
          <div className="response-card" style={{ overflowY: "auto", maxGain: "150px" }}>
            {response}
          </div>

          {/* Prompt input form */}
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