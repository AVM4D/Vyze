# Vyze — Project Planning

## Resolving conflicts between prior drafts

Two earlier stack proposals disagreed on the core architecture. This plan resolves those conflicts explicitly:

**Python FastAPI backend — rejected.** The whole reason Tauri was chosen over Electron was idle footprint (30–50MB vs 120–300MB) for an always-on app. Adding a Python interpreter + FastAPI + asyncio as a sidecar process reintroduces that same cost, plus extra IPC glue between Rust and Python on top of Tauri's own bridge. Every capability it was meant to provide already has a first-class Rust equivalent:

| Python tool | Rust/Tauri equivalent |
|---|---|
| `pynput` | `tauri-plugin-global-shortcut` |
| `pyperclip` / `pywin32` | `tauri-plugin-clipboard-manager` |
| `mss` | `xcap` |

No functionality gap — only a familiarity preference, which isn't worth doubling the runtime footprint of an always-on process.

**Gemini Live as the *only* AI engine — rejected; kept as one option, added later.** See the resolved open decision below — hardcoding a single provider contradicts the pluggable cloud/local router that's the app's core abstraction.

**Continuous 100 FPS screen capture — rejected.** Vyze doesn't need to watch the screen continuously — only grab a frame on trigger (hotkey, highlight event, vision fallback). Continuous high-FPS capture is idle-resource waste that contradicts the "always-on app, idle usage matters most" design goal. Capture-on-demand only.

Everything else — OS integration approach, hybrid screen-understanding pipeline, memory/vector store, voice stack, and the 10-item feature list — was already sound and carries forward unchanged.

---

## Resolved: Gemini Live sequencing

**Decision: discrete STT/TTS (Whisper/Piper/cloud APIs) first; Gemini Live's duplex streaming added later as a specialized provider.**

```
┌─────────────────────────────────────────────────────────────┐
│                 V1 CORE AI ROUTER INTERFACE                 │
└──────────────────────────────┬──────────────────────────────┘
                               │
       ┌───────────────────────┴───────────────────────┐
       ▼                                               ▼
┌───────────────────────────────┐               ┌───────────────────────────────┐
│ DISCRETE TEXT/AUDIO ROUTER    │               │ DUPLEX WEBSOCKET STREAMING    │
│ (Claude, OpenAI, Ollama)      │               │ (Gemini Live)                 │
├───────────────────────────────┤               ├───────────────────────────────┤
│ • Input: String / Image       │               │ • Input: Raw PCM binary stream│
│ • Output: Streamed text tokens│               │ • Output: Continuous PCM bytes│
│ • State: Simple request/resp  │               │ • State: Complex duplex tunnel│
└───────────────────────────────┘               └───────────────────────────────┘
```

Why this protects the V1 timeline and architectural clarity:

1. **Protocol asymmetry.** Standard cloud APIs (Anthropic, OpenAI) and local Ollama nodes use plain HTTP REST / SSE, streaming text tokens. Gemini Live instead requires a continuous, stateful, bi-directional WebSocket full-duplex tunnel streaming raw 16kHz binary PCM bytes — a fundamentally different transport model.
2. **Interface pollution.** Forcing the core V1 AI router (`trait AiProvider`) to accommodate duplex binary WebSockets on day one over-complicates the initial trait abstraction before a text popup even renders.
3. **Decoupled iteration.** Building local/discrete cloud STT (Whisper) → text router → TTS (Piper) gives a clean, modular pipeline. Once the text router and UI audio-buffer player work seamlessly, adding Gemini Live as a specialized streaming provider in step 6 is far cleaner than retrofitting it in from day one.

This resolution updates the build order below (step 6 no longer needs an early websocket-streaming abstraction) and the AI backend router section (Gemini Live is explicitly a later addition, not a v1-day-one provider).

---

## Core architecture

```
┌─────────────────────────────────────────────┐
│                  VYZE (Tauri v2)             │
├───────────────────────┬───────────────────────┤
│   Frontend (WebView)   │     Rust Core         │
│  React + TS + Tailwind │  (single process)     │
│  - Popup / HUD         │  - System hooks        │
│  - Chat panel          │  - Hotkeys/clipboard   │
│  - Settings            │  - AI backend router   │
│                        │  - Screen capture       │
│                        │  - SQLite + vector store│
└───────────────────────┴───────────────────────┘
              │ IPC (Tauri bridge, in-process)
```

One runtime, one process family, no cross-language sidecar.

---

## 1. Shell — Tauri v2
- **Frontend (UI):** React + TypeScript + Tailwind
- **Core logic:** Rust — owns all system access
- No Python, no separate backend server

## 2. OS-level integration

| Need | Windows | macOS |
|---|---|---|
| Global text selection detection | UI Automation API (`windows-rs`) | Accessibility API (`cocoa`/`objc`) |
| Global hotkey / wake trigger | `tauri-plugin-global-shortcut` | same |
| Clipboard read/write | `tauri-plugin-clipboard-manager` | same |
| Screenshot capture (on-demand only) | `xcap` | same |
| Background/tray presence | Tauri tray API + autostart plugin | same |

This remains the riskiest layer — accessibility APIs behave differently per-app, and macOS requires the user to explicitly grant Accessibility + Screen Recording permissions. Budget real time here.

