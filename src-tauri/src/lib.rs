mod ai;
mod audio;
mod automation;
mod db;
mod embeddings;
mod rag;
mod fetcher;
mod personas;
mod stt;
mod terminal;

use base64::prelude::*;
use std::io::Cursor;
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

use enigo::{
    Direction::{Click, Press, Release},
    Enigo, Key, Keyboard, Settings,
};
use futures_util::StreamExt;
use std::time::Duration;
use tauri::ipc::Channel; // Import the Channel primitive
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState}; // Import StreamExt so we can call .next() on our stream
                                                                                                 // Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
                                                                                                 // AppState stores configuration settings like auto_capture in a Mutex for safe access
pub struct AppState {
    pub auto_capture: std::sync::Mutex<bool>,
    pub db: db::DbManager,
    pub audio_recorder: std::sync::Mutex<audio::AudioRecorder>,
    pub active_timers: std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>>,
}

// command to toggle the auto_capture state in AppState
use winreg::enums::*;
use winreg::RegKey;

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = r"Software\Microsoft\Windows\CurrentVersion\Run";
    let (key, _) = hkcu.create_subkey(path).map_err(|e| format!("Registry error: {}", e))?;

    if enabled {
        if let Ok(current_exe) = std::env::current_exe() {
            let exe_str = current_exe.to_string_lossy().to_string();
            key.set_value("Vyze", &format!("\"{}\"", exe_str))
                .map_err(|e| format!("Failed to set registry value: {}", e))?;
        }
    } else {
        let _ = key.delete_value("Vyze");
    }
    Ok(())
}

#[tauri::command]
fn get_autostart() -> Result<bool, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = r"Software\Microsoft\Windows\CurrentVersion\Run";
    if let Ok(key) = hkcu.open_subkey(path) {
        let val: Result<String, _> = key.get_value("Vyze");
        Ok(val.is_ok())
    } else {
        Ok(false)
    }
}

