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

  // Voice States
  const [voiceActive, setVoiceActive] = useState(true); // If background listening is enabled
  const [voiceState, setVoiceState] = useState<"standby" | "dictating" | "speaking">("standby");
  const voiceStateRef = useRef(voiceState);

  useEffect(() => {
    voiceStateRef.current = voiceState;
  }, [voiceState]);

  // Audio tactical synth wake beep helper
  function playBeep() {
    try {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(520, ctx.currentTime);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
    } catch (e) {
      console.warn("AudioContext beep failed:", e);
    }
  }

  // Text-To-Speech response reader helper
  function speakText(text: string) {
    if (!voiceActive) return;
    window.speechSynthesis.cancel();

    // Clean up markdown markers for natural voice synthesis
    const cleanText = text
      .replace(/[*#`_\-]/g, "")
      .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
      .trim();

    if (!cleanText) {
      setVoiceState("standby");
      return;
    }

    const utterance = new SpeechSynthesisUtterance(cleanText);
    
    // Find the best voice directly at the moment of speech
    const systemVoices = window.speechSynthesis.getVoices();
    const coolVoice = systemVoices.find(
      (v) =>
        v.name.includes("Online (Natural)") || // Microsoft Edge online natural voices (highly realistic!)
        v.name.includes("Google") ||           // Google natural web voices
        v.name.includes("Natural") ||          // Siri / macOS natural voices
        v.name.includes("Enhanced") ||         // Enhanced offline macOS voices
        v.name.includes("Hazel") ||            // Smooth British Hazel accent
        v.name.includes("George")              // Smooth British George accent
    );

    if (coolVoice) {
      utterance.voice = coolVoice;
      console.log("Speaking using natural voice:", coolVoice.name);
    } else {
      console.warn("No custom natural voice found, using system default.");
    }

    setVoiceState("speaking");

    utterance.onend = () => {
      setVoiceState("standby");
    };

    utterance.onerror = (e) => {
      console.error("SpeechSynthesisUtterance error:", e);
      setVoiceState("standby");
    };

    window.speechSynthesis.speak(utterance);
  }

  // Manage Web Speech API State Machine
  useEffect(() => {
    if (!voiceActive) {
      window.speechSynthesis.cancel();
      setVoiceState("standby");
      return;
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn("SpeechRecognition API not supported in this environment.");
      return;
    }

    let activeRec: any = null;

    if (voiceState === "standby") {
      // Continuous background wake-word spotting
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true; // Enabled interim triggers for instant wake response!
      recognition.lang = "en-US";

      recognition.onresult = (event: any) => {
        if (voiceStateRef.current !== "standby") return;
        
        // Scan through incoming speech stream segments immediately
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const transcript = event.results[i][0].transcript.trim().toLowerCase();
          console.log("Interim speech heard:", transcript);

          // Broadened phoneme matching list to capture all accents/distortions of "Vyze"
          if (
            transcript.includes("vyze") ||
            transcript.includes("wise") ||
            transcript.includes("vice") ||
            transcript.includes("wize") ||
            transcript.includes("rise") ||
            transcript.includes("size") ||
            transcript.includes("always") ||
            transcript.includes("device") ||
            transcript.includes("vibes") ||
            transcript.includes("boys") ||
            transcript.includes("guys") ||
            transcript.includes("eyes") ||
            transcript.includes("why's") ||
            transcript.includes("five")
          ) {
            invoke("show_main_window").catch(console.error);
            playBeep();
            setVoiceState("dictating");
            break;
          }
        }
      };

      recognition.onerror = (err: any) => {
        console.warn("Standby speech recognition error:", err.error);
        // Auto-restart standby on error if still in standby mode
        if (voiceStateRef.current === "standby" && voiceActive) {
          try {
            recognition.stop();
          } catch (e) {}
          setTimeout(() => {
            if (voiceStateRef.current === "standby" && voiceActive) {
              try {
                recognition.start();
              } catch (e) {}
            }
          }, 300);
        }
      };

      recognition.onend = () => {
        // Auto-restart standby to stay always-on in the background
        if (voiceStateRef.current === "standby" && voiceActive) {
          try {
            recognition.start();
          } catch (e) {
            console.error("Standby recognition restart failed:", e);
          }
        }
      };

      try {
        recognition.start();
        activeRec = recognition;
      } catch (e) {
        console.error("Failed to start standby recognition:", e);
      }
    } else if (voiceState === "dictating") {
      // Short-session prompt dictation
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = "en-US";

      recognition.onresult = (event: any) => {
        if (voiceStateRef.current !== "dictating") return;
        const results = event.results;
        const lastResult = results[results.length - 1];
        const transcript = lastResult[0].transcript;
        setPrompt(transcript);
      };

      recognition.onerror = (err: any) => {
        console.warn("Dictation speech recognition error:", err.error);
        if (voiceStateRef.current === "dictating") {
          setVoiceState("standby");
        }
      };

      recognition.onend = () => {
        if (voiceStateRef.current !== "dictating") return;
        handleVoiceSubmit();
      };

      try {
        recognition.start();
        activeRec = recognition;
      } catch (e) {
        console.error("Failed to start dictation recognition:", e);
      }
    }

    return () => {
      if (activeRec) {
        activeRec.onend = null;
        activeRec.onresult = null;
        try {
          activeRec.stop();
        } catch (e) {
          console.error("Failed to stop recognition instance:", e);
        }
      }
    };
  }, [voiceState, voiceActive]);

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

  // Listen for the global keydown events inside App (Escape shortcut to mute/stop speech)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && voiceStateRef.current === "speaking") {
        e.preventDefault();
        window.speechSynthesis.cancel();
        setVoiceState("standby");
        console.log("Speech synthesis muted via Escape shortcut key.");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
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

  // Submit trigger logic
  async function triggerSubmit(promptText: string) {
    if (!promptText.trim()) return;

    // Create the clean bubble prompt shown on the screen
    const userMsg: Message = { role: "user", content: promptText };

    // Inject selection context into the payload history array sent to Rust/AI
    const userMsgWithContext: Message = {
      role: "user",
      content: selectedText
        ? `[Selected Text Context: "${selectedText}"]\n\n${promptText}`
        : promptText
    };

    const newHistory = [...messages, userMsg];
    const payloadHistory = [...messages, userMsgWithContext];

    setMessages([...newHistory, { role: "assistant", content: "" }]);
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

      // Read response aloud if voice features are active
      if (voiceActive) {
        speakText(fullResponse);
      } else {
        setVoiceState("standby");
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
      setVoiceState("standby");
    } finally {
      setIsLoading(false);
    }
  }

  // Voice dictation submit trigger
  function handleVoiceSubmit() {
    setPrompt((currentPrompt) => {
      if (currentPrompt.trim()) {
        triggerSubmit(currentPrompt);
      } else {
        setVoiceState("standby");
      }
      return ""; // clear prompt
    });
  }

  // 4. Handle form prompt submit
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;

    const text = prompt;
    setPrompt("");
    await triggerSubmit(text);
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

            {/* Voice Activation Switch */}
            <button
              type="button"
              className={`voice-toggle-btn ${voiceActive ? "active" : "muted"}`}
              onClick={() => setVoiceActive(!voiceActive)}
              title={voiceActive ? `Mute Voice (State: ${voiceState})` : "Unmute Voice"}
            >
              <span className={`voice-led ${voiceActive ? voiceState : "disabled"}`}></span>
              <span className="voice-text">
                {!voiceActive ? "VOICE: OFF" : `VOICE: ${voiceState.toUpperCase()}`}
              </span>
            </button>

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
              disabled={isLoading || voiceState === "speaking"}
            />
            {voiceState === "speaking" ? (
              <button
                type="button"
                className="stop-speech-btn"
                onClick={() => {
                  window.speechSynthesis.cancel();
                  setVoiceState("standby");
                }}
                title="Stop reading response"
              >
                Stop
              </button>
            ) : (
              <button type="submit" className="send-button" disabled={isLoading}>
                {isLoading ? (
                  <div className="dot-flashing">
                    <div style={{ width: "4px", height: "4px" }}></div>
                    <div style={{ width: "4px", height: "4px" }}></div>
                    <div style={{ width: "4px", height: "4px" }}></div>
                  </div>
                ) : "Send"}
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

export default App;
