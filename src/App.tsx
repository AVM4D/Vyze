import { useState, useRef, useEffect } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event"; // Listen to selection wake events
import ReactMarkdown from "react-markdown"; // Parse markdown output
import "./App.css";

// Import Character Sprite Frames
import alert1 from "./assets/character/alert1.png";
import alert2 from "./assets/character/alert2.png";
import alert3 from "./assets/character/alert3.png";

import happy1 from "./assets/character/happy1.png";
import happy2 from "./assets/character/happy2.png";
import happy3 from "./assets/character/happy3.png";

import idle1 from "./assets/character/idle1.png";
import idle2 from "./assets/character/idle2.png";
import idle3 from "./assets/character/idle3.png";

import listen1 from "./assets/character/listen1.png";
import listen2 from "./assets/character/listen2.png";
import listen3 from "./assets/character/listen3.png";

import sleepy1 from "./assets/character/sleepy1.png";
import sleepy2 from "./assets/character/sleepy2.png";
import sleepy3 from "./assets/character/sleepy3.png";

import speak1 from "./assets/character/speak1.png";
import speak2 from "./assets/character/speak2.png";
import speak3 from "./assets/character/speak3.png";

// Import Theme Logos
import logoPink from "./assets/pink.png";
import logoCyan from "./assets/cyan.png";
import logoPurple from "./assets/purple.png";
import logoGrey from "./assets/grey.png";

const themeLogos: Record<string, string> = {
  "retro-pink": logoPink,
  cyberpunk: logoCyan,
  dracula: logoPurple,
  monochrome: logoGrey,
};

import think1 from "./assets/character/think1.png";
import think2 from "./assets/character/think2.png";
import think3 from "./assets/character/think3.png";

const characterSprites: Record<string, string[]> = {
  alert: [alert1, alert2, alert3],
  happy: [happy1, happy2, happy3],
  idle: [idle1, idle2, idle3],
  listen: [listen1, listen2, listen3],
  sleepy: [sleepy1, sleepy2, sleepy3],
  speak: [speak1, speak2, speak3],
  think: [think1, think2, think3],
};

type CharacterMood = "idle" | "happy" | "think" | "speak" | "listen" | "alert" | "sleepy";

interface PopularSpeaker {
  id: string;
  name: string;
  lang: string;
  keyword: string;
  defaultPitch: number;
}

const POPULAR_SPEAKERS: PopularSpeaker[] = [
  { id: "david", name: "Microsoft David (Male US)", lang: "en-US", keyword: "david", defaultPitch: 0.85 },
  { id: "zira", name: "Microsoft Zira (Female US)", lang: "en-US", keyword: "zira", defaultPitch: 1.25 },
  { id: "mark", name: "Microsoft Mark (Male US)", lang: "en-US", keyword: "mark", defaultPitch: 0.90 },
];