#[tauri::command]
fn set_auto_capture(state: tauri::State<'_, AppState>, enabled: bool) {
    if let Ok(mut auto_cap) = state.auto_capture.lock() {
        *auto_cap = enabled;
    }
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

pub static CANCEL_AI_STREAM: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn cancel_ai_stream() {
    CANCEL_AI_STREAM.store(true, std::sync::atomic::Ordering::SeqCst);
}

// Our new streaming AI command.
// - prompt: The message typed by the user.
// - provider: Either "gemini" or "ollama".
// - on_token: The Tauri channel that pipes tokens (words) back to React.
#[tauri::command]
async fn ask_vyze(
    state: tauri::State<'_, AppState>,
    session_id: Option<String>,
    mut history: Vec<ai::ChatMessage>, // Accept the list of past messages from React
    provider: String,
    on_token: Channel<String>,
) -> Result<(), String> {
    CANCEL_AI_STREAM.store(false, std::sync::atomic::Ordering::SeqCst);
    // Sanitize chat history to prevent corrupted automation debug strings from polluting model context
    history.retain(|msg| {
        let content = msg.content.trim();
        !content.contains("URI opened successfully")
            && !content.contains("automation action:")
            && !content.contains("app_name:")
            && !content.starts_with("✓ opening")
            && !content.starts_with("✓ ")
    });

    // 0. Triggered Memory Lookup across past sessions
    if let Some(last_msg) = history.last() {
        let prompt_lower = last_msg.content.to_lowercase();
        let triggers = [
            "remember",
            "recall",
            "search",
            "history",
            "past",
            "chat",
            "prev",
            "yesterday",
            "look up",
        ];
        let is_memory_query = triggers.iter().any(|t| prompt_lower.contains(t));

        if is_memory_query {
            if let Some(ref current_sid) = session_id {
                let mut search_results = Vec::new();

                // 1. Attempt Vector Embedding Semantic Search
                if let Ok(query_vec) =
                    embeddings::generate_embedding(&last_msg.content, &provider).await
                {
                    if let Ok(vec_results) =
                        state
                            .db
                            .semantic_search_past_context(current_sid, &query_vec, 5, 0.45)
                    {
                        search_results = vec_results;
                    }
                }

                // 2. Fallback to recent chat history if vector embeddings empty
                if search_results.is_empty() {
                    if let Ok(fts_results) =
                        state.db.search_past_context(current_sid, &last_msg.content)
                    {
                        search_results = fts_results;
                    }
                }

                if !search_results.is_empty() {
                    let mut recall_text = String::from("\n\n[Memory recall from past sessions]:\n");
                    for res in search_results {
                        recall_text.push_str(&format!(
                            "- Session '{}' ({}): {}\n",
                            res.session_title, res.role, res.content
                        ));
                    }
                    if let Some(last_msg_mut) = history.last_mut() {
                        last_msg_mut.content.push_str(&recall_text);
                    }
                }
            }
        }
    }

    // Read user settings for context truncation limit
    let enable_limit = state
        .db
        .get_setting("enable_context_limit")
        .ok()
        .flatten()
        .map(|v| v == "true")
        .unwrap_or(false);
    let max_limit = if enable_limit {
        state
            .db
            .get_setting("max_doc_context_limit")
            .ok()
            .flatten()
            .and_then(|s| s.parse::<usize>().ok())
    } else {
        None
    };

    // 0.5. Automatic Web URL and Local File Resource Ingestion
    if let Some(last_msg_mut) = history.last_mut() {
        let content = last_msg_mut.content.clone();
        let words: Vec<&str> = content.split_whitespace().collect();

        for word in words {
            let clean_word = word.trim_matches(|c| {
                c == '(' || c == ')' || c == '[' || c == ']' || c == '\'' || c == '"'
            });

            // Check for HTTP / HTTPS Web URLs
            if clean_word.starts_with("http://") || clean_word.starts_with("https://") {
                if let Ok(web_markdown) = fetcher::fetch_url_markdown(clean_word, max_limit).await {
                    last_msg_mut.content.push_str(&format!(
                        "\n\n[Attached Web Document from '{}']:\n{}\n",
                        clean_word, web_markdown
                    ));
                }
            }
            // Check for Local File Paths
            else if clean_word.contains('/')
                || clean_word.contains('\\')
                || clean_word.ends_with(".rs")
                || clean_word.ends_with(".tsx")
                || clean_word.ends_with(".ts")
                || clean_word.ends_with(".json")
                || clean_word.ends_with(".toml")
                || clean_word.ends_with(".md")
                || clean_word.ends_with(".py")
            {
                if let Ok(file_content) = fetcher::read_file_content(clean_word, max_limit).await {
                    last_msg_mut.content.push_str(&format!(
                        "\n\n[Attached File Content from '{}']:\n{}\n",
                        clean_word, file_content
                    ));
                }
            }
        }
    }

    // 0.7. Session-level Document RAG context retrieval
    if let Some(ref current_sid) = session_id {
        if let Ok(docs) = state.db.get_session_documents(current_sid) {
            if !docs.is_empty() {
                if let Some(last_msg_mut) = history.last_mut() {
                    // Generate embedding for user prompt
                    if let Ok(query_vec) = embeddings::generate_embedding(&last_msg_mut.content, &provider).await {
                        // Retrieve top 5 matching text chunks from session documents
                        if let Ok(chunks) = state.db.semantic_search_documents(current_sid, &query_vec, 5, 0.35) {
                            if !chunks.is_empty() {
                                let mut context_text = String::from("\n\n[Retrieved Context from Session Documents/Folders]:\n");
                                for chunk in chunks {
                                    context_text.push_str(&format!(
                                        "--- Context from file '{}' (Score: {:.2}) ---\n{}\n",
                                        chunk.file_name, chunk.score, chunk.chunk_text
                                    ));
                                }
                                last_msg_mut.content.push_str(&context_text);
                            }
                        }
                    }
                }
            }
        }
    }

    // Read active persona and custom prompt settings from SQLite
    let persona_key = state.db.get_setting("persona_key").ok().flatten().unwrap_or_else(|| "balanced".to_string());
    let custom_prompt = state.db.get_setting("custom_system_prompt").ok().flatten().unwrap_or_default();
    let active_system_prompt = personas::get_system_prompt(&persona_key, &custom_prompt);

    // 1. Choose which AI provider to initialize with user-configured API keys & model names
    let ai_provider: Box<dyn ai::AiProvider> = match provider.as_str() {
        "gemini" => {
            let api_key = state.db.get_setting("gemini_api_key").ok().flatten().filter(|s| !s.trim().is_empty())
                .or_else(|| std::env::var("GEMINI_API_KEY").ok())
                .ok_or_else(|| "Gemini API key is not set. Please enter your API key in Settings (⚙) -> Setup.".to_string())?;
            let model = state.db.get_setting("gemini_model").ok().flatten().filter(|s| !s.trim().is_empty())
                .or_else(|| std::env::var("GEMINI_MODEL").ok());
            Box::new(ai::GeminiProvider::new(api_key, model, Some(active_system_prompt)))
        }
        "openai" => {
            let api_key = state.db.get_setting("openai_api_key").ok().flatten().filter(|s| !s.trim().is_empty())
                .or_else(|| std::env::var("OPENAI_API_KEY").ok())
                .ok_or_else(|| "OpenAI API key is not set. Please enter your API key in Settings (⚙) -> Setup.".to_string())?;
            let model = state.db.get_setting("openai_model").ok().flatten().filter(|s| !s.trim().is_empty())
                .or_else(|| std::env::var("OPENAI_MODEL").ok());
            Box::new(ai::OpenAIProvider::new(api_key, model, Some(active_system_prompt)))
        }
        "groq" => {
            let api_key = state.db.get_setting("groq_api_key").ok().flatten().filter(|s| !s.trim().is_empty())
                .or_else(|| std::env::var("GROQ_API_KEY").ok())
                .ok_or_else(|| "Groq API key is not set. Please enter your API key in Settings (⚙) -> Setup.".to_string())?;
            let model = state.db.get_setting("groq_model").ok().flatten().filter(|s| !s.trim().is_empty())
                .or_else(|| std::env::var("GROQ_MODEL").ok());
            Box::new(ai::GroqProvider::new(api_key, model, Some(active_system_prompt)))
        }
        "anthropic" => {
            let api_key = state.db.get_setting("anthropic_api_key").ok().flatten().filter(|s| !s.trim().is_empty())
                .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok())
                .ok_or_else(|| "Anthropic API key is not set. Please enter your API key in Settings (⚙) -> Setup.".to_string())?;
            let model = state.db.get_setting("anthropic_model").ok().flatten().filter(|s| !s.trim().is_empty())
                .or_else(|| std::env::var("ANTHROPIC_MODEL").ok());
            Box::new(ai::AnthropicProvider::new(api_key, model, Some(active_system_prompt)))
        }
        "ollama" => {
            let model = state.db.get_setting("ollama_model").ok().flatten().filter(|s| !s.trim().is_empty())
                .or_else(|| std::env::var("OLLAMA_MODEL").ok());
            let base_url = state.db.get_setting("ollama_base_url").ok().flatten().filter(|s| !s.trim().is_empty())
                .or_else(|| std::env::var("OLLAMA_BASE_URL").ok());
            Box::new(ai::OllamaProvider::new(model, base_url, Some(active_system_prompt)))
        }
        _ => return Err(format!("Unsupported AI provider: {}", provider)),
    };

    // 2. Start the streaming request
    let mut stream = ai_provider.stream_chat(&history); // Pass history instead of a single prompt
                                                        // 3. Listen to the stream and push tokens to the frontend channel as they arrive
    while let Some(result) = stream.next().await {
        if CANCEL_AI_STREAM.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }
        match result {
            Ok(token) => {
                // Send the token through the channel.
                // If this returns an error, it means the frontend closed the connection (e.g. user closed the app), so we stop.
                if let Err(e) = on_token.send(token) {
                    println!("Failed to send token over channel: {}", e);
                    break;
                }
            }
            Err(err_msg) => {
                // If the stream yielded an error, return it from our command
                return Err(err_msg);
            }
        }
    }

    Ok(())
}

// ==========================================
// DATABASE IPC COMMANDS
// ==========================================

#[tauri::command]
fn db_get_sessions(state: tauri::State<'_, AppState>) -> Result<Vec<db::DbSession>, String> {
    state.db.get_sessions().map_err(|e| e.to_string())
}

#[tauri::command]
fn db_create_session(state: tauri::State<'_, AppState>, title: String) -> Result<String, String> {
    state.db.create_session(&title).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_update_session_title(
    state: tauri::State<'_, AppState>,
    id: String,
    title: String,
) -> Result<(), String> {
    state
        .db
        .update_session_title(&id, &title)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_delete_session(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.delete_session(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_get_messages(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<Vec<db::DbMessage>, String> {
    state
        .db
        .get_messages(&session_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn db_add_message(
    state: tauri::State<'_, AppState>,
    session_id: String,
    role: String,
    content: String,
    image_base64: Option<String>,
    provider: Option<String>,
) -> Result<i64, String> {
    let msg_id = state
        .db
        .add_message(&session_id, &role, &content, image_base64.as_deref())
        .map_err(|e| e.to_string())?;

    let content_clone = content.clone();
    let provider_name = provider.unwrap_or_else(|| "gemini".to_string());
    let db_path = state.db.get_db_path();
    let session_id_clone = session_id.clone();

    if !content_clone.trim().is_empty() {
        tauri::async_runtime::spawn(async move {
            if let Ok(vector) = embeddings::generate_embedding(&content_clone, &provider_name).await
            {
                let db = db::DbManager::from_db_path(db_path);
                let _ = db.add_message_embedding(msg_id, &session_id_clone, &vector);
            }
        });
    }

    Ok(msg_id)
}

#[tauri::command]
fn db_set_setting(
    state: tauri::State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    state
        .db
        .set_setting(&key, &value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_get_setting(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<Option<String>, String> {
    state.db.get_setting(&key).map_err(|e| e.to_string())
}

// ==========================================
// VOICE & STT IPC COMMANDS
// ==========================================

#[tauri::command]
fn start_voice_recording(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let Ok(mut recorder) = state.audio_recorder.lock() {
        recorder.start_recording()?;
    }
    Ok(())
}

#[tauri::command]
async fn stop_voice_recording(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let samples = if let Ok(mut recorder) = state.audio_recorder.lock() {
        recorder.stop_recording()?
    } else {
        Vec::new()
    };

    if samples.is_empty() {
        return Ok(String::new());
    }

    stt::transcribe_audio(&samples).await
}

// ==========================================
// TERMINAL EXECUTION IPC COMMAND
// ==========================================

#[tauri::command]
async fn run_terminal_command(
    command: String,
    cwd: Option<String>,
) -> Result<terminal::CommandOutput, String> {
    terminal::execute_command(&command, cwd.as_deref()).await
}

// ==========================================
// TIMER SYSTEM IPC COMMANDS
// ==========================================

#[tauri::command]
fn cancel_timer(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    if let Ok(mut timers) = state.active_timers.lock() {
        if let Some(tx) = timers.remove(&id) {
            let _ = tx.send(());
            return Ok(());
        }
    }
    Err("Timer not found or already completed".to_string())
}

#[tauri::command]
fn get_active_timers(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    if let Ok(timers) = state.active_timers.lock() {
        Ok(timers.keys().cloned().collect())
    } else {
        Err("Failed to lock active timers".to_string())
    }
}

// A command that reads plain text from the system clipboard
#[tauri::command]
fn read_clipboard() -> Result<String, String> {
    // Open a connection to the system clipboard
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("Failed to open clipboard: {}", e))?;

    // Read the text
    clipboard
        .get_text()
        .map_err(|e| format!("Failed to read text from clipboard: {}", e))
}

// A command that writes text into the system clipboard
#[tauri::command]
fn write_clipboard(text: String) -> Result<(), String> {
    // Open a connection to the system clipboard
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("Failed to open clipboard: {}", e))?;

    // Write the text
    clipboard
        .set_text(text)
        .map_err(|e| format!("Failed to write text to clipboard: {}", e))
}

// Shared helper function to copy the active selection and restore clipboard state
async fn perform_capture() -> String {
    tokio::task::spawn_blocking(move || {
        // 1. Open clipboard and backup original text
        let mut clipboard = match arboard::Clipboard::new() {
            Ok(c) => c,
            Err(_) => return "".to_string(),
        };
        let backup_text = clipboard.get_text().ok();

        // 2. Clear clipboard
        let _ = clipboard.set_text("".to_string());

        // 3. Simulate pressing Ctrl + C
        if let Ok(mut enigo) = Enigo::new(&Settings::default()) {
            let _ = enigo.key(Key::Control, Press);
            let _ = enigo.key(Key::Unicode('c'), Click);
            let _ = enigo.key(Key::Control, Release);
        }

        // 4. Sleep to allow the OS and application to process copy command
        std::thread::sleep(Duration::from_millis(150));

        // 5. Read selection
        let selected_text = clipboard.get_text().unwrap_or_else(|_| "".to_string());

        // 6. Restore original clipboard text
        if let Some(original) = backup_text {
            let _ = clipboard.set_text(original);
        } else {
            let _ = clipboard.set_text("".to_string());
        }

        selected_text
    })
    .await
    .unwrap_or_else(|_| "".to_string())
}

// Tauri command that lets React trigger capture manually if needed
#[tauri::command]
async fn capture_selection() -> Result<String, String> {
    Ok(perform_capture().await)
}

// Helper function to capture the active monitor under the cursor, resize it, and return a base64 PNG string
async fn perform_screen_capture() -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        // 1. Fetch current cursor position
        let mut point = POINT { x: 0, y: 0 };
        let (cursor_x, cursor_y) = unsafe {
            if GetCursorPos(&mut point).is_ok() {
                (point.x, point.y)
            } else {
                (0, 0)
            }
        };

        // 2. Query all active monitors
        let monitors =
            xcap::Monitor::all().map_err(|e| format!("Failed to query monitors: {}", e))?;

        // 3. Find monitor containing mouse cursor coordinate
        let mut active_monitor = None;
        for m in monitors {
            let start_x = m
                .x()
                .map_err(|e| format!("Failed to read monitor X: {}", e))?;
            let width = m
                .width()
                .map_err(|e| format!("Failed to read monitor width: {}", e))?;
            let start_y = m
                .y()
                .map_err(|e| format!("Failed to read monitor Y: {}", e))?;
            let height = m
                .height()
                .map_err(|e| format!("Failed to read monitor height: {}", e))?;

            let end_x = start_x + width as i32;
            let end_y = start_y + height as i32;

            if cursor_x >= start_x && cursor_x <= end_x && cursor_y >= start_y && cursor_y <= end_y
            {
                active_monitor = Some(m);
                break;
            }
        }

        // Default to first monitor if cursor isn't in any screen boundaries
        let monitor = match active_monitor {
            Some(m) => m,
            None => {
                let all = xcap::Monitor::all().map_err(|e| e.to_string())?;
                if all.is_empty() {
                    return Err("No active displays found to capture".to_string());
                }
                all[0].clone()
            }
        };

        // 4. Capture surface
        let image = monitor
            .capture_image()
            .map_err(|e| format!("Direct surface capture failed: {}", e))?;

        // Resize the image to fit within 1024x1024 while maintaining aspect ratio.
        let dynamic_image = image::DynamicImage::ImageRgba8(image);
        let resized_image = dynamic_image.resize(1024, 1024, image::imageops::FilterType::Triangle);

        // 5. Compress RGBA buffer directly to PNG bytes
        let mut png_bytes = Vec::new();
        let mut write_cursor = Cursor::new(&mut png_bytes);
        resized_image
            .write_to(&mut write_cursor, image::ImageFormat::Png)
            .map_err(|e| format!("PNG encoding failure: {}", e))?;

        // 6. Base64 serialize PNG binary to ASCII text
        let base64_str = BASE64_STANDARD.encode(&png_bytes);

        Ok(base64_str)
    })
    .await
    .map_err(|e| format!("Thread join failure: {}", e))?
}

#[tauri::command]
async fn capture_active_screen(window: tauri::WebviewWindow) -> Result<String, String> {
    // 1. Hide the Vyze window first so it doesn't appear in the screenshot
    let _ = window.hide();

    // Wait 150ms for the hide window animation to finish
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    // 2. Perform screen capture using our helper
    let result = perform_screen_capture().await;

    // 3. Bring the Vyze window back to the screen and focus it!
    let _ = window.show();
    let _ = window.set_focus();

    result
}

fn position_window_at_cursor(window: &tauri::WebviewWindow) {
    let mut point = POINT { x: 0, y: 0 };
    let (cursor_x, cursor_y) = unsafe {
        if GetCursorPos(&mut point).is_ok() {
            (point.x, point.y)
        } else {
            (100, 100)
        }
    };

    // 1. Intersect cursor point with all available physical monitors
    let mut monitor_x = 0;
    let mut monitor_y = 0;
    let mut monitor_width = 1920;
    let mut monitor_height = 1080;
    let mut found_monitor = false;

    if let Ok(monitors) = window.available_monitors() {
        for m in monitors {
            let pos = m.position();
            let size = m.size();
            let m_left = pos.x;
            let m_top = pos.y;
            let m_right = pos.x + size.width as i32;
            let m_bottom = pos.y + size.height as i32;

            if cursor_x >= m_left && cursor_x < m_right && cursor_y >= m_top && cursor_y < m_bottom {
                monitor_x = m_left;
                monitor_y = m_top;
                monitor_width = size.width as i32;
                monitor_height = size.height as i32;
                found_monitor = true;
                break;
            }
        }
    }

    if !found_monitor {
        if let Ok(Some(m)) = window.current_monitor() {
            let pos = m.position();
            let size = m.size();
            monitor_x = pos.x;
            monitor_y = pos.y;
            monitor_width = size.width as i32;
            monitor_height = size.height as i32;
        }
    }

    let (win_width, win_height) = if let Ok(outer_size) = window.outer_size() {
        if outer_size.width > 50 && outer_size.height > 50 {
            (outer_size.width as i32, outer_size.height as i32)
        } else {
            (400, 372)
        }
    } else {
        (400, 372)
    };

    let scale_factor = window.scale_factor().unwrap_or(1.0);

    // Determine the transparent top headroom padding in logical pixels based on preset window height
    let top_padding_logical = if win_height > 560 {
        155.0 // Large preset headroom
    } else if win_height > 420 {
        120.0 // Medium preset headroom
    } else {
        90.0 // Small preset headroom
    };

    let top_padding_physical = (top_padding_logical * scale_factor) as i32;

    // Position window so the TOP-LEFT of the visible .hud-card aligns directly at cursor_y
    let mut final_x = cursor_x;
    let mut final_y = cursor_y - top_padding_physical;

    // Clamp right and bottom edges relative to target monitor
    if final_x + win_width > monitor_x + monitor_width {
        final_x = cursor_x - win_width;
    }
    if final_y + win_height > monitor_y + monitor_height {
        final_y = cursor_y - win_height;
    }

    // Ensure window never overflows left or top monitor bounds
    if final_x < monitor_x {
        final_x = monitor_x + 5;
    }
    if final_y < monitor_y - top_padding_physical {
        final_y = monitor_y - top_padding_physical;
    }

    let _ = window.set_skip_taskbar(true);
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        final_x, final_y,
    )));
    let _ = window.show();
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        final_x, final_y,
    )));
    let _ = window.set_skip_taskbar(true);
    let _ = window.set_focus();
}

fn toggle_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let is_visible = window.is_visible().unwrap_or(false);
        if is_visible {
            let _ = window.hide();
        } else {
            let window_clone = window.clone();
            let app_handle = app.clone();

            tauri::async_runtime::spawn(async move {
                let state = app_handle.state::<AppState>();
                let auto_capture_enabled = if let Ok(auto_cap) = state.auto_capture.lock() {
                    *auto_cap
                } else {
                    false
                };

                let selected_text = perform_capture().await;

                let mut screen_capture_base64 = None;
                if auto_capture_enabled {
                    if let Ok(base64) = perform_screen_capture().await {
                        screen_capture_base64 = Some(base64);
                    }
                }

                position_window_at_cursor(&window_clone);
                let _ = window_clone.emit("selection-captured", selected_text);
                if let Some(base64) = screen_capture_base64 {
                    let _ = window_clone.emit("auto-screen-captured", base64);
                }
            });
        }
    }
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let window_clone = window.clone();
        let app_handle = app.clone();

        tauri::async_runtime::spawn(async move {
            let state = app_handle.state::<AppState>();
            let auto_cap = {
                let guard = state.auto_capture.lock().unwrap();
                *guard
            };

            let screen_capture_base64 = if auto_cap {
                perform_screen_capture().await.ok()
            } else {
                None
            };

            position_window_at_cursor(&window_clone);
            if let Some(base64) = screen_capture_base64 {
                let _ = window_clone.emit("auto-screen-captured", base64);
            }
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[tauri::command]
async fn execute_os_automation(app: tauri::AppHandle, action_type: String, target: String) -> Result<String, String> {
    match action_type.as_str() {
        "open_uri" => automation::open_uri(&target).await.map(|_| "URI opened successfully".to_string()),
        "set_brightness" => {
            let val: u32 = target.parse().unwrap_or(80);
            automation::set_brightness(val).await.map(|_| format!("Brightness adjusted to {}%", val))
        }
        "set_volume" => {
            let val: u32 = target.parse().unwrap_or(50);
            automation::set_volume(val).await.map(|_| format!("Volume set to {}%", val))
        }
        "media_control" => automation::media_control(&target).await.map(|_| format!("Media command '{}' dispatched", target)),
        "power_control" => automation::power_control(&target).await.map(|_| format!("Power action '{}' executed", target)),
        "window_management" => automation::window_management(&target).await.map(|_| "Window action executed".to_string()),
        "search_dev" | "search_web" => {
            let parts: Vec<&str> = target.splitn(2, '|').collect();
            let platform = parts.first().copied().unwrap_or("google");
            let query = parts.get(1).copied().unwrap_or("");
            automation::search_web_or_dev(platform, query).await.map(|_| format!("Searching {} for '{}'", platform, query))
        }
        "system_status" => automation::get_system_status().await,
        "process_control" => {
            let parts: Vec<&str> = target.splitn(2, '|').collect();
            let action = parts.first().copied().unwrap_or("list");
            let name = parts.get(1).copied().unwrap_or("");
            automation::process_control(action, name).await
        }
        "open_app" => automation::open_app_or_folder(&target).await.map(|_| format!("Launched {}", target)),
        "create_file" => automation::create_file(&target).await,
        "search_files" => automation::search_files(&target).await,
        "set_timer" => {
            // Target format: "duration_secs|label"
            let parts: Vec<&str> = target.splitn(2, '|').collect();
            let secs: u64 = parts.first().copied().unwrap_or("0").parse().unwrap_or(0);
            let label = parts.get(1).copied().unwrap_or("Timer").to_string();

            let timer_id = uuid::Uuid::new_v4().to_string();
            let (tx, rx) = tokio::sync::oneshot::channel::<()>();

            let state = app.state::<AppState>();
            if let Ok(mut timers) = state.active_timers.lock() {
                timers.insert(timer_id.clone(), tx);
            }

            let app_clone = app.clone();
            let id_clone = timer_id.clone();
            let label_clone = label.clone();

            tauri::async_runtime::spawn(async move {
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(secs)) => {
                        // Remove from active list
                        if let Ok(mut timers) = app_clone.state::<AppState>().active_timers.lock() {
                            timers.remove(&id_clone);
                        }
                        // Notify frontend
                        let _ = app_clone.emit("timer-finished", serde_json::json!({
                            "id": id_clone,
                            "label": label_clone,
                            "duration_secs": secs
                        }));
                    }
                    _ = rx => {
                        // Cancelled, do nothing
                    }
                }
            });

            // Return JSON details so frontend can track it
            Ok(serde_json::json!({
                "id": timer_id,
                "label": label,
                "duration_secs": secs
            }).to_string())
        }
        "cancel_timer" => {
            let state = app.state::<AppState>();
            if let Ok(mut timers) = state.active_timers.lock() {
                if let Some(tx) = timers.remove(&target) {
                    let _ = tx.send(());
                    return Ok(format!("Timer '{}' cancelled", target));
                }
            }
            Err("Timer not found or already completed".to_string())
        }
        _ => Err(format!("Unknown automation action: {}", action_type)),
    }
}

#[tauri::command]
async fn select_and_attach_files(
    app: tauri::AppHandle,
    session_id: String,
    provider: String,
) -> Result<String, String> {
    // Open a PowerShell multi-select OpenFileDialog
    let script = r#"
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = New-Object System.Windows.Forms.OpenFileDialog
        $dialog.Multiselect = $true
        $dialog.Filter = "Text Files (*.txt;*.md;*.json;*.toml;*.rs;*.tsx;*.ts;*.py;*.go;*.java;*.cpp;*.h;*.js;*.css;*.html;*.sh;*.bat;*.ps1)|*.txt;*.md;*.json;*.toml;*.rs;*.tsx;*.ts;*.py;*.go;*.java;*.cpp;*.h;*.js;*.css;*.html;*.sh;*.bat;*.ps1|All Files (*.*)|*.*"
        $dialog.Title = "Select Files to Attach to Chat Session"
        $res = $dialog.ShowDialog()
        if ($res -eq "OK") {
            $dialog.FileNames | Out-String
        } else {
            ""
        }
    "#;
    
    let output = std::process::Command::new("powershell")
        .args(&["-NoProfile", "-Command", script])
        .output()
        .map_err(|e| format!("Failed to launch file picker: {}", e))?;
        
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Ok("No files selected".to_string());
    }
    
    let paths: Vec<String> = stdout
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();
        
    let total = paths.len();
    
    // Spawn ingestion in background
    let app_clone = app.clone();
    let session_id_clone = session_id.clone();
    let provider_clone = provider.clone();
    
    tokio::spawn(async move {
        let state = app_clone.state::<AppState>();
        let _ = app_clone.emit("rag-progress", serde_json::json!({
            "status": "start",
            "total": total
        }));
        
        let mut count = 0;
        for (i, p) in paths.iter().enumerate() {
            let path = std::path::Path::new(p);
            let name = path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();
                
            let _ = app_clone.emit("rag-progress", serde_json::json!({
                "status": "processing",
                "file_name": name,
                "current": i + 1,
                "total": total
            }));
            
            // Add file to DB metadata
            if let Ok(doc_id) = state.db.add_document(&session_id_clone, p, &name) {
                // Chunk and embedding ingest
                if let Err(e) = rag::ingest_file(&app_clone, &session_id_clone, path, &provider_clone, doc_id).await {
                    let _ = state.db.delete_document(doc_id);
                    println!("Failed to ingest file {}: {}", name, e);
                } else {
                    count += 1;
                }
            }
        }
        
        let _ = app_clone.emit("rag-progress", serde_json::json!({
            "status": "complete",
            "total_ingested": count
        }));
    });
    
    Ok(format!("Ingesting {} files in background...", total))
}