## 3. Screen understanding (hybrid)
1. **First pass — accessibility tree:** cheap, instant, exact text — works in browsers, editors, most native apps, Office
2. **Optional cheap middle tier — local OCR** (Tesseract or PaddleOCR) for pure text-extraction cases, avoiding a vision-model call
3. **Fallback — screenshot (captured on-demand) + vision model:** triggered when the accessibility tree is empty or the app is non-compliant (games, canvas-based tools like Figma, some Electron apps)

## 4. AI backend — pluggable router

The single most important abstraction in the app. One interface (`sendMessage`, `streamResponse`) with swappable providers behind it — everything else (voice, popup, generation) calls into it without caring where the model lives.

- **Cloud (v1):** Anthropic API, OpenAI API — plain HTTP REST / SSE, text-token streaming
- **Local (v1):** Ollama — background service exposing an OpenAI-compatible endpoint at `localhost:11434/v1`, drops into the same interface with zero special-casing. Supports Llama, Mistral, Qwen, DeepSeek, etc., with automatic GPU acceleration (CUDA, ROCm, Apple Silicon)
- **Cloud (later addition):** Gemini Live — added as a specialized duplex-streaming provider once the discrete text router and audio pipeline are proven (see resolved open decision above)
- **Settings UI:** model picker (cloud provider + model, or local model list pulled live from Ollama) with a default and a per-task override

## 5. Voice (STT / TTS / wake word)

| Function | Local option | Cloud option (v1) | Later addition |
|---|---|---|---|
| Speech-to-text | whisper.cpp (offline Whisper) | Deepgram / OpenAI STT | Gemini Live (duplex) |
| Text-to-speech | Piper (offline, fast) | ElevenLabs / OpenAI TTS | Gemini Live (duplex) |
| Wake word | Picovoice Porcupine (on-device, low CPU) | — (local-only by design; must run continuously without hitting an API) | — |

Barge-in (interrupting Vyze mid-response) requires the audio playback stream to be cancelable the moment new mic input is detected — a concrete requirement for the discrete STT/TTS pipeline, and one that carries over cleanly to Gemini Live once it's added.

## 6. Memory / persistence
- **Structured data** (sessions, tasks, settings): embedded SQLite
- **Semantic memory** (recall relevant past context, not just chronological logs): local vector store — SQLite with the `sqlite-vec` extension, or an embeddable option like LanceDB — storing embeddings of past interactions
- Local-first by design; cloud sync layer can be added later for cross-device memory, not needed for v1

## 7. Camera / screen share
- Camera preview: WebView `getUserMedia`
- Screen share (sharing *out*, distinct from Vyze reading your own screen): platform capture APIs via a Tauri plugin
- Every stream behind an explicit OS permission prompt and visible on-screen indicator; nothing recorded to disk by default

## 8. File / app / terminal access
- Tauri's scoped filesystem APIs (scoped, not blanket access)
- Cross-app automation: AppleScript (macOS), PowerShell/Win32 APIs (Windows)
- Any destructive action (delete, overwrite, run a command) shows a preview/diff and requires explicit confirmation — non-negotiable

---

## Stack summary

| Layer | Choice |
|---|---|
| Shell | Tauri v2 |
| UI | React + TypeScript + Tailwind |
| Core logic | Rust (single process, no Python sidecar) |
| Screen reading | Accessibility tree → local OCR → vision model fallback |
| Screen capture | On-demand only (not continuous) |
| AI backend | Pluggable router: Anthropic / OpenAI + Ollama (v1) → Gemini Live added later |
| STT | whisper.cpp (local) or cloud STT (v1); Gemini Live duplex (later) |
| TTS | Piper (local) or cloud TTS (v1); Gemini Live duplex (later) |
| Wake word | Picovoice Porcupine (local-only) |
| Memory | SQLite + vector store (sqlite-vec or LanceDB) |
| Hotkeys/clipboard/tray | Tauri plugins |

---

## Feature list (v1 scope)
1. Highlight-anywhere popup — explain + narrate (speaker button)
2. Voice-guided generation — narrates while writing code/essay/etc., result auto-copied to clipboard
3. Intent clarification before acting (e.g. "code or explanation?")
4. Web resource fetching for the task at hand
5. Multi-modal I/O — text, voice (STT/TTS), video, camera, screen share, all permission-gated
6. File/app access, with confirmation before destructive actions
7. Global hotkey / wake-word trigger
8. Persistent memory across sessions
9. Hybrid screen understanding — accessibility tree + OCR + vision fallback
10. Pluggable AI backend — cloud (Claude/GPT, later Gemini Live) or local (Ollama), per-task or as a default

---

## Build-order recommendation

1. Bare Tauri shell with tray icon + global hotkey (prove the "always-on" skeleton works)
2. AI backend router (cloud only first — Anthropic/OpenAI) wired to a simple chat popup
3. Clipboard + basic text generation flow (feature #2)
4. Highlight-anywhere popup using accessibility tree (feature #1) — hardest OS integration, do it early
5. Add local model support via Ollama to the router (feature #10)
6. Voice layer — discrete STT/TTS (Whisper/Piper/cloud) first, wake word last; Gemini Live added afterward as a specialized duplex-streaming provider once the router and audio pipeline are proven
7. Vision-model fallback for screen understanding (on-demand capture only)
8. Memory/vector store
9. Camera/screen share, file/app access, confirmation flows

---

## Status
All prior open decisions are now resolved. The plan is ready to move into system architecture / sequence diagrams (Phase 3).