function CharacterPet({ mood }: { mood: CharacterMood }) {
  const [frameIdx, setFrameIdx] = useState(0);

  useEffect(() => {
    let direction = 1;
    const interval = setInterval(() => {
      setFrameIdx((prev) => {
        if (prev >= 2) direction = -1;
        if (prev <= 0) direction = 1;
        return prev + direction;
      });
    }, 350);
    return () => clearInterval(interval);
  }, []);

  const frames = characterSprites[mood] || characterSprites.idle;
  const currentSrc = frames[frameIdx % frames.length] || frames[0];

  return (
    <div className="character-pet-container" title={`Vyze Pet (${mood})`}>
      <img
        src={currentSrc}
        alt={`Character ${mood}`}
        className="character-pet-sprite"
      />
    </div>
  );
}

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
  const [voiceActive, _setVoiceActive] = useState(true); // If background listening is enabled
  const [voiceState, setVoiceState] = useState<"standby" | "dictating" | "speaking">("standby");
  const voiceStateRef = useRef(voiceState);

  // Screen Capture States
  const [attachedImage, setAttachedImage] = useState<string | null>(null); // Holds the base64 screenshot text
  const [isCapturing, setIsCapturing] = useState(false); // Shows if the app is taking a picture right now
  const [isAttachmentsCollapsed, setIsAttachmentsCollapsed] = useState(false); // Collapsible attached files state

  // Settings & Sessions States
  const [showSettings, setShowSettings] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [sessions, setSessions] = useState<DbSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitleText, setEditingTitleText] = useState("");
  const [autoCapture, setAutoCapture] = useState(() => localStorage.getItem("vyze_auto_capture") === "true");
  const [theme, setTheme] = useState(() => localStorage.getItem("vyze_theme") || "retro-pink");

  const [enableContextLimit, setEnableContextLimit] = useState<boolean>(() => {
    return localStorage.getItem("vyze_enable_context_limit") === "true";
  });
  const [maxDocContextLimit, setMaxDocContextLimit] = useState<number>(() => {
    const saved = localStorage.getItem("vyze_max_doc_context_limit");
    return saved ? parseInt(saved, 10) : 15000;
  });

  const [persona, setPersona] = useState<string>(() => localStorage.getItem("vyze_persona") || "balanced");
  const [customPrompt, setCustomPrompt] = useState<string>(() => localStorage.getItem("vyze_custom_prompt") || "");

  // Active Timers State and cancel handler
  interface ActiveTimer {
    id: string;
    label: string;
    duration_secs: number;
    remaining_secs: number;
  }
  const [activeTimers, setActiveTimers] = useState<ActiveTimer[]>([]);

  async function handleCancelTimer(id: string) {
    try {
      await invoke("cancel_timer", { id });
      setActiveTimers((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      console.error("Failed to cancel timer:", err);
    }
  }

  // Active timers countdown tick
  useEffect(() => {
    const interval = setInterval(() => {
      setActiveTimers((prev) => {
        return prev
          .map((t) => ({ ...t, remaining_secs: t.remaining_secs - 1 }))
          .filter((t) => t.remaining_secs > 0);
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);
  const [customPromptSaved, setCustomPromptSaved] = useState<boolean>(false);
  const [runningCommand, setRunningCommand] = useState<string | null>(null);

  // Session Documents RAG state variables
  const [sessionAttachments, setSessionAttachments] = useState<any[]>([]);
  const [ragProgress, setRagProgress] = useState<any>(null);
  const isStreamingAbortedRef = useRef<boolean>(false);
  const activeSessionIdRef = useRef(activeSessionId);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  // Character Pet & TTS Voice Selection States
  const [enableCharacterPet, setEnableCharacterPet] = useState<boolean>(() => {
    return localStorage.getItem("vyze_enable_character_pet") !== "false";
  });
  const [autostartEnabled, setAutostartEnabled] = useState<boolean>(false);

  useEffect(() => {
    invoke<boolean>("get_autostart")
      .then((val) => setAutostartEnabled(val))
      .catch(console.error);
  }, []);

  const handleToggleAutostart = (enabled: boolean) => {
    setAutostartEnabled(enabled);
    invoke("set_autostart", { enabled }).catch(console.error);
  };

  // Window Size Preset State (small: 460x420, medium: 640x540, large: 820x660)
  const [windowSizePreset, setWindowSizePreset] = useState<"small" | "medium" | "large">(
    () => (localStorage.getItem("vyze_window_size") as "small" | "medium" | "large") || "small"
  );

  useEffect(() => {
    localStorage.setItem("vyze_window_size", windowSizePreset);
    invoke("db_set_setting", { key: "window_size_preset", value: windowSizePreset }).catch(console.error);
    invoke("resize_vyze_window", { preset: windowSizePreset }).catch(console.error);
  }, [windowSizePreset]);

  // Enhanced Voice Selection States
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoiceName, setSelectedVoiceName] = useState<string>(() => {
    return localStorage.getItem("vyze_tts_voice") || "";
  });
  const [voicePitch, setVoicePitch] = useState<number>(() => {
    return parseFloat(localStorage.getItem("vyze_voice_pitch") || "1.0");
  });
  const [voiceRate, setVoiceRate] = useState<number>(() => {
    return parseFloat(localStorage.getItem("vyze_voice_rate") || "1.0");
  });

  // Unified Attachment Popover Menu State
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const [showAttachMenu, setShowAttachMenu] = useState<boolean>(false);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(event.target as Node)) {
        setShowAttachMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Warm up system voices inventory on boot & load available voices into state
  useEffect(() => {
    const loadVoices = () => {
      if (typeof window !== "undefined" && window.speechSynthesis) {
        const voices = window.speechSynthesis.getVoices();
        if (voices && voices.length > 0) {
          setAvailableVoices(voices);
        }
      }
    };

    loadVoices();
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("vyze_tts_voice", selectedVoiceName);
    invoke("db_set_setting", { key: "tts_voice", value: selectedVoiceName }).catch(console.error);
  }, [selectedVoiceName]);

  useEffect(() => {
    localStorage.setItem("vyze_voice_pitch", String(voicePitch));
    invoke("db_set_setting", { key: "voice_pitch", value: String(voicePitch) }).catch(console.error);
  }, [voicePitch]);

  useEffect(() => {
    localStorage.setItem("vyze_voice_rate", String(voiceRate));
    invoke("db_set_setting", { key: "voice_rate", value: String(voiceRate) }).catch(console.error);
  }, [voiceRate]);

  const handleTestVoicePreview = () => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const sampleText = "Hello! I am Vyze. Here is how your selected voice sounds.";
    const utterance = new SpeechSynthesisUtterance(sampleText);
    utterance.rate = voiceRate;

    const systemVoices = availableVoices.length > 0 ? availableVoices : window.speechSynthesis.getVoices();
    let appliedPitch = voicePitch;

    if (selectedVoiceName) {
      const exactMatch = systemVoices.find((v) => v.name === selectedVoiceName);
      if (exactMatch) {
        utterance.voice = exactMatch;
      } else {
        const speaker = POPULAR_SPEAKERS.find((s) => s.id === selectedVoiceName || s.name === selectedVoiceName);
        if (speaker) {
          const keywordMatch = systemVoices.find((v) => v.name.toLowerCase().includes(speaker.keyword));
          if (keywordMatch) {
            utterance.voice = keywordMatch;
          } else {
            appliedPitch = voicePitch * speaker.defaultPitch;
          }
        }
      }
    }
    utterance.pitch = appliedPitch;
    window.speechSynthesis.speak(utterance);
  };

  // Populate system TTS voices on load and when voices change in OS
  useEffect(() => {
    const loadVoices = () => {
      if (typeof window !== "undefined" && window.speechSynthesis) {
        const voices = window.speechSynthesis.getVoices();
        setAvailableVoices(voices);
      }
    };

    loadVoices();
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("vyze_enable_character_pet", String(enableCharacterPet));
    invoke("db_set_setting", { key: "enable_character_pet", value: String(enableCharacterPet) }).catch(console.error);
  }, [enableCharacterPet]);

  useEffect(() => {
    localStorage.setItem("vyze_tts_voice", selectedVoiceName);
    invoke("db_set_setting", { key: "tts_voice", value: selectedVoiceName }).catch(console.error);
  }, [selectedVoiceName]);
  const [happyBurst, setHappyBurst] = useState(false);
  const [isSleepy, setIsSleepy] = useState(false);
  const lastActivityRef = useRef<number>(Date.now());

  // Track user activity to trigger sleepy mood after 25s of inactivity
  useEffect(() => {
    const handleActivity = () => {
      lastActivityRef.current = Date.now();
      setIsSleepy(false);
    };

    window.addEventListener("keydown", handleActivity);
    window.addEventListener("mousemove", handleActivity);
    window.addEventListener("click", handleActivity);

    const interval = setInterval(() => {
      if (Date.now() - lastActivityRef.current > 25000) {
        setIsSleepy(true);
      }
    }, 3000);

    return () => {
      window.removeEventListener("keydown", handleActivity);
      window.removeEventListener("mousemove", handleActivity);
      window.removeEventListener("click", handleActivity);
      clearInterval(interval);
    };
  }, []);

  function triggerHappyBurst() {
    setHappyBurst(true);
    setTimeout(() => setHappyBurst(false), 2500);
  }

  let petMood: CharacterMood = "idle";
  if (happyBurst) {
    petMood = "happy";
  } else if (isLoading) {
    petMood = "think";
  } else if (voiceState === "speaking") {
    petMood = "speak";
  } else if (voiceState === "dictating") {
    petMood = "listen";
  } else if (prompt.trim().length > 0 || selectedText || attachedImage) {
    petMood = "alert";
  } else if (isSleepy) {
    petMood = "sleepy";
  } else {
    petMood = "idle";
  }

  // API Keys & Custom Model Setup States
  const [geminiApiKey, setGeminiApiKey] = useState<string>(() => localStorage.getItem("vyze_gemini_api_key") || "");
  const [geminiModel, setGeminiModel] = useState<string>(() => localStorage.getItem("vyze_gemini_model") || "");

  const [openaiApiKey, setOpenaiApiKey] = useState<string>(() => localStorage.getItem("vyze_openai_api_key") || "");
  const [openaiModel, setOpenaiModel] = useState<string>(() => localStorage.getItem("vyze_openai_model") || "");

  const [anthropicApiKey, setAnthropicApiKey] = useState<string>(() => localStorage.getItem("vyze_anthropic_api_key") || "");
  const [anthropicModel, setAnthropicModel] = useState<string>(() => localStorage.getItem("vyze_anthropic_model") || "");

  const [ollamaBaseUrl, setOllamaBaseUrl] = useState<string>(() => localStorage.getItem("vyze_ollama_base_url") || "http://127.0.0.1:11434");
  const [ollamaModel, setOllamaModel] = useState<string>(() => localStorage.getItem("vyze_ollama_model") || "qwen2.5vl:7b");

  interface CommandResult {
    stdout: string;
    stderr: string;
    exit_code: number;
  }

  async function handleRunCommand(cmdToRun: string) {
    setRunningCommand(cmdToRun);
    try {
      const res = await invoke<CommandResult>("run_terminal_command", { command: cmdToRun, cwd: null });
      let outputText = `\n\n[Terminal Execution Output for '${cmdToRun}']:\n`;
      if (res.stdout.trim()) {
        outputText += `\`\`\`powershell\n${res.stdout.trim()}\n\`\`\`\n`;
      }
      if (res.stderr.trim()) {
        outputText += `\n*Stderr/Errors*:\n\`\`\`powershell\n${res.stderr.trim()}\n\`\`\`\n`;
      }
      if (!res.stdout.trim() && !res.stderr.trim()) {
        outputText += `*(Process finished cleanly with exit code ${res.exit_code})*\n`;
      }

      setMessages((prev) => [...prev, { role: "assistant", content: outputText, image_base64: null }]);

      if (activeSessionId) {
        invoke("db_add_message", {
          sessionId: activeSessionId,
          role: "assistant",
          content: outputText,
          imageBase64: null,
        }).catch(console.error);
      }
    } catch (err: any) {
      setMessages((prev) => [...prev, { role: "assistant", content: `\n\n[Terminal Execution Failed]: ${err}`, image_base64: null }]);
    } finally {
      setRunningCommand(null);
    }
  }

  function getRunnableTerminalCommand(content: string): string | null {
    if (!content || !content.includes("```")) return null;

    // Suppress action execution button if the message is primarily natural text / essay / explanation (> 120 chars of non-code text)
    const textWithoutCode = content.replace(/```[\s\S]*?```/g, "").trim();
    if (textWithoutCode.length > 120) {
      return null;
    }

    // Suppress automation block pseudo-code from being run as terminal commands
    if (content.includes("```automation") || content.includes("action:") || content.includes("app_name:")) {
      return null;
    }

    // Suppress commands containing placeholders like <filename>, <branch-name>
    if (/<[a-zA-Z0-9_\-\s]+>|\[[a-zA-Z0-9_\-\s]+\]/.test(content)) {
      return null;
    }

    // Suppress non-shell programming code snippets
    if (
      content.includes("```html") ||
      content.includes("```tsx") ||
      content.includes("```jsx") ||
      content.includes("```css") ||
      content.includes("```json") ||
      content.includes("```python") ||
      content.includes("```rust")
    ) {
      return null;
    }

    const regex = /```(?:powershell|bash|sh|cmd|terminal|exec)?\n?([\s\S]*?)```/gi;
    let match;
    const extractedLines: string[] = [];

    while ((match = regex.exec(content)) !== null) {
      if (match[1]) {
        const lines = match[1].split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (
            trimmed &&
            !trimmed.startsWith("#") &&
            !trimmed.startsWith("//") &&
            !trimmed.toLowerCase().startsWith("step ") &&
            !trimmed.toLowerCase().startsWith("option ") &&
            !trimmed.toLowerCase().startsWith("action:") &&
            !trimmed.toLowerCase().startsWith("app_name:")
          ) {
            extractedLines.push(trimmed);
          }
        }
      }
    }

    if (extractedLines.length === 0) return null;

    // Suppress educational command lists containing > 4 lines/commands
    if (extractedLines.length > 4) return null;

    let cleanCmd = extractedLines.join("; ");
    // Convert 'cd D:\Path' to PowerShell 'Set-Location -Path "D:\Path"' for reliable drive switching
    cleanCmd = cleanCmd.replace(/^cd\s+([A-Za-z]:\\[^\s;]+)/i, 'Set-Location -Path "$1"');
    cleanCmd = cleanCmd.replace(/;\s*cd\s+([A-Za-z]:\\[^\s;]+)/gi, '; Set-Location -Path "$1"');

    return cleanCmd || null;
  }

  interface AutomationAction {
    action: string;
    target: string;
    label: string;
  }

  async function handleRunAutomation(action_type: string, target: string) {
    try {
      setRunningCommand(`automation:${action_type}`);
      const res = await invoke<string>("execute_os_automation", { actionType: action_type, target });
      playBeep();
      triggerHappyBurst();

      let displayRes = res;
      if (action_type === "set_timer") {
        try {
          const timerData = JSON.parse(res);
          setActiveTimers((prev) => [
            ...prev,
            {
              id: timerData.id,
              label: timerData.label,
              duration_secs: timerData.duration_secs,
              remaining_secs: timerData.duration_secs,
            }
          ]);
          displayRes = `⏰ Timer set for ${timerData.duration_secs} seconds: "${timerData.label}"`;
        } catch (e) {
          console.error("Failed to parse timer JSON response:", e);
        }
      }

      if (displayRes && displayRes !== "Execution successful" && displayRes !== "URI opened successfully" && !displayRes.startsWith("Launched")) {
        setMessages((prev) => [...prev, { role: "assistant", content: `\n\n${displayRes}`, image_base64: null }]);
      }
    } catch (err: any) {
      setMessages((prev) => [...prev, { role: "assistant", content: `\n\n[OS Automation Failed]: ${err}`, image_base64: null }]);
    } finally {
      setRunningCommand(null);
    }
  }

  function getRunnableAutomationAction(content: string): AutomationAction | null {
    if (!content) return null;

    // 1. Direct Code Block Match: ```automation ... ```
    const match = /```automation\s*\n?([\s\S]*?)```/i.exec(content);
    if (match && match[1]) {
      const lines = match[1].split("\n");
      let action = "";
      let target = "";
      for (const line of lines) {
        if (line.toLowerCase().startsWith("action:")) {
          action = line.substring(7).trim();
        } else if (line.toLowerCase().startsWith("target:")) {
          target = line.substring(7).trim();
        } else if (line.toLowerCase().startsWith("app_name:")) {
          action = "open_app";
          target = line.substring(9).trim();
        }
      }
      if (action && target) {
        let label = `executing ${action.toLowerCase()}...`;
        if (target.includes("youtube.com")) label = "opening youtube...";
        else if (target.includes("spotify:") || target.toLowerCase() === "spotify") label = "opening spotify...";
        else if (target.includes("whatsapp:")) label = "opening whatsapp...";
        else if (target.includes("mailto:")) label = "opening mail client...";
        else if (action === "set_brightness") label = `adjusting brightness to ${target}%...`;
        else if (action === "set_volume") label = `adjusting volume to ${target}%...`;
        else if (action === "power_control") label = `executing ${target}...`;
        else if (action === "media_control") label = `media command: ${target}...`;
        else if (action === "system_status") label = "fetching system status...";
        else if (action === "open_app") label = `opening ${target.toLowerCase()}...`;

        return { action, target, label };
      }
    }

    return null;
  }

  function parsePromptAutomationIntent(promptText: string): AutomationAction | null {
    const clean = promptText.trim().toLowerCase();
    if (!clean) return null;

    // 1. Media Controls
    if (clean === "pause" || clean === "play" || clean === "resume" || clean === "pause music" || clean === "play music" || clean === "toggle playback") {
      return { action: "media_control", target: "play_pause", label: "toggling media playback..." };
    }
    if (clean === "next" || clean === "next song" || clean === "next track" || clean === "skip song") {
      return { action: "media_control", target: "next", label: "skipping to next track..." };
    }
    if (clean === "prev" || clean === "previous" || clean === "prev song" || clean === "previous track") {
      return { action: "media_control", target: "prev", label: "previous track..." };
    }
    if (clean === "unmute") {
      return { action: "media_control", target: "unmute", label: "unmuting audio..." };
    }
    if (clean === "mute" || clean === "mute audio") {
      return { action: "media_control", target: "mute", label: "muting audio..." };
    }
    if (clean === "volume up" || clean === "louder") {
      return { action: "media_control", target: "volume_up", label: "increasing volume..." };
    }
    if (clean === "volume down" || clean === "quieter") {
      return { action: "media_control", target: "volume_down", label: "decreasing volume..." };
    }

    // 2. WhatsApp Direct Intent
    if (clean.includes("whatsapp") || clean.includes("send message to")) {
      const callMatch = /(?:whatsapp call|call on whatsapp|call)\s+(.+)/i.exec(promptText);
      if (callMatch) {
        const contact = callMatch[1].replace(/on whatsapp/i, "").trim();
        const isNumeric = /^[+\d\s()-.]{5,}$/.test(contact);
        if (isNumeric) {
          const phone = contact.replace(/[^\d]/g, "");
          return {
            action: "open_uri",
            target: `whatsapp://call?phone=${phone}`,
            label: `initiating WhatsApp call to ${phone}...`
          };
        } else {
          return {
            action: "open_app",
            target: "whatsapp",
            label: `opening WhatsApp to call ${contact}...`
          };
        }
      }

      const msgMatch = /(?:send\s+)?(?:whatsapp\s+message\s+|message\s+|whatsapp\s+|text\s+)(?:to\s+)?([A-Za-z0-9\s+()-]+)\s*(?:saying|message|text)?\s*(.+)/i.exec(promptText);
      if (msgMatch) {
        const contact = msgMatch[1].trim();
        const text = msgMatch[2].trim();
        const isNumeric = /^[+\d\s()-.]{5,}$/.test(contact);
        if (isNumeric) {
          const phone = contact.replace(/[^\d]/g, "");
          return {
            action: "open_uri",
            target: `whatsapp://send?phone=${phone}&text=${encodeURIComponent(text)}`,
            label: `sending WhatsApp message to ${phone}...`
          };
        } else {
          // Open WhatsApp send with text, allowing contact choice
          return {
            action: "open_uri",
            target: `whatsapp://send?text=${encodeURIComponent(text)}`,
            label: `opening WhatsApp contact picker to message ${contact}...`
          };
        }
      }
    }

    // 3. Email Direct Intent
    if (clean.includes("email") || clean.includes("mail") || clean.includes("mailto")) {
      const emailRegex = /([a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4})/;
      const emailMatch = emailRegex.exec(promptText);
      if (emailMatch) {
        const email = emailMatch[1];
        let subject = "Vyze Draft";
        let body = "";
        
        // Match subject cleanly by terminating at "body" or "saying" or end
        const subjectMatch = /subject\s+(.+?)(?:\s+body\s+|\s+saying\s+|$)/i.exec(promptText);
        const bodyMatch = /body\s+(.+)/i.exec(promptText);
        const sayingMatch = /saying\s+(.+)/i.exec(promptText);
        
        if (subjectMatch) {
          subject = subjectMatch[1].trim();
        }
        if (bodyMatch) {
          body = bodyMatch[1].trim();
        } else if (sayingMatch) {
          body = sayingMatch[1].trim();
        }
        
        let uriTarget = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        let label = `drafting email to ${email}...`;
        
        if (clean.includes("gmail")) {
          uriTarget = `https://mail.google.com/mail/?view=cm&fs=1&to=${email}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
          label = `opening Gmail in browser to draft email to ${email}...`;
        }

        return {
          action: "open_uri",
          target: uriTarget,
          label
        };
      }
    }

    // 4. Discord Direct Intent
    if (clean.includes("discord")) {
      const serverChannelMatch = /discord\s+(?:server|guild)\s+(\d+)\s+channel\s+(\d+)/i.exec(promptText);
      if (serverChannelMatch) {
        return {
          action: "open_uri",
          target: `discord://discord.com/channels/${serverChannelMatch[1]}/${serverChannelMatch[2]}`,
          label: `jumping to Discord channel ${serverChannelMatch[2]}...`
        };
      }
      const serverMatch = /discord\s+(?:server|guild)\s+(\d+)/i.exec(promptText);
      if (serverMatch) {
        return {
          action: "open_uri",
          target: `discord://discord.com/channels/${serverMatch[1]}`,
          label: `jumping to Discord server ${serverMatch[1]}...`
        };
      }
      const channelMatch = /discord\s+channel\s+(\d+)/i.exec(promptText);
      if (channelMatch) {
        return {
          action: "open_uri",
          target: `discord://discord.com/channels/@me/${channelMatch[1]}`,
          label: `jumping to Discord DM/Channel ${channelMatch[1]}...`
        };
      }
    }

    // 5. Timers & Reminders Direct Intent
    if (clean.includes("timer") || clean.includes("remind")) {
      const remindMatch = /remind me to\s+(.+?)\s+in\s+(\d+)\s*(hour|minute|second|min|sec|hr)s?/i.exec(promptText);
      if (remindMatch) {
        const label = remindMatch[1].trim();
        const val = parseInt(remindMatch[2], 10);
        const unit = remindMatch[3].toLowerCase();
        let multiplier = 1;
        if (unit.startsWith("min")) multiplier = 60;
        else if (unit.startsWith("hour") || unit.startsWith("hr")) multiplier = 3600;
        
        const totalSecs = val * multiplier;
        return {
          action: "set_timer",
          target: `${totalSecs}|${label}`,
          label: `setting reminder for '${label}' in ${val} ${unit}...`
        };
      }
      
      const timerMatch = /(?:set\s+a?\s*timer\s+(?:for|of)?\s*)?(\d+)\s*(hour|minute|second|min|sec|hr)s?\s*(?:called|for|named)?\s*(.*)/i.exec(promptText);
      if (timerMatch) {
        const val = parseInt(timerMatch[1], 10);
        const unit = timerMatch[2].toLowerCase();
        const label = timerMatch[3].trim() || "Timer";
        let multiplier = 1;
        if (unit.startsWith("min")) multiplier = 60;
        else if (unit.startsWith("hour") || unit.startsWith("hr")) multiplier = 3600;
        
        const totalSecs = val * multiplier;
        return {
          action: "set_timer",
          target: `${totalSecs}|${label}`,
          label: `setting timer for ${val} ${unit} (${label})...`
        };
      }
    }

    // 6. File Utilities (Create & Search) Direct Intent
    if (clean.includes("file") || clean.includes("note")) {
      const createFileMatch = /(?:create|make)\s+file\s+(\S+)\s+(?:with content|containing|saying)\s+(.+)/i.exec(promptText);
      if (createFileMatch) {
        return {
          action: "create_file",
          target: `${createFileMatch[1]}|${createFileMatch[2].trim()}`,
          label: `creating file '${createFileMatch[1]}' on Desktop...`
        };
      }
      const createNoteMatch = /(?:create|make)\s+note\s+(\S+)\s+(?:with content|containing|saying)\s+(.+)/i.exec(promptText);
      if (createNoteMatch) {
        return {
          action: "create_file",
          target: `${createNoteMatch[1]}|${createNoteMatch[2].trim()}`,
          label: `creating note '${createNoteMatch[1]}'...`
        };
      }
      const quickNoteMatch = /(?:create|make)\s+note\s+(.+)/i.exec(promptText);
      if (quickNoteMatch) {
        return {
          action: "create_file",
          target: `note.txt|${quickNoteMatch[1].trim()}`,
          label: "creating note.txt on Desktop..."
        };
      }
      const searchMatch = /(?:search|find)\s+(?:local\s+)?files\s+(?:for|matching)\s+(.+)/i.exec(promptText);
      if (searchMatch) {
        let q = searchMatch[1].trim();
        // Remove scoping suffix like "on my desktop", "on desktop", "in downloads"
        q = q.replace(/\s+(?:on|in)\s+(?:my\s+)?(?:desktop|downloads|documents)$/i, "").trim();
        q = q.replace(/^["']|["']$/g, ""); // strip quotes
        return {
          action: "search_files",
          target: q,
          label: `searching files for '${q}'...`
        };
      }
    }

    // 7. Local File Explorer Search Intent (search-ms: protocol)
    if (
      clean.startsWith("search files for ") ||
      clean.startsWith("search local files for ") ||
      clean.startsWith("search file explorer for ") ||
      clean.startsWith("search files ") ||
      clean.startsWith("search local files ") ||
      clean.startsWith("find file ") ||
      clean.startsWith("find folder ") ||
      clean.includes("in file explorer") ||
      clean.includes("in explorer")
    ) {
      const q = promptText
        .replace(/^(?:search|find)\s+(?:local\s+)?(?:files|folder|file explorer)?\s*(?:for|in)?\s*/i, "")
        .replace(/\s+in (?:file )?explorer$/i, "")
        .trim();
      if (q) {
        return {
          action: "open_uri",
          target: `search-ms:query=${encodeURIComponent(q)}`,
          label: `searching File Explorer for '${q}'...`
        };
      }
    }

    // 8. Spotify Search & Playback Intent
    if (clean.includes("spotify")) {
      const match = /(?:search|play)\s+(.+?)(?:\s+(?:on|in)\s+spotify|\s+spotify|$)/i.exec(promptText);
      let q = match && match[1] ? match[1].replace(/^spotify\s*/i, "").replace(/\s*spotify$/i, "").trim() : "";
      if (!q || q === "open" || q === "launch") q = "music";
      if (clean === "open spotify" || clean === "launch spotify" || clean === "spotify") {
        return { action: "open_app", target: "spotify", label: "opening spotify..." };
      }
      return {
        action: "open_uri",
        target: `spotify:search:${encodeURIComponent(q)}`,
        label: `searching Spotify for '${q}'...`
      };
    }

    // 9. YouTube Search & Playback Intent
    if (clean.includes("youtube")) {
      const match = /(?:search|play|watch)\s+(.+?)(?:\s+(?:on|in)\s+youtube|\s+youtube|$)/i.exec(promptText);
      let q = match && match[1] ? match[1].replace(/^youtube\s*/i, "").replace(/\s*youtube$/i, "").trim() : "";
      if (clean === "open youtube" || clean === "launch youtube" || clean === "youtube") {
        return { action: "open_uri", target: "https://www.youtube.com", label: "opening youtube..." };
      }
      const url = q ? `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` : "https://www.youtube.com";
      return {
        action: "open_uri",
        target: url,
        label: q ? `searching YouTube for '${q}'...` : "opening youtube..."
      };
    }

    // 10. Developer Platform Searches (GitHub, StackOverflow, npm, PyPI)
    if (clean.startsWith("search github for ") || clean.includes("on github")) {
      const q = promptText.replace(/^(?:search\s+)?github\s*(?:for)?\s*/i, "").replace(/\s+on github$/i, "").trim();
      return { action: "search_dev", target: `github|${q}`, label: `searching GitHub for '${q}'...` };
    }
    if (clean.startsWith("search stackoverflow for ") || clean.startsWith("search so for ") || clean.includes("on stackoverflow") || clean.includes("on so")) {
      const q = promptText.replace(/^(?:search\s+)?(?:stackoverflow|so)\s*(?:for)?\s*/i, "").replace(/\s+on (?:stackoverflow|so)$/i, "").trim();
      return { action: "search_dev", target: `stackoverflow|${q}`, label: `searching StackOverflow for '${q}'...` };
    }
    if (clean.startsWith("search npm for ") || clean.includes("on npm")) {
      const q = promptText.replace(/^(?:search\s+)?npm\s*(?:for)?\s*/i, "").replace(/\s+on npm$/i, "").trim();
      return { action: "search_dev", target: `npm|${q}`, label: `searching npm for '${q}'...` };
    }
    if (clean.startsWith("search pypi for ") || clean.includes("on pypi")) {
      const q = promptText.replace(/^(?:search\s+)?pypi\s*(?:for)?\s*/i, "").replace(/\s+on pypi$/i, "").trim();
      return { action: "search_dev", target: `pypi|${q}`, label: `searching PyPI for '${q}'...` };
    }

    // 11. Navigation & Local Info (Google Maps / Weather)
    if (clean.startsWith("search maps for ") || clean.startsWith("directions to ") || clean.includes("on maps")) {
      const q = promptText.replace(/^(?:search maps for|directions to)\s+/i, "").replace(/\s+on maps$/i, "").trim();
      return { action: "search_web", target: `maps|${q}`, label: `searching Maps for '${q}'...` };
    }
    if (clean.startsWith("weather in ") || clean.startsWith("weather ") || clean.startsWith("forecast for ")) {
      const q = promptText.replace(/^(?:weather in|weather|forecast for)\s+/i, "").trim();
      return { action: "search_web", target: `weather|${q}`, label: `checking weather for '${q}'...` };
    }

    // 12. Alternative Web Search Engines (Bing / DuckDuckGo)
    if (clean.startsWith("search bing for ") || clean.includes("on bing")) {
      const q = promptText.replace(/^(?:search\s+)?bing\s*(?:for)?\s*/i, "").replace(/\s+on bing$/i, "").trim();
      return { action: "search_web", target: `bing|${q}`, label: `searching Bing for '${q}'...` };
    }
    if (clean.startsWith("search duckduckgo for ") || clean.startsWith("search ddg for ") || clean.includes("on duckduckgo") || clean.includes("on ddg")) {
      const q = promptText.replace(/^(?:search\s+)?(?:duckduckgo|ddg)\s*(?:for)?\s*/i, "").replace(/\s+on (?:duckduckgo|ddg)$/i, "").trim();
      return { action: "search_web", target: `duckduckgo|${q}`, label: `searching DuckDuckGo for '${q}'...` };
    }

    // 13. General Google Web Search Intent
    if (
      clean.startsWith("search google for ") ||
      clean.startsWith("seacrh google for ") ||
      clean.includes("on google") ||
      clean.startsWith("google ") ||
      clean.startsWith("search web for ") ||
      clean.startsWith("search ") ||
      clean.startsWith("seacrh ")
    ) {
      const q = promptText
        .replace(/^(?:search|seacrh)?\s*(?:google|web)?\s*(?:for)?\s*/i, "")
        .replace(/\s+on google$/i, "")
        .trim();
      if (q) {
        return { action: "search_web", target: `google|${q}`, label: `searching Google for '${q}'...` };
      }
    }

    // 14. Power & Session Intent
    if (clean.includes("lock pc") || clean.includes("lock computer") || clean.includes("lock workstation") || clean === "lock") {
      return { action: "power_control", target: "lock", label: "locking workstation..." };
    }
    if (clean.includes("sleep pc") || clean.includes("put pc to sleep") || clean === "sleep") {
      return { action: "power_control", target: "sleep", label: "putting pc to sleep..." };
    }
    if (clean.includes("restart pc") || clean.includes("reboot computer")) {
      return { action: "power_control", target: "restart", label: "restarting computer..." };
    }
    if (clean.includes("shutdown pc") || clean.includes("turn off computer")) {
      return { action: "power_control", target: "shutdown", label: "shutting down computer..." };
    }

    // 15. System Status & Hardware Telemetry Intent
    if (clean.includes("system status") || clean.includes("hardware status") || clean.includes("battery status") || clean.includes("cpu usage") || clean.includes("ram usage")) {
      return { action: "system_status", target: "report", label: "fetching system status..." };
    }

    // 16. Process Management Intent
    if (clean.includes("list processes") || clean.includes("top processes") || clean.includes("running processes")) {
      return { action: "process_control", target: "list|", label: "listing top processes..." };
    }
    if (clean.startsWith("kill process ") || clean.startsWith("kill app ")) {
      const targetApp = clean.replace(/^(?:kill process|kill app)\s+/i, "").trim();
      return { action: "process_control", target: `kill|${targetApp}`, label: `killing process ${targetApp}...` };
    }
    if (clean.startsWith("close ") || clean.startsWith("terminate ") || clean.startsWith("kill ")) {
      const app = clean.replace(/^(?:close|terminate|kill)\s+/i, "").trim();
      if (app && app !== "processes" && app !== "process" && app !== "active processes" && app !== "window" && app !== "pc" && app !== "computer") {
        return {
          action: "process_control",
          target: `kill|${app}`,
          label: `terminating process ${app}...`
        };
      }
    }

    // 17. Brightness Intent
    if (clean.includes("brightness")) {
      const numMatch = /\b([0-9]{1,3})\b/.exec(clean);
      const level = numMatch ? parseInt(numMatch[1], 10) : 80;
      return { action: "set_brightness", target: String(level), label: `adjusting brightness to ${level}%...` };
    }

    // 18. Volume Intent
    if (clean.includes("volume")) {
      const numMatch = /\b([0-9]{1,3})\b/.exec(clean);
      const level = numMatch ? parseInt(numMatch[1], 10) : 50;
      return { action: "set_volume", target: String(level), label: `adjusting volume to ${level}%...` };
    }

    // 19. Window Management Intent
    if (clean === "minimize all" || clean === "show desktop" || clean === "toggle desktop") {
      return { action: "window_management", target: "toggle_desktop", label: "toggling desktop..." };
    }

    // 20. Universal Application & Folder Launcher Intent
    if (clean.startsWith("open ") || clean.startsWith("launch ") || clean.startsWith("start ")) {
      const rawTarget = clean.replace(/^(?:open|launch|start)\s+/i, "").trim();
      if (rawTarget) {
        return { action: "open_app", target: rawTarget, label: `opening ${rawTarget}...` };
      }
    }

    return null;
  }

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
    localStorage.setItem("vyze_enable_context_limit", String(enableContextLimit));
    invoke("db_set_setting", { key: "enable_context_limit", value: String(enableContextLimit) }).catch(console.error);
  }, [enableContextLimit]);

  useEffect(() => {
    localStorage.setItem("vyze_max_doc_context_limit", String(maxDocContextLimit));
    invoke("db_set_setting", { key: "max_doc_context_limit", value: String(maxDocContextLimit) }).catch(console.error);
  }, [maxDocContextLimit]);

  useEffect(() => {
    localStorage.setItem("vyze_persona", persona);
    invoke("db_set_setting", { key: "persona_key", value: persona }).catch(console.error);
  }, [persona]);

  useEffect(() => {
    localStorage.setItem("vyze_gemini_api_key", geminiApiKey);
    invoke("db_set_setting", { key: "gemini_api_key", value: geminiApiKey }).catch(console.error);
  }, [geminiApiKey]);

  useEffect(() => {
    localStorage.setItem("vyze_gemini_model", geminiModel);
    invoke("db_set_setting", { key: "gemini_model", value: geminiModel }).catch(console.error);
  }, [geminiModel]);

  useEffect(() => {
    localStorage.setItem("vyze_openai_api_key", openaiApiKey);
    invoke("db_set_setting", { key: "openai_api_key", value: openaiApiKey }).catch(console.error);
  }, [openaiApiKey]);

  useEffect(() => {
    localStorage.setItem("vyze_openai_model", openaiModel);
    invoke("db_set_setting", { key: "openai_model", value: openaiModel }).catch(console.error);
  }, [openaiModel]);

  useEffect(() => {
    localStorage.setItem("vyze_anthropic_api_key", anthropicApiKey);
    invoke("db_set_setting", { key: "anthropic_api_key", value: anthropicApiKey }).catch(console.error);
  }, [anthropicApiKey]);

  useEffect(() => {
    localStorage.setItem("vyze_anthropic_model", anthropicModel);
    invoke("db_set_setting", { key: "anthropic_model", value: anthropicModel }).catch(console.error);
  }, [anthropicModel]);

  useEffect(() => {
    localStorage.setItem("vyze_ollama_base_url", ollamaBaseUrl);
    invoke("db_set_setting", { key: "ollama_base_url", value: ollamaBaseUrl }).catch(console.error);
  }, [ollamaBaseUrl]);

  useEffect(() => {
    localStorage.setItem("vyze_ollama_model", ollamaModel);
    invoke("db_set_setting", { key: "ollama_model", value: ollamaModel }).catch(console.error);
  }, [ollamaModel]);

  useEffect(() => {
    localStorage.setItem("vyze_custom_prompt", customPrompt);
    invoke("db_set_setting", { key: "custom_system_prompt", value: customPrompt }).catch(console.error);
  }, [customPrompt]);

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

      // Load session attachments
      try {
        const docs = await invoke<any[]>("get_session_attachments", { sessionId: sid });
        setSessionAttachments(docs);
      } catch (err) {
        console.error("Failed to load session attachments:", err);
      }
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
      setSessionAttachments([]); // Clear attachments
      setShowSidebar(false);
    } catch (err) {
      console.error("Failed to create new session:", err);
    }
  }

  async function handleAttachFilesToSession() {
    let currentSid = activeSessionId;
    if (!currentSid) {
      try {
        currentSid = await invoke<string>("db_create_session", { title: "New Chat" });
        const updated = await invoke<DbSession[]>("db_get_sessions");
        setSessions(updated);
        setActiveSessionId(currentSid);
      } catch (err) {
        console.error("Failed to create session on file attach:", err);
        return;
      }
    }
    try {
      const msg = await invoke<string>("select_and_attach_files", {
        sessionId: currentSid,
        provider: provider
      });
      console.log(msg);
      await loadMessagesForSession(currentSid);
    } catch (err) {
      console.error("Failed to attach files to session:", err);
    }
  }

  async function handleAttachFolderToSession() {
    let currentSid = activeSessionId;
    if (!currentSid) {
      try {
        currentSid = await invoke<string>("db_create_session", { title: "New Chat" });
        const updated = await invoke<DbSession[]>("db_get_sessions");
        setSessions(updated);
        setActiveSessionId(currentSid);
      } catch (err) {
        console.error("Failed to create session on folder attach:", err);
        return;
      }
    }
    try {
      const msg = await invoke<string>("select_and_attach_folder", {
        sessionId: currentSid,
        provider: provider
      });
      console.log(msg);
      await loadMessagesForSession(currentSid);
    } catch (err) {
      console.error("Failed to attach folder to session:", err);
    }
  }

  async function handleDetachDocument(docId: number) {
    try {
      await invoke("delete_session_attachment", { documentId: docId });
      setSessionAttachments((prev) => prev.filter((d) => d.id !== docId));
    } catch (err) {
      console.error("Failed to detach document from session:", err);
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
          setSessionAttachments([]);
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
      setSessionAttachments([]); // Clear attachments
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

  const activeUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  // Text-To-Speech response reader helper
  function stopSpeaking() {
    if (activeUtteranceRef.current) {
      activeUtteranceRef.current.onstart = null;
      activeUtteranceRef.current.onend = null;
      activeUtteranceRef.current.onerror = null;
      activeUtteranceRef.current = null;
    }
    try {
      window.speechSynthesis.cancel();
    } catch (e) {
      console.warn("speechSynthesis cancel error:", e);
    }
    setVoiceState("standby");
  }

  function speakText(text: string) {
    stopSpeaking();
    if (!voiceActive || !voiceNarration) {
      setVoiceState("standby");
      return;
    }

    // Strip automation blocks completely from TTS voice synthesis
    const cleanTextWithoutAutomation = text.replace(/```automation[\s\S]*?```/gi, "");

    // Clean up markdown markers for natural voice synthesis
    const cleanText = cleanTextWithoutAutomation
      .replace(/[*#`_\-]/g, "")
      .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
      .trim();

    if (!cleanText) {
      setVoiceState("standby");
      return;
    }

    const utterance = new SpeechSynthesisUtterance(cleanText);
    activeUtteranceRef.current = utterance;
    utterance.volume = 1.0;
    utterance.rate = voiceRate;

    // Find the voice selected by the user or fallback to system default
    const systemVoices = availableVoices.length > 0 ? availableVoices : window.speechSynthesis.getVoices();
    let appliedPitch = voicePitch;

    if (selectedVoiceName) {
      const userSelectedVoice = systemVoices.find((v) => v.name === selectedVoiceName);
      if (userSelectedVoice) {
        utterance.voice = userSelectedVoice;
      } else {
        const speaker = POPULAR_SPEAKERS.find((s) => s.id === selectedVoiceName || s.name === selectedVoiceName);
        if (speaker) {
          const keywordMatch = systemVoices.find((v) => v.name.toLowerCase().includes(speaker.keyword));
          if (keywordMatch) {
            utterance.voice = keywordMatch;
          } else {
            appliedPitch = voicePitch * speaker.defaultPitch;
          }
        }
      }
    } else {
      const targetVoice = systemVoices.find(
        (v) =>
          v.name.toLowerCase().includes("prabhat") ||
          v.name.toLowerCase().includes("prabahat") ||
          v.name.toLowerCase().includes("ava") ||
          v.name.toLowerCase().includes("mark") ||
          v.name.toLowerCase().includes("zira") ||
          v.name.toLowerCase().includes("david")
      );

      if (targetVoice) {
        utterance.voice = targetVoice;
      } else {
        const defaultVoice = systemVoices.find((v) => v.default === true);
        if (defaultVoice) {
          utterance.voice = defaultVoice;
        }
      }
    }

    utterance.pitch = appliedPitch;

    utterance.onstart = () => {
      setVoiceState("speaking");
    };

    utterance.onend = () => {
      if (activeUtteranceRef.current === utterance) {
        activeUtteranceRef.current = null;
        setVoiceState("standby");
      }
    };

    utterance.onerror = (e) => {
      console.error("SpeechSynthesisUtterance error:", e);
      if (activeUtteranceRef.current === utterance) {
        activeUtteranceRef.current = null;
        setVoiceState("standby");
      }
    };

    setVoiceState("speaking");
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

  // Native WASAPI Voice Dictation handler
  async function handleToggleVoice() {
    if (voiceState === "speaking") {
      stopSpeaking();
      return;
    }

    if (voiceState === "dictating") {
      setVoiceState("standby");
      try {
        setIsLoading(true);
        const transcribedText = await invoke<string>("stop_voice_recording");
        if (transcribedText.trim()) {
          setPrompt((prev) => (prev ? `${prev} ${transcribedText.trim()}` : transcribedText.trim()));
          playBeep();
        }
      } catch (err) {
        console.error("Voice transcription failed:", err);
      } finally {
        setIsLoading(false);
      }
    } else {
      try {
        await invoke("start_voice_recording");
        setVoiceState("dictating");
        playBeep();
      } catch (err) {
        console.error("Failed to start native recording:", err);
      }
    }
  }

  // 1. Listen for the global selection, silent screen capture events, and timers from Rust
  useEffect(() => {
    let active = true;
    let unsubscribes: (() => void)[] = [];

    async function setupListeners() {
      // Listen for text selection capture
      const u1 = await listen<string>("selection-captured", (event) => {
        if (!active) return;
        const text = event.payload;
        if (text && text.trim()) {
          setSelectedText(text.trim());
        }

        // Auto-Focus the input field as soon as the HUD wakes up
        setTimeout(() => {
          inputRef.current?.focus();
        }, 50);
      });
      unsubscribes.push(u1);

      // Listen for silent auto screen capture complete
      const u2 = await listen<string>("auto-screen-captured", (event) => {
        if (!active) return;
        const base64 = event.payload;
        if (base64) {
          setAttachedImage(base64);
          playBeep(); // Beep to signal that the hidden capture succeeded!
        }
      });
      unsubscribes.push(u2);

      // Listen for background timer finished event
      const u3 = await listen<{ id: string; label: string; duration_secs: number }>("timer-finished", (event) => {
        if (!active) return;
        const { id, label } = event.payload;
        playBeep();

        const finishMsg: Message = {
          role: "assistant",
          content: `⏰ **Timer Finished**: "${label}" is complete!`,
          image_base64: null
        };
        setMessages((prev) => [...prev, finishMsg]);

        // Narrate completion aloud if voice narration is active
        speakText(`Timer ${label} is complete!`);

        // Remove timer from the local React list
        setActiveTimers((prev) => prev.filter((t) => t.id !== id));
      });
      unsubscribes.push(u3);

      // Listen for RAG ingestion progress events
      const u4 = await listen<any>("rag-progress", (event) => {
        if (!active) return;
        const payload = event.payload;
        setRagProgress(payload);
        
        if (payload.status === "complete") {
          playBeep();
          const currentSid = activeSessionIdRef.current;
          if (currentSid) {
            invoke<any[]>("get_session_attachments", { sessionId: currentSid })
              .then(setSessionAttachments)
              .catch(console.error);
          }
          setTimeout(() => setRagProgress(null), 3500);
        }
      });
      unsubscribes.push(u4);
    }

    setupListeners();

    // Clean up event listeners on unmount
    return () => {
      active = false;
      for (const unsub of unsubscribes) {
        unsub();
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
    stopSpeaking();
    setVoiceState("standby");

    // Immediate execution for explicit user automation intent (Direct OS Actions)
    const promptAction = parsePromptAutomationIntent(promptText);
    if (promptAction) {
      const userMsg: Message = {
        role: "user",
        content: promptText,
        image_base64: attachedImage
      };

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
          imageBase64: attachedImage,
          provider: provider
        }).catch(console.error);

        const currentSession = sessions.find((s) => s.id === currentSid);
        if (currentSession && (currentSession.title === "New Chat" || currentSession.title.trim() === "")) {
          const shortTitle = promptText.length > 20 ? promptText.slice(0, 20) + "..." : promptText;
          invoke("db_update_session_title", { id: currentSid, title: shortTitle }).catch(console.error);
          setSessions((prev) =>
            prev.map((s) => (s.id === currentSid ? { ...s, title: shortTitle } : s))
          );
        }
      }

      setMessages((prev) => [...prev, userMsg]);
      setSelectedText("");
      setAttachedImage(null);
      setIsLoading(true);
      setRunningCommand(`automation:${promptAction.action}`);

      try {
        const res = await invoke<string>("execute_os_automation", {
          actionType: promptAction.action,
          target: promptAction.target
        });
        playBeep();
        triggerHappyBurst();

        let responseContent = (res && res !== "Execution successful" && res !== "URI opened successfully" && !res.startsWith("Launched")) ? res : `✓ ${promptAction.label.replace("...", "")}`;
        
        if (promptAction.action === "set_timer") {
          try {
            const timerData = JSON.parse(res);
            setActiveTimers((prev) => [
              ...prev,
              {
                id: timerData.id,
                label: timerData.label,
                duration_secs: timerData.duration_secs,
                remaining_secs: timerData.duration_secs,
              }
            ]);
            responseContent = `⏰ Timer set for ${timerData.duration_secs} seconds: "${timerData.label}"`;
          } catch (e) {
            console.error("Failed to parse timer JSON response:", e);
          }
        }

        const assistantMsg: Message = {
          role: "assistant",
          content: responseContent,
          image_base64: null
        };

        setMessages((prev) => [...prev, assistantMsg]);

        if (currentSid) {
          invoke("db_add_message", {
            sessionId: currentSid,
            role: "assistant",
            content: responseContent,
            imageBase64: null,
            provider: provider
          }).catch(console.error);
        }
      } catch (err: any) {
        const errMsg = `[OS Automation Failed]: ${err}`;
        setMessages((prev) => [...prev, { role: "assistant", content: errMsg, image_base64: null }]);
      } finally {
        setIsLoading(false);
        setRunningCommand(null);
      }
      return; // Return early: direct OS commands do not invoke LLM stream!
    }

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
        imageBase64: attachedImage,
        provider: provider
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
    isStreamingAbortedRef.current = false;
    setIsLoading(true);

    try {
      const tokenChannel = new Channel<string>();
      let fullResponse = "";

      // Append incoming streaming tokens to assistant bubble
      tokenChannel.onmessage = (token: string) => {
        if (isStreamingAbortedRef.current) return;
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
      if (currentSid && fullResponse.trim() && !isStreamingAbortedRef.current) {
        invoke("db_add_message", {
          sessionId: currentSid,
          role: "assistant",
          content: fullResponse,
          imageBase64: null,
          provider: provider
        }).catch(console.error);
      }

      if (isStreamingAbortedRef.current) {
        setVoiceState("standby");
        return;
      }

      // Auto-execute OS desktop automation immediately if detected!
      const autoAction = getRunnableAutomationAction(fullResponse);
      if (autoAction) {
        handleRunAutomation(autoAction.action, autoAction.target);
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
    setVoiceState("standby");
    setPrompt((currentPrompt) => {
      if (currentPrompt.trim()) {
        triggerSubmit(currentPrompt);
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

    triggerHappyBurst();
    const text = prompt;
    setPrompt("");
    await triggerSubmit(text);
  }

  return (
    <div className={`hud-container theme-${theme} preset-${windowSizePreset}`}>
      {/* Animated Character Pet Widget (Peeks out from behind top-right of window card) */}
      {enableCharacterPet && <CharacterPet mood={petMood} />}

      <div className="hud-card">
        {/* Absolute Crooked Sticker Tab Header (Pops out of the card container) */}
        <div className="hud-header" data-tauri-drag-region>
          <div className="hud-brand" data-tauri-drag-region>
            <img
              src={themeLogos[theme] || logoPink}
              alt="Vyze Theme Logo"
              className="hud-theme-logo-img"
              data-tauri-drag-region
            />
            <span className="hud-title" data-tauri-drag-region>VYZE</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "2px" }}>
            <button
              type="button"
              className="sidebar-toggle-btn"
              onClick={() => {
                setShowSidebar(!showSidebar);
                if (showSettings) setShowSettings(false);
              }}
              title="Chat History"
            >
              <svg className="header-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
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
              <svg className="header-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
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
                <label className="select-setting-label">Default Model Provider:</label>
                <select
                  className="theme-select"
                  value={defaultProvider}
                  onChange={(e) => setDefaultProvider(e.target.value)}
                >
                  <option value="gemini">Google Gemini</option>
                  <option value="openai">OpenAI (ChatGPT)</option>
                  <option value="anthropic">Anthropic (Claude)</option>
                  <option value="ollama">Local Ollama</option>
                </select>
              </div>

              {/* API & Model Setup Section */}
              <div className="api-setup-section" style={{ borderTop: "1px dashed var(--border-color)", paddingTop: "8px", marginTop: "4px" }}>
                <h5 style={{ margin: "0 0 6px 0", fontSize: "0.75em", color: "var(--primary-color)", textTransform: "uppercase" }}>API & Model Setup</h5>

                {/* Gemini Setup */}
                <div style={{ display: "flex", flexDirection: "column", gap: "2px", marginBottom: "6px" }}>
                  <label className="select-setting-label" style={{ fontSize: "0.65em" }}>Gemini API Key / Model:</label>
                  <div style={{ display: "flex", gap: "4px" }}>
                    <input
                      type="password"
                      placeholder="Paste Gemini API Key..."
                      value={geminiApiKey}
                      onKeyDown={(e) => e.stopPropagation()}
                      onChange={(e) => setGeminiApiKey(e.target.value)}
                      style={{ flex: 1, fontSize: "0.7em", padding: "2px 4px", background: "var(--bg-input)", color: "var(--fg-main)", border: "1px solid var(--border-color)", borderRadius: "2px" }}
                    />
                    <input
                      type="text"
                      placeholder="e.g. gemini-1.5-flash"
                      value={geminiModel}
                      onKeyDown={(e) => e.stopPropagation()}
                      onChange={(e) => setGeminiModel(e.target.value)}
                      style={{ width: "95px", fontSize: "0.7em", padding: "2px 4px", background: "var(--bg-input)", color: "var(--fg-main)", border: "1px solid var(--border-color)", borderRadius: "2px" }}
                    />
                  </div>
                </div>

                {/* OpenAI Setup */}
                <div style={{ display: "flex", flexDirection: "column", gap: "2px", marginBottom: "6px" }}>
                  <label className="select-setting-label" style={{ fontSize: "0.65em" }}>OpenAI API Key / Model:</label>
                  <div style={{ display: "flex", gap: "4px" }}>
                    <input
                      type="password"
                      placeholder="Paste OpenAI API Key..."
                      value={openaiApiKey}
                      onKeyDown={(e) => e.stopPropagation()}
                      onChange={(e) => setOpenaiApiKey(e.target.value)}
                      style={{ flex: 1, fontSize: "0.7em", padding: "2px 4px", background: "var(--bg-input)", color: "var(--fg-main)", border: "1px solid var(--border-color)", borderRadius: "2px" }}
                    />
                    <input
                      type="text"
                      placeholder="e.g. gpt-4o"
                      value={openaiModel}
                      onKeyDown={(e) => e.stopPropagation()}
                      onChange={(e) => setOpenaiModel(e.target.value)}
                      style={{ width: "95px", fontSize: "0.7em", padding: "2px 4px", background: "var(--bg-input)", color: "var(--fg-main)", border: "1px solid var(--border-color)", borderRadius: "2px" }}
                    />
                  </div>
                </div>

                {/* Anthropic Setup */}
                <div style={{ display: "flex", flexDirection: "column", gap: "2px", marginBottom: "6px" }}>
                  <label className="select-setting-label" style={{ fontSize: "0.65em" }}>Anthropic API Key / Model:</label>
                  <div style={{ display: "flex", gap: "4px" }}>
                    <input
                      type="password"
                      placeholder="Paste Claude API Key..."
                      value={anthropicApiKey}
                      onKeyDown={(e) => e.stopPropagation()}
                      onChange={(e) => setAnthropicApiKey(e.target.value)}
                      style={{ flex: 1, fontSize: "0.7em", padding: "2px 4px", background: "var(--bg-input)", color: "var(--fg-main)", border: "1px solid var(--border-color)", borderRadius: "2px" }}
                    />
                    <input
                      type="text"
                      placeholder="e.g. claude-3-5-sonnet-20241022"
                      value={anthropicModel}
                      onKeyDown={(e) => e.stopPropagation()}
                      onChange={(e) => setAnthropicModel(e.target.value)}
                      style={{ width: "95px", fontSize: "0.7em", padding: "2px 4px", background: "var(--bg-input)", color: "var(--fg-main)", border: "1px solid var(--border-color)", borderRadius: "2px" }}
                    />
                  </div>
                </div>

                {/* Ollama Setup */}
                <div style={{ display: "flex", flexDirection: "column", gap: "2px", marginBottom: "6px" }}>
                  <label className="select-setting-label" style={{ fontSize: "0.65em" }}>Ollama Base URL / Model:</label>
                  <div style={{ display: "flex", gap: "4px" }}>
                    <input
                      type="text"
                      placeholder="http://127.0.0.1:11434"
                      value={ollamaBaseUrl}
                      onKeyDown={(e) => e.stopPropagation()}
                      onChange={(e) => setOllamaBaseUrl(e.target.value)}
                      style={{ flex: 1, fontSize: "0.7em", padding: "2px 4px", background: "var(--bg-input)", color: "var(--fg-main)", border: "1px solid var(--border-color)", borderRadius: "2px" }}
                    />
                    <input
                      type="text"
                      placeholder="e.g. qwen2.5vl:7b"
                      value={ollamaModel}
                      onKeyDown={(e) => e.stopPropagation()}
                      onChange={(e) => setOllamaModel(e.target.value)}
                      style={{ width: "95px", fontSize: "0.7em", padding: "2px 4px", background: "var(--bg-input)", color: "var(--fg-main)", border: "1px solid var(--border-color)", borderRadius: "2px" }}
                    />
                  </div>
                </div>
              </div>

              <div className="settings-option">
                <label className="checkbox-setting-label">
                  <input
                    type="checkbox"
                    className="setting-checkbox"
                    checked={enableCharacterPet}
                    onChange={(e) => setEnableCharacterPet(e.target.checked)}
                  />
                  <span>Show Character</span>
                </label>
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
              {/* Window Size Preset Option */}
              <div className="settings-option" style={{ flexDirection: "column", alignItems: "flex-start", gap: "4px" }}>
                <label className="select-setting-label">Vyze Window Size:</label>
                <div className="preset-btn-group">
                  <button
                    type="button"
                    className={`preset-btn ${windowSizePreset === "small" ? "active" : ""}`}
                    onClick={() => setWindowSizePreset("small")}
                  >
                    Small
                  </button>
                  <button
                    type="button"
                    className={`preset-btn ${windowSizePreset === "medium" ? "active" : ""}`}
                    onClick={() => setWindowSizePreset("medium")}
                  >
                    Medium
                  </button>
                  <button
                    type="button"
                    className={`preset-btn ${windowSizePreset === "large" ? "active" : ""}`}
                    onClick={() => setWindowSizePreset("large")}
                  >
                    Large
                  </button>
                </div>
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

              <div className="settings-option" style={{ flexDirection: "column", alignItems: "flex-start", gap: "4px", width: "100%" }}>
                <div style={{ display: "flex", justifyContent: "space-between", width: "100%", alignItems: "center" }}>
                  <label className="select-setting-label">Voice Speaker:</label>
                  <button
                    type="button"
                    className="test-voice-btn"
                    onClick={handleTestVoicePreview}
                    title="Test current voice speech settings"
                  >
                    TEST VOICE
                  </button>
                </div>
                <select
                  className="theme-select"
                  style={{ width: "100%", boxSizing: "border-box" }}
                  value={selectedVoiceName}
                  onChange={(e) => setSelectedVoiceName(e.target.value)}
                >
                  <option value="">Default OS Speaker</option>
                  <optgroup label="Popular Speakers">
                    {POPULAR_SPEAKERS.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                  {availableVoices.length > 0 && (
                    <optgroup label="Installed System Voices">
                      {availableVoices.map((v) => (
                        <option key={v.name} value={v.name}>
                          {v.name} ({v.lang})
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>

              <div className="settings-option" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                <label className="select-setting-label">Pitch ({voicePitch.toFixed(2)}):</label>
                <input
                  type="range"
                  min="0.5"
                  max="1.5"
                  step="0.05"
                  className="voice-range-slider"
                  value={voicePitch}
                  onChange={(e) => setVoicePitch(parseFloat(e.target.value))}
                  style={{ width: "130px" }}
                />
              </div>

              <div className="settings-option" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                <label className="select-setting-label">Speed ({voiceRate.toFixed(2)}x):</label>
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.05"
                  className="voice-range-slider"
                  value={voiceRate}
                  onChange={(e) => setVoiceRate(parseFloat(e.target.value))}
                  style={{ width: "130px" }}
                />
              </div>
              <div className="settings-option">
                <label className="checkbox-setting-label">
                  <input
                    type="checkbox"
                    className="setting-checkbox"
                    checked={autostartEnabled}
                    onChange={(e) => handleToggleAutostart(e.target.checked)}
                  />
                  <span>Start Vyze on Windows boot</span>
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
                <label className="checkbox-setting-label">
                  <input
                    type="checkbox"
                    className="setting-checkbox"
                    checked={enableContextLimit}
                    onChange={(e) => setEnableContextLimit(e.target.checked)}
                  />
                  <span>Limit web & file context size</span>
                </label>
              </div>
              {enableContextLimit && (
                <div className="settings-option" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <label className="select-setting-label">Max Chars:</label>
                  <input
                    type="number"
                    className="context-limit-input"
                    value={maxDocContextLimit}
                    onChange={(e) => setMaxDocContextLimit(Math.max(1000, parseInt(e.target.value || "0", 10)))}
                    step="1000"
                    min="1000"
                    style={{ width: "90px", padding: "2px 4px", fontSize: "0.8em", background: "var(--bg-input)", color: "var(--fg-main)", border: "1.5px solid var(--border-color)", borderRadius: "3px" }}
                  />
                </div>
              )}
              <div className="settings-option">
                <label className="select-setting-label">Personality:</label>
                <select
                  className="theme-select"
                  value={persona}
                  onChange={(e) => setPersona(e.target.value)}
                >
                  <option value="balanced">Balanced</option>
                  <option value="tutor">Scholar</option>
                  <option value="writer">Wordsmith</option>
                  <option value="coach">Strategist</option>
                  <option value="witty">Witty</option>
                  <option value="engineer">Architect</option>
                  <option value="custom">Custom</option>
                </select>
              </div>

              {persona === "custom" && (
                <div className="custom-instructions-group">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <label className="select-setting-label">Custom Instructions:</label>
                    {customPromptSaved && (
                      <span style={{ fontSize: "0.65em", color: "#22c55e", fontWeight: "bold" }}>✓ Saved</span>
                    )}
                  </div>
                  <textarea
                    className="custom-prompt-textarea"
                    value={customPrompt}
                    onKeyDown={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      setCustomPrompt(e.target.value);
                      setCustomPromptSaved(true);
                      setTimeout(() => setCustomPromptSaved(false), 2000);
                    }}
                    placeholder="e.g. Speak like a pirate or always use bullet points..."
                    rows={2}
                  />
                </div>
              )}

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

            {/* Native Voice Dictation / Speech Stop Button */}
            <button
              type="button"
              className={`voice-toggle-btn ${voiceState === "dictating" ? "recording" : voiceState === "speaking" ? "speaking-active" : "active"
                }`}
              onClick={handleToggleVoice}
              title={
                voiceState === "speaking"
                  ? "Click to Stop Speech Narration"
                  : voiceState === "dictating"
                    ? "Click to Stop & Transcribe"
                    : "Click to Speak"
              }
            >
              <span
                className={`voice-led ${voiceState === "dictating" ? "recording" : voiceState === "speaking" ? "speaking-led" : voiceState
                  }`}
              ></span>
              <span className="voice-text">
                {voiceState === "speaking"
                  ? "STOP SPEAKING"
                  : voiceState === "dictating"
                    ? "RECORDING..."
                    : `VOICE: ${voiceState.toUpperCase()}`}
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
                <option value="openai">OpenAI</option>
                <option value="anthropic">Claude</option>
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

          {/* Session Documents/Folders Attachments Tray */}
          {sessionAttachments.length > 0 && (
            <div className="attachments-tray" style={{ margin: "4px 12px", padding: "6px 8px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "4px" }}>
              <div style={{ fontSize: "0.65em", fontWeight: "bold", color: "var(--fg-main)", marginBottom: "4px", opacity: 0.8, textTransform: "uppercase", letterSpacing: "0.5px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ cursor: "pointer" }} onClick={() => setIsAttachmentsCollapsed(!isAttachmentsCollapsed)}>
                  {isAttachmentsCollapsed ? "▶ Show" : "▼ Hide"} Attached Knowledge Base ({sessionAttachments.length})
                </span>
                <button
                  type="button"
                  onClick={() => setIsAttachmentsCollapsed(!isAttachmentsCollapsed)}
                  style={{ background: "none", border: "none", color: "var(--primary-color)", fontSize: "0.9em", cursor: "pointer", fontWeight: "bold" }}
                >
                  {isAttachmentsCollapsed ? "expand" : "collapse"}
                </button>
              </div>
              {!isAttachmentsCollapsed && (
                <div className="attachments-list" style={{ display: "flex", flexWrap: "wrap", gap: "4px", maxHeight: "65px", overflowY: "auto", paddingRight: "2px" }}>
                  {sessionAttachments.map((doc) => (
                    <div key={doc.id} style={{ display: "flex", alignItems: "center", gap: "4px", background: "var(--bg-input)", padding: "2px 6px", borderRadius: "3px", fontSize: "0.75em", border: "1.1px solid var(--border-color)" }}>
                      <span style={{ color: "var(--primary-color)", fontSize: "0.95em" }}>📄</span>
                      <span style={{ color: "var(--fg-main)", maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={doc.file_path}>
                        {doc.file_name}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleDetachDocument(doc.id)}
                        style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: "1.1em", padding: "0 2px" }}
                        title="Remove document from chat context"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* RAG indexing progress banner */}
          {ragProgress && (
            <div className="rag-progress-banner" style={{ margin: "4px 12px", padding: "6px 8px", background: "rgba(234, 179, 8, 0.12)", border: "1px solid rgba(234, 179, 8, 0.25)", borderRadius: "4px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.72em", color: "var(--fg-main)" }}>
                <span className="spinner" style={{ display: "inline-block", width: "9px", height: "9px", border: "1.5px solid var(--fg-main)", borderTopColor: "transparent", borderRadius: "50%", marginRight: "4px" }}></span>
                {ragProgress.status === "processing" ? (
                  <span>Indexing: <strong style={{ color: "var(--primary-color)" }}>{ragProgress.file_name}</strong> ({ragProgress.current}/{ragProgress.total})</span>
                ) : ragProgress.status === "complete" ? (
                  <span style={{ color: "#22c55e", fontWeight: "bold" }}>✓ Indexing complete! ({ragProgress.total_ingested} files loaded)</span>
                ) : (
                  <span>Initializing document indexer...</span>
                )}
              </div>
            </div>
          )}

          {/* Active Timers List Drawer */}
          {activeTimers.length > 0 && (
            <div className="active-timers-container" style={{ margin: "8px 12px", padding: "8px", background: "rgba(0,0,0,0.2)", border: "1.5px solid var(--border-color)", borderRadius: "4px" }}>
              <div style={{ fontSize: "0.68em", fontWeight: "bold", color: "var(--primary-color)", marginBottom: "4px", textTransform: "uppercase", letterSpacing: "0.5px" }}>Active Timers</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                {activeTimers.map((t) => (
                  <div key={t.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "0.75em", background: "rgba(255,255,255,0.05)", padding: "4px 8px", borderRadius: "3px", border: "1px solid rgba(255,255,255,0.08)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <span>⏰</span>
                      <strong style={{ color: "var(--fg-main)" }}>{t.label}</strong>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span style={{ fontFamily: "monospace", color: "var(--primary-color)", fontWeight: "bold" }}>
                        {Math.floor(t.remaining_secs / 60)}:{(t.remaining_secs % 60).toString().padStart(2, "0")}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCancelTimer(t.id)}
                        style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: "0.9em", padding: 0 }}
                        title="Cancel timer"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
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
                        <ReactMarkdown
                          components={{
                            code({ inline, className, children, ...props }) {
                              const match = /language-(\w+)/.exec(className || '');
                              if (!inline && match && match[1] === 'automation') {
                                return null;
                              }
                              return <code className={className} {...props}>{children}</code>;
                            }
                          }}
                        >
                          {msg.content}
                        </ReactMarkdown>
                        {msg.role === "assistant" && (() => {
                          const runnableCmd = getRunnableTerminalCommand(msg.content);
                          const autoAction = getRunnableAutomationAction(msg.content);

                          if (runnableCmd) {
                            return (
                              <div className="action-proposal-card">
                                <button
                                  type="button"
                                  className="run-action-btn"
                                  disabled={runningCommand !== null}
                                  onClick={() => handleRunCommand(runnableCmd)}
                                >
                                  {runningCommand ? "executing command..." : `run command: ${runnableCmd.length > 30 ? runnableCmd.substring(0, 30) + '...' : runnableCmd}`}
                                </button>
                              </div>
                            );
                          }

                          if (autoAction) {
                            return (
                              <div className="action-proposal-card">
                                <button
                                  type="button"
                                  className="run-action-btn automation-btn"
                                  disabled={runningCommand !== null}
                                  onClick={() => handleRunAutomation(autoAction.action, autoAction.target)}
                                >
                                  {runningCommand === `automation:${autoAction.action}` ? "executing..." : autoAction.label}
                                </button>
                              </div>
                            );
                          }

                          return null;
                        })()}
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
            {/* Hidden file input */}
            <input
              type="file"
              id="file-upload-input"
              style={{ display: "none" }}
              accept="image/*,.txt,.md,.json,.js,.ts,.html,.css,.rs"
              onChange={handleFileUpload}
              disabled={isLoading || voiceState === "speaking"}
            />

            {/* Unified Attachment & Context Popover Menu */}
            <div className="attach-menu-container" ref={attachMenuRef}>
              <button
                type="button"
                className={`attach-toggle-btn ${showAttachMenu ? "active" : ""}`}
                onClick={() => setShowAttachMenu(!showAttachMenu)}
                disabled={isLoading || voiceState === "speaking"}
                title="Add Attachments, Files, Folders or Screen Capture"
              >
                <svg className="attach-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
              </button>

              {showAttachMenu && (
                <div className="attach-popover-menu">
                  <button
                    type="button"
                    className="attach-menu-item"
                    onClick={() => {
                      setShowAttachMenu(false);
                      handleAttachFilesToSession();
                    }}
                  >
                    <svg className="menu-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                      <polyline points="14 2 14 8 20 8"></polyline>
                      <line x1="12" y1="18" x2="12" y2="12"></line>
                      <line x1="9" y1="15" x2="15" y2="15"></line>
                    </svg>
                    <span>Attach Files (RAG)</span>
                  </button>

                  <button
                    type="button"
                    className="attach-menu-item"
                    onClick={() => {
                      setShowAttachMenu(false);
                      handleAttachFolderToSession();
                    }}
                  >
                    <svg className="menu-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                      <line x1="12" y1="17" x2="12" y2="11"></line>
                      <line x1="9" y1="14" x2="15" y2="14"></line>
                    </svg>
                    <span>Attach Folder (RAG)</span>
                  </button>

                  <button
                    type="button"
                    className="attach-menu-item"
                    onClick={() => {
                      setShowAttachMenu(false);
                      setTimeout(() => {
                        document.getElementById("file-upload-input")?.click();
                      }, 50);
                    }}
                  >
                    <svg className="menu-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
                    </svg>
                    <span>Attach Image / Doc</span>
                  </button>

                  <button
                    type="button"
                    className={`attach-menu-item ${isCapturing ? "capturing" : ""}`}
                    onClick={() => {
                      setShowAttachMenu(false);
                      handleCaptureScreen();
                    }}
                    disabled={isCapturing}
                  >
                    <svg className="menu-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                      <circle cx="12" cy="13" r="4"></circle>
                    </svg>
                    <span>Capture Screen</span>
                  </button>
                </div>
              )}
            </div>

            {isLoading ? (
              <button
                type="button"
                className="stop-generation-btn"
                onClick={() => {
                  isStreamingAbortedRef.current = true;
                  setIsLoading(false);
                  stopSpeaking();
                  invoke("cancel_ai_stream").catch(console.error);
                }}
                title="Stop AI response generation"
              >
                ■ STOP
              </button>
            ) : (
              <button type="submit" className="send-button">
                Send
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

export default App;