#[tauri::command]
async fn select_and_attach_folder(
    app: tauri::AppHandle,
    session_id: String,
    provider: String,
) -> Result<String, String> {
    // Open a PowerShell FolderBrowserDialog
    let script = r#"
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = "Select Folder to Attach to Chat Session"
        $res = $dialog.ShowDialog()
        if ($res -eq "OK") {
            $dialog.SelectedPath
        } else {
            ""
        }
    "#;
    
    let output = std::process::Command::new("powershell")
        .args(&["-NoProfile", "-Command", script])
        .output()
        .map_err(|e| format!("Failed to launch folder picker: {}", e))?;
        
    let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path_str.is_empty() {
        return Ok("No folder selected".to_string());
    }
    
    let path = std::path::PathBuf::from(&path_str);
    
    // Ingest folder in background
    let app_clone = app.clone();
    let session_id_clone = session_id.clone();
    let provider_clone = provider.clone();
    
    tokio::spawn(async move {
        let _ = app_clone.emit("rag-progress", serde_json::json!({
            "status": "start",
            "folder_name": path.file_name().and_then(|n| n.to_str()).unwrap_or("folder")
        }));
        
        let _ = rag::ingest_folder(&app_clone, &session_id_clone, &path, &provider_clone).await;
    });
    
    Ok(format!("Ingesting folder in background..."))
}

