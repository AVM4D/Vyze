import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

function App() {
  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState("Type your name below to greet the Rust backend...");
  const [isLoading, setIsLoading] = useState(false);

  // This function runs when the user submits the form
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); // Stop page reload
    if (!prompt.trim()) return;

    setIsLoading(true);
    setResponse("Sending to Rust backend...");
    try {
      // Call the "greet" command in src-tauri/src/lib.rs
      const res: string = await invoke("greet", { name: prompt });
      setResponse(res);
    } catch (err) {
      setResponse(`Error occurred: ${err}`);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="hud-container">
      <div className="hud-card">
        {/* Header section with brand and status indicator */}
        <div className="hud-header">
          <div className="logo-section">
            <div className="logo-glow"></div>
            <span className="hud-title">VYZE</span>
          </div>
          <span className="status-badge">HUD ACTIVE</span>
        </div>

        {/* Content section */}
        <div className="hud-content">
          <p className="welcome-text">
            Always-on desktop copilot. Currently listening globally for
            <code style={{ background: "rgba(255,255,255,0.06)", padding: "2px 6px", borderRadius: "4px", marginLeft: "4px", marginRight: "4px", fontFamily: "monospace" }}>Ctrl + Space</code>
            to toggle overlay visibility.
          </p>

          {/* Response Box */}
          <div className="response-card">
            {response}
          </div>

          {/* Prompt Form */}
          <form onSubmit={handleSubmit} className="prompt-area">
            <input
              type="text"
              className="prompt-input"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Say hello to Rust..."
              disabled={isLoading}
            />
            <button type="submit" className="send-button" disabled={isLoading}>
              {isLoading ? "..." : "Send"}
            </button>
          </form>
        </div>

        {/* Footer info */}
        <div className="footer-hint">
          Right-click tray icon to Toggle or Exit.
        </div>
      </div>
    </div>
  );
}

export default App;