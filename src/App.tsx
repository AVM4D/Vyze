import { useState, useRef, useEffect } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event"; // Listen to selection wake events
import ReactMarkdown from "react-markdown"; // Parse markdown output
import "./App.css";

// Structure of chat history messages
interface Message {
  role: "user" | "assistant";
  content: string;
  image_base64?: string | null;
}

interface DbSession {
  id: string;
  title: string;
  created_at: string;
}

interface DbMessage {
  id: number;
  session_id: string;
  role: string;
  content: string;
  image_base64?: string | null;
  created_at: string;
}

function App() {
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  // Settings & Preferences States
  const [defaultProvider, setDefaultProvider] = useState(() => localStorage.getItem("vyze_default_provider") || "gemini");
  const [provider, setProvider] = useState(() => localStorage.getItem("vyze_default_provider") || "gemini");
  const [isLoading, setIsLoading] = useState(false);
  const [autoCopy, setAutoCopy] = useState(() => localStorage.getItem("vyze_auto_copy") === "true");
  const [voiceNarration, setVoiceNarration] = useState(() => localStorage.getItem("vyze_voice_narration") !== "false");
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null); // Track copied bubble index
  const [selectedText, setSelectedText] = useState(""); // Track highlighted selection
  const inputRef = useRef<HTMLInputElement>(null); // Ref to auto-focus prompt bar

  // Voice States
  const [voiceActive, setVoiceActive] = useState(true); // If background listening is enabled
  const [voiceState, setVoiceState] = useState<"standby" | "dictating" | "speaking">("standby");
  const voiceStateRef = useRef(voiceState);

  // Screen Capture States
  const [attachedImage, setAttachedImage] = useState<string | null>(null); // Holds the base64 screenshot text
  const [isCapturing, setIsCapturing] = useState(false); // Shows if the app is taking a picture right now

  // Settings & Sessions States
  const [showSettings, setShowSettings] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [sessions, setSessions] = useState<DbSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitleText, setEditingTitleText] = useState("");
  const [autoCapture, setAutoCapture] = useState(() => localStorage.getItem("vyze_auto_capture") === "true");
  const [theme, setTheme] = useState(() => localStorage.getItem("vyze_theme") || "retro-pink");

  const autoCaptureRef = useRef(autoCapture);
  const handleCaptureScreenRef = useRef<any>(null);

  useEffect(() => {
    autoCaptureRef.current = autoCapture;
  }, [autoCapture]);

  useEffect(() => {
    localStorage.setItem("vyze_auto_capture", String(autoCapture));
    invoke("set_auto_capture", { enabled: autoCapture }).catch(console.error);
  }, [autoCapture]);

  useEffect(() => {
    localStorage.setItem("vyze_default_provider", defaultProvider);
    setProvider(defaultProvider);
  }, [defaultProvider]);

  useEffect(() => {
    localStorage.setItem("vyze_auto_copy", String(autoCopy));
  }, [autoCopy]);

  useEffect(() => {
    localStorage.setItem("vyze_voice_narration", String(voiceNarration));
  }, [voiceNarration]);

  useEffect(() => {
    localStorage.setItem("vyze_theme", theme);
  }, [theme]);

  useEffect(() => {
    voiceStateRef.current = voiceState;
  }, [voiceState]);

  // Initialize DB & load sessions on startup
  useEffect(() => {
    async function initDbSessions() {
      try {
        const fetchedSessions = await invoke<DbSession[]>("db_get_sessions");
        if (fetchedSessions.length > 0) {
          setSessions(fetchedSessions);
          const firstId = fetchedSessions[0].id;
          setActiveSessionId(firstId);
          await loadMessagesForSession(firstId);
        } else {
          // Create initial session if database is fresh
          const newId = await invoke<string>("db_create_session", { title: "New Chat" });
          const newSession = { id: newId, title: "New Chat", created_at: new Date().toISOString() };
          setSessions([newSession]);
          setActiveSessionId(newId);
          setMessages([]);
        }
      } catch (err) {
        console.error("Failed to load sessions from database:", err);
      }
    }
    initDbSessions();
  }, []);

  async function loadMessagesForSession(sid: string) {
    try {
      const dbMsgs = await invoke<DbMessage[]>("db_get_messages", { sessionId: sid });
      const converted: Message[] = dbMsgs.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
        image_base64: m.image_base64,
      }));
      setMessages(converted);
    } catch (err) {
      console.error("Failed to load messages for session:", err);
    }
  }

  async function handleCreateNewSession() {
    try {
      const newId = await invoke<string>("db_create_session", { title: "New Chat" });
      const updated = await invoke<DbSession[]>("db_get_sessions");
      setSessions(updated);
      setActiveSessionId(newId);
      setMessages([]);
      setShowSidebar(false);
    } catch (err) {
      console.error("Failed to create new session:", err);
    }
  }

  async function handleSelectSession(sid: string) {
    setActiveSessionId(sid);
    await loadMessagesForSession(sid);
    setShowSidebar(false);
  }

  async function handleDeleteSession(sid: string) {
    try {
      await invoke("db_delete_session", { id: sid });
      const updated = await invoke<DbSession[]>("db_get_sessions");
      setSessions(updated);
      if (activeSessionId === sid) {
        if (updated.length > 0) {
          setActiveSessionId(updated[0].id);
          await loadMessagesForSession(updated[0].id);
        } else {
          setActiveSessionId(null);
          setMessages([]);
        }
      }
    } catch (err) {
      console.error("Failed to delete session:", err);
    }
  }

  async function handleClearAllSessions() {
    try {
      for (const s of sessions) {
        await invoke("db_delete_session", { id: s.id });
      }
      setSessions([]);
      setActiveSessionId(null);
      setMessages([]);
      setShowSidebar(false);
    } catch (err) {
      console.error("Failed to clear sessions:", err);
    }
  }

  async function handleSaveRenameSession(sid: string, newTitle: string) {
    if (!newTitle.trim()) return;
    try {
      await invoke("db_update_session_title", { id: sid, title: newTitle.trim() });
      const updated = await invoke<DbSession[]>("db_get_sessions");
      setSessions(updated);
      setEditingSessionId(null);
    } catch (err) {
      console.error("Failed to rename session:", err);
    }
  }

  // Warm up system voices inventory on boot
  useEffect(() => {
    window.speechSynthesis.getVoices();
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
      };
    }
  }, []);

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
    utterance.volume = 1.0;
    utterance.rate = 1.0;

    // Find the default system voice selected by the user in OS settings
    const systemVoices = window.speechSynthesis.getVoices();
    console.log("System voices inventory loaded by browser:", systemVoices.map(v => `${v.name} (default: ${v.default})`));

    // 1. Search for Prabhat/Prabahat, Ava, or Mark (case-insensitive)
    const targetVoice = systemVoices.find(
      (v) =>
        v.name.toLowerCase().includes("prabhat") ||
        v.name.toLowerCase().includes("prabahat") ||
        v.name.toLowerCase().includes("ava") ||
        v.name.toLowerCase().includes("mark")
    );

    if (targetVoice) {
      utterance.voice = targetVoice;
      console.log("Speaking using matched target voice:", targetVoice.name);
    } else {
      // 2. Fallback to default system voice
      const defaultVoice = systemVoices.find((v) => v.default === true);
      if (defaultVoice) {
        utterance.voice = defaultVoice;
        console.log("Speaking using user's OS default voice:", defaultVoice.name);
      } else {
        console.log("No custom default voice flag found, speaking with fallback default voice.");
      }
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
          } catch (e) { }
          setTimeout(() => {
            if (voiceStateRef.current === "standby" && voiceActive) {
              try {
                recognition.start();
              } catch (e) { }
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

  // 1. Listen for the global selection and silent screen capture events from Rust
  useEffect(() => {
    let unlistenTextFn: (() => void) | null = null;
    let unlistenScreenFn: (() => void) | null = null;

    async function setupListeners() {
      // Listen for text selection capture
      unlistenTextFn = await listen<string>("selection-captured", (event) => {
        const text = event.payload;
        if (text && text.trim()) {
          setSelectedText(text.trim());
        }

        // Auto-Focus the input field as soon as the HUD wakes up
        setTimeout(() => {
          inputRef.current?.focus();
        }, 50);
      });

      // Listen for silent auto screen capture complete
      unlistenScreenFn = await listen<string>("auto-screen-captured", (event) => {
        const base64 = event.payload;
        if (base64) {
          setAttachedImage(base64);
          playBeep(); // Beep to signal that the hidden capture succeeded!
        }
      });
    }

    setupListeners();

    // Clean up event listeners on unmount
    return () => {
      if (unlistenTextFn) unlistenTextFn();
      if (unlistenScreenFn) unlistenScreenFn();
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

    // Create the clean bubble prompt shown on the screen, holding the picture if attached
    const userMsg: Message = {
      role: "user",
      content: promptText,
      image_base64: attachedImage
    };

    // Inject selection context into the payload history array sent to Rust/AI
    const userMsgWithContext: Message = {
      role: "user",
      content: selectedText
        ? `[Selected Text Context: "${selectedText}"]\n\n${promptText}`
        : promptText,
      image_base64: attachedImage // Pass the picture payload here
    };

    const newHistory = [...messages, userMsg];
    const payloadHistory = [...messages, userMsgWithContext];

    // Handle lazy session creation if no session is active
    let currentSid = activeSessionId;
    if (!currentSid) {
      const initialTitle = promptText.length > 20 ? promptText.slice(0, 20) + "..." : promptText;
      try {
        currentSid = await invoke<string>("db_create_session", { title: initialTitle });
        const updatedSessions = await invoke<DbSession[]>("db_get_sessions");
        setSessions(updatedSessions);
        setActiveSessionId(currentSid);
      } catch (err) {
        console.error("Failed to create session on submit:", err);
      }
    }

    // Sync user message to SQLite DB
    if (currentSid) {
      invoke("db_add_message", {
        sessionId: currentSid,
        role: "user",
        content: promptText,
        imageBase64: attachedImage
      }).catch(console.error);

      // Auto-rename session if default title
      const currentSession = sessions.find((s) => s.id === currentSid);
      if (currentSession && (currentSession.title === "New Chat" || currentSession.title.trim() === "")) {
        const shortTitle = promptText.length > 20 ? promptText.slice(0, 20) + "..." : promptText;
        invoke("db_update_session_title", { id: currentSid, title: shortTitle }).catch(console.error);
        setSessions((prev) =>
          prev.map((s) => (s.id === currentSid ? { ...s, title: shortTitle } : s))
        );
      }
    }

    setMessages([...newHistory, { role: "assistant", content: "" }]);
    setSelectedText(""); // Clear selected context since it was consumed
    setAttachedImage(null); // Clear screenshot after sending it!
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
        sessionId: currentSid,
        history: payloadHistory,
        provider: provider,
        onToken: tokenChannel
      });

      // Sync assistant response to SQLite DB
      if (currentSid && fullResponse.trim()) {
        invoke("db_add_message", {
          sessionId: currentSid,
          role: "assistant",
          content: fullResponse,
          imageBase64: null
        }).catch(console.error);
      }

      // Auto-copy response to clipboard if active
      if (autoCopy && fullResponse.trim()) {
        await invoke("write_clipboard", { text: fullResponse });
      }

      // Read response aloud if voice narration is active
      if (voiceNarration) {
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

  // Capture the monitor screen containing your mouse cursor
  async function handleCaptureScreen() {
    if (isCapturing) return;
    setIsCapturing(true);

    try {
      // Call the Rust function we wrote to take a screenshot
      const base64Screenshot = await invoke<string>("capture_active_screen");
      setAttachedImage(base64Screenshot);
      playBeep(); // Play a nice tactical chirp when captured successfully
    } catch (err) {
      console.error("Screen capture failed:", err);
      // Append an error message to the chat so you know what went wrong
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Failed to capture screen: ${err}`,
          image_base64: null,
        } as any
      ]);
    } finally {
      setIsCapturing(false);
    }
  }

  useEffect(() => {
    handleCaptureScreenRef.current = handleCaptureScreen;
  }, [handleCaptureScreen]);


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

  // Handle uploading images or text documents
  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();

    if (file.type.startsWith("image/")) {
      reader.onload = (event) => {
        const result = event.target?.result as string;
        const base64 = result.split(",")[1];
        setAttachedImage(base64);
        playBeep();
      };
      reader.readAsDataURL(file);
    } else {
      reader.onload = (event) => {
        const text = event.target?.result as string;
        const maxChars = 15000;
        const truncated = text.length > maxChars ? text.slice(0, maxChars) + "\n\n[Truncated...]" : text;
        setSelectedText(`[Doc: ${file.name}]\n${truncated}`);
        playBeep();
      };
      reader.readAsText(file);
    }

    e.target.value = "";
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
    <div className={`hud-container theme-${theme}`}>
      <div className="hud-card">
        {/* Absolute Crooked Sticker Tab Header (Pops out of the card container) */}
        <div className="hud-header" data-tauri-drag-region>
          <div className="hud-brand" data-tauri-drag-region>
            <span className="hud-title" data-tauri-drag-region>VYZE</span>
          </div>
          <div style={{ display: "flex", alignItems: "center" }}>
            <button
              type="button"
              className="sidebar-toggle-btn"
              onClick={() => {
                setShowSidebar(!showSidebar);
                if (showSettings) setShowSettings(false);
              }}
              title="Chat History"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="12" x2="21" y2="12"></line>
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <line x1="3" y1="18" x2="21" y2="18"></line>
              </svg>
            </button>
            <button
              type="button"
              className="settings-toggle-btn"
              onClick={() => {
                setShowSettings(!showSettings);
                if (showSidebar) setShowSidebar(false);
              }}
              title="Toggle Settings"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
            </button>
          </div>
        </div>

        {/* Sessions History Sidebar Overlay */}
        {showSidebar && (
          <div className="sidebar-overlay">
            <div className="sidebar-card">
              <div className="sidebar-header">
                <h4 className="sidebar-title">HISTORY</h4>
                <div style={{ display: "flex", gap: "4px" }}>
                  {sessions.length > 0 && (
                    <button
                      type="button"
                      className="clear-all-btn"
                      onClick={handleClearAllSessions}
                      title="Clear All History"
                    >
                      CLEAR ALL
                    </button>
                  )}
                  <button
                    type="button"
                    className="new-chat-btn"
                    onClick={handleCreateNewSession}
                    title="Start New Chat"
                  >
                    + NEW CHAT
                  </button>
                </div>
              </div>
              <div className="sessions-list">
                {sessions.map((s) => (
                  <div
                    key={s.id}
                    className={`session-item ${s.id === activeSessionId ? "active" : ""}`}
                    onClick={() => handleSelectSession(s.id)}
                  >
                    <div className="session-info">
                      {editingSessionId === s.id ? (
                        <div className="session-rename-container" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="text"
                            className="session-rename-input"
                            value={editingTitleText}
                            onChange={(e) => setEditingTitleText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleSaveRenameSession(s.id, editingTitleText);
                              if (e.key === "Escape") setEditingSessionId(null);
                            }}
                            autoFocus
                          />
                          <button
                            type="button"
                            className="save-rename-btn"
                            onClick={() => handleSaveRenameSession(s.id, editingTitleText)}
                          >
                            ✓
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="session-title-row">
                            <span className="session-title-text">{s.title}</span>
                            <button
                              type="button"
                              className="rename-session-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingSessionId(s.id);
                                setEditingTitleText(s.title);
                              }}
                              title="Rename chat"
                            >
                              ✎
                            </button>
                          </div>
                          <span className="session-date">
                            {new Date(s.created_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
                          </span>
                        </>
                      )}
                    </div>
                    <button
                      type="button"
                      className="delete-session-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteSession(s.id);
                      }}
                      title="Delete chat"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="settings-close-btn"
                onClick={() => setShowSidebar(false)}
              >
                Close
              </button>
            </div>
          </div>
        )}

        {/* Settings Overlay */}
        {showSettings && (
          <div className="settings-overlay">
            <div className="settings-card">
              <h4 className="settings-title">SETTINGS</h4>
              <div className="settings-option">
                <label className="select-setting-label">Default Model:</label>
                <select
                  className="theme-select"
                  value={defaultProvider}
                  onChange={(e) => setDefaultProvider(e.target.value)}
                >
                  <option value="gemini">Gemini</option>
                  <option value="ollama">Ollama</option>
                </select>
              </div>
              <div className="settings-option">
                <label className="checkbox-setting-label">
                  <input
                    type="checkbox"
                    className="setting-checkbox"
                    checked={autoCopy}
                    onChange={(e) => setAutoCopy(e.target.checked)}
                  />
                  <span>Auto-copy AI responses to clipboard</span>
                </label>
              </div>
              <div className="settings-option">
                <label className="checkbox-setting-label">
                  <input
                    type="checkbox"
                    className="setting-checkbox"
                    checked={voiceNarration}
                    onChange={(e) => setVoiceNarration(e.target.checked)}
                  />
                  <span>Read AI responses out loud (Speech)</span>
                </label>
              </div>
              <div className="settings-option">
                <label className="checkbox-setting-label">
                  <input
                    type="checkbox"
                    className="setting-checkbox"
                    checked={autoCapture}
                    onChange={(e) => setAutoCapture(e.target.checked)}
                  />
                  <span>Capture screen on wake</span>
                </label>
              </div>
              <div className="settings-option">
                <label className="select-setting-label">Theme:</label>
                <select
                  className="theme-select"
                  value={theme}
                  onChange={(e) => setTheme(e.target.value)}
                >
                  <option value="retro-pink">Retro Pink (Default)</option>
                  <option value="cyberpunk">Cyberpunk</option>
                  <option value="dracula">Dracula</option>
                  <option value="monochrome">Monochrome</option>
                </select>
              </div>
              <button
                type="button"
                className="settings-close-btn"
                onClick={() => setShowSettings(false)}
              >
                Close
              </button>
            </div>
          </div>
        )}

        {/* Content Section */}
        <div className="hud-content">
          {/* Controls Bar (Voice Switch + Provider Select) */}
          <div className="controls-bar">

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
                    {/* Render the picture if this message has one attached */}
                    {msg.image_base64 && (
                      <div className="bubble-image-container">
                        <img
                          src={`data:image/png;base64,${msg.image_base64}`}
                          alt="Screenshot context"
                          className="bubble-image"
                        />
                      </div>
                    )}
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
                            {copiedIndex === index ? (
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12"></polyline>
                              </svg>
                            ) : (
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                              </svg>
                            )}
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

          {/* Screenshot Preview Thumbnail Overlay */}
          {attachedImage && (
            <div className="screenshot-preview-container">
              <img
                src={`data:image/png;base64,${attachedImage}`}
                alt="Captured screen preview"
                className="screenshot-thumbnail"
              />
              <button
                type="button"
                className="detach-image-btn"
                onClick={() => setAttachedImage(null)}
                title="Remove screenshot"
              >
                ✕
              </button>
            </div>
          )}

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
            {/* Camera Screen Capture Button */}
            <button
              type="button"
              className={`capture-btn ${isCapturing ? "capturing" : ""}`}
              onClick={handleCaptureScreen}
              disabled={isLoading || isCapturing || voiceState === "speaking"}
              title="Capture current screen"
            >
              {isCapturing ? (
                <span className="capturing-loader"></span>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                  <circle cx="12" cy="13" r="4"></circle>
                </svg>
              )}
            </button>

            {/* Hidden file input */}
            <input
              type="file"
              id="file-upload-input"
              style={{ display: "none" }}
              accept="image/*,.txt,.md,.json,.js,.ts,.html,.css,.rs"
              onChange={handleFileUpload}
              disabled={isLoading || voiceState === "speaking"}
            />
            {/* Attachment Button */}
            <label
              htmlFor="file-upload-input"
              className="upload-btn"
              title="Attach image or text document"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
              </svg>
            </label>

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