#[tauri::command]
fn get_session_attachments(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<Vec<db::DbDocument>, String> {
    state.db.get_session_documents(&session_id)
        .map_err(|e| format!("Failed to retrieve documents: {}", e))
}

#[tauri::command]
fn delete_session_attachment(
    state: tauri::State<'_, AppState>,
    document_id: i64,
) -> Result<(), String> {
    state.db.delete_document(document_id)
        .map_err(|e| format!("Failed to delete document: {}", e))
}

#[tauri::command]
fn resize_vyze_window(app: tauri::AppHandle, preset: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let (width, height) = match preset.to_lowercase().as_str() {
            "medium" => (540.0, 503.0),
            "large" => (700.0, 622.0),
            _ => (400.0, 372.0), // "small" default
        };
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)));
        let _ = window.set_skip_taskbar(true);
    }
    Ok(())
}

pub fn run() {
    dotenvy::dotenv().ok();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            ask_vyze,
            read_clipboard,
            write_clipboard,
            capture_selection,
            show_main_window,
            capture_active_screen,
            set_auto_capture,
            db_get_sessions,
            db_create_session,
            db_update_session_title,
            db_delete_session,
            db_get_messages,
            db_add_message,
            db_set_setting,
            db_get_setting,
            start_voice_recording,
            stop_voice_recording,
            run_terminal_command,
            execute_os_automation,
            cancel_timer,
            get_active_timers,
            select_and_attach_files,
            select_and_attach_folder,
            get_session_attachments,
            delete_session_attachment,
            resize_vyze_window,
            cancel_ai_stream,
            set_autostart,
            get_autostart
        ])
        .setup(|app| {
            // Initialize Database Manager
            let app_data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let db_manager = db::DbManager::new(app_data_dir);
            if let Err(e) = db_manager.init_tables() {
                eprintln!("Failed to initialize database tables: {}", e);
            }

            app.manage(AppState {
                auto_capture: std::sync::Mutex::new(false),
                db: db_manager,
                audio_recorder: std::sync::Mutex::new(audio::AudioRecorder::new()),
                active_timers: std::sync::Mutex::new(std::collections::HashMap::new()),
            });

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_skip_taskbar(true);
            }

            // 1. System Tray setup
            let toggle = MenuItemBuilder::with_id("toggle", "Toggle Vyze").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

            let menu = MenuBuilder::new(app).items(&[&toggle, &quit]).build()?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "toggle" => {
                        toggle_window(app);
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // 2. Global Shortcut setup (Ctrl+Space to toggle window)
            let ctrl_space = Shortcut::new(Some(Modifiers::CONTROL), Code::Space);

            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, shortcut, event| {
                        if shortcut.matches(Modifiers::CONTROL, Code::Space) {
                            if event.state() == ShortcutState::Pressed {
                                toggle_window(app);
                            }
                        }
                    })
                    .build(),
            )?;

            app.global_shortcut().register(ctrl_space)?;

            // 3. Hardware Physical Key Monitor for Push-To-Talk (Exclusively Ctrl+Shift+Space)
            #[cfg(windows)]
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
                    let mut was_holding = false;

                    loop {
                        tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;

                        // 0x11 = VK_CONTROL (Ctrl), 0x10 = VK_SHIFT (Shift), 0x20 = VK_SPACE (Space)
                        let is_ctrl = unsafe { (GetAsyncKeyState(0x11) as u16 & 0x8000) != 0 };
                        let is_shift = unsafe { (GetAsyncKeyState(0x10) as u16 & 0x8000) != 0 };
                        let is_space = unsafe { (GetAsyncKeyState(0x20) as u16 & 0x8000) != 0 };
                        
                        // Exclusively Ctrl+Shift+Space (modifier-only, zero-character leak)
                        let is_holding = is_ctrl && is_shift && is_space;

                        if is_holding && !was_holding {
                            was_holding = true;
                            show_main_window(app_handle.clone());
                            let _ = app_handle.emit("ptt-start", ());
                        } else if !is_holding && was_holding {
                            was_holding = false;
                            let _ = app_handle.emit("ptt-stop", ());
                        }
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
