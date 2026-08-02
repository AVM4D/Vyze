mod ai;

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
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// Our new streaming AI command.
// - prompt: The message typed by the user.
// - provider: Either "gemini" or "ollama".
// - on_token: The Tauri channel that pipes tokens (words) back to React.
#[tauri::command]
async fn ask_vyze(
    history: Vec<ai::ChatMessage>, // Accept the list of past messages from React
    provider: String,
    on_token: Channel<String>,
) -> Result<(), String> {
    // 1. Choose which AI provider to initialize
    let ai_provider: Box<dyn ai::AiProvider> = match provider.as_str() {
        "gemini" => {
            // Read the API key from the system environment variables
            let api_key = std::env::var("GEMINI_API_KEY")
                .map_err(|_| "GEMINI_API_KEY environment variable is not set. Please set it in your system variables to use Gemini.".to_string())?;
            Box::new(ai::GeminiProvider::new(api_key, None))
        }
        "ollama" => {
            // Read local Ollama model name from environment or default to "llama3"
            let model = std::env::var("OLLAMA_MODEL").ok();
            Box::new(ai::OllamaProvider::new(model))
        }
        _ => return Err(format!("Unknown provider: {}", provider)),
    };

    // 2. Start the streaming request
    let mut stream = ai_provider.stream_chat(&history); // Pass history instead of a single prompt
                                                        // 3. Listen to the stream and push tokens to the frontend channel as they arrive
    while let Some(result) = stream.next().await {
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
    // 1. Open clipboard and backup original text
    let mut clipboard = match arboard::Clipboard::new() {
        Ok(c) => c,
        Err(_) => return "".to_string(),
    };
    let backup_text = clipboard.get_text().ok();

    // 2. Clear clipboard
    let _ = clipboard.set_text("".to_string());

    // 3. Offload the blocking input simulation to a background worker thread
    let _ = tokio::task::spawn_blocking(move || {
        let mut enigo = match Enigo::new(&Settings::default()) {
            Ok(e) => e,
            Err(_) => return,
        };

        // Simulate pressing Ctrl + C (using Unicode('c'))
        let _ = enigo.key(Key::Control, Press);
        let _ = enigo.key(Key::Unicode('c'), Click);
        let _ = enigo.key(Key::Control, Release);
    })
    .await;

    // 4. Sleep to allow the OS and application to process copy command
    tokio::time::sleep(Duration::from_millis(100)).await;

    // 5. Read selection
    let selected_text = clipboard.get_text().unwrap_or_else(|_| "".to_string());

    // 6. Restore original clipboard text
    if let Some(original) = backup_text {
        let _ = clipboard.set_text(original);
    } else {
        let _ = clipboard.set_text("".to_string());
    }

    selected_text
}

// Tauri command that lets React trigger capture manually if needed
#[tauri::command]
async fn capture_selection() -> Result<String, String> {
    Ok(perform_capture().await)
}

#[tauri::command]
async fn capture_active_screen(window: tauri::WebviewWindow) -> Result<String, String> {
    // 1. Hide the Vyze window first so it doesn't appear in the screenshot
    let _ = window.hide();

    // Wait 150ms for the hide window animation to finish
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    // 2. Fetch current cursor position
    let mut point = POINT { x: 0, y: 0 };
    let (cursor_x, cursor_y) = unsafe {
        if GetCursorPos(&mut point).is_ok() {
            (point.x, point.y)
        } else {
            (0, 0)
        }
    };

    // 3. Query all active monitors
    let monitors = xcap::Monitor::all().map_err(|e| format!("Failed to query monitors: {}", e))?;

    // 4. Find monitor containing mouse cursor coordinate
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

        if cursor_x >= start_x && cursor_x <= end_x && cursor_y >= start_y && cursor_y <= end_y {
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
                // Show the window back in case of error
                let _ = window.show();
                let _ = window.set_focus();
                return Err("No active displays found to capture".to_string());
            }
            all[0].clone()
        }
    };

    // 5. Capture surface
    let image = match monitor.capture_image() {
        Ok(img) => img,
        Err(e) => {
            // Show the window back in case of error
            let _ = window.show();
            let _ = window.set_focus();
            return Err(format!("Direct surface capture failed: {}", e));
        }
    };

    // Resize the image to fit within 1024x1024 while maintaining aspect ratio.
    // This reduces payload transfer size and prevents local model context overflow / VRAM crash.
    let dynamic_image = image::DynamicImage::ImageRgba8(image);
    let resized_image = dynamic_image.resize(
        1024,
        1024,
        image::imageops::FilterType::Triangle,
    );

    // 6. Compress RGBA buffer directly to PNG bytes
    let mut png_bytes = Vec::new();
    let mut write_cursor = Cursor::new(&mut png_bytes);
    if let Err(e) = resized_image.write_to(&mut write_cursor, image::ImageFormat::Png) {
        // Show the window back in case of error
        let _ = window.show();
        let _ = window.set_focus();
        return Err(format!("PNG encoding failure: {}", e));
    }

    // 7. Base64 serialize PNG binary to ASCII text
    let base64_str = BASE64_STANDARD.encode(&png_bytes);

    // 8. Bring the Vyze window back to the screen and focus it!
    let _ = window.show();
    let _ = window.set_focus();

    Ok(base64_str)
}

fn toggle_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let is_visible = window.is_visible().unwrap_or(false);
        if is_visible {
            window.hide().unwrap();
        } else {
            let window_clone = window.clone();

            // 1. Fetch current cursor position
            let mut point = POINT { x: 0, y: 0 };
            let (cursor_x, cursor_y) = unsafe {
                if GetCursorPos(&mut point).is_ok() {
                    (point.x, point.y)
                } else {
                    (100, 100) // Safe fallback coordinate
                }
            };

            // 2. Define the popup window size dimensions (matching tauri.conf.json)
            let win_width = 360;
            let win_height = 280;

            // 3. Locate the monitor containing the cursor coordinates
            let mut monitor_x = 0;
            let mut monitor_y = 0;
            let mut monitor_width = 1920;
            let mut monitor_height = 1080;

            if let Ok(monitors) = app.available_monitors() {
                for m in monitors {
                    let pos = m.position();
                    let size = m.size();
                    let start_x = pos.x;
                    let end_x = pos.x + size.width as i32;
                    let start_y = pos.y;
                    let end_y = pos.y + size.height as i32;

                    // Check if cursor point lies within this monitor's bounds
                    if cursor_x >= start_x
                        && cursor_x <= end_x
                        && cursor_y >= start_y
                        && cursor_y <= end_y
                    {
                        monitor_x = pos.x;
                        monitor_y = pos.y;
                        monitor_width = size.width as i32;
                        monitor_height = size.height as i32;
                        break;
                    }
                }
            } else if let Ok(Some(monitor)) = window.current_monitor() {
                // Fallback to active window monitor if list fails
                let pos = monitor.position();
                let size = monitor.size();
                monitor_x = pos.x;
                monitor_y = pos.y;
                monitor_width = size.width as i32;
                monitor_height = size.height as i32;
            }

            // Offset the popup slightly down and right from the cursor
            let mut final_x = cursor_x + 12;
            let mut final_y = cursor_y + 12;

            // Flip left if overflowing the right edge of this specific monitor
            if final_x + win_width > monitor_x + monitor_width {
                final_x = cursor_x - win_width - 12;
            }
            // Flip up if overflowing the bottom edge of this specific monitor
            if final_y + win_height > monitor_y + monitor_height {
                final_y = cursor_y - win_height - 12;
            }

            // Hard clamp to this monitor's boundaries
            if final_x < monitor_x {
                final_x = monitor_x + 10;
            }
            if final_y < monitor_y {
                final_y = monitor_y + 10;
            }

            // Set the calculated position on the window
            let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
                final_x, final_y,
            )));

            // 4. Spawn selection capture background task, then show HUD
            tauri::async_runtime::spawn(async move {
                let selected_text = perform_capture().await;
                let _ = window_clone.show();
                let _ = window_clone.set_focus();
                let _ = window_clone.emit("selection-captured", selected_text);
            });
        }
    }
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let window_clone = window.clone();

        // Fetch current cursor position
        let mut point = POINT { x: 0, y: 0 };
        let (cursor_x, cursor_y) = unsafe {
            if GetCursorPos(&mut point).is_ok() {
                (point.x, point.y)
            } else {
                (100, 100) // Safe fallback coordinate
            }
        };

        // Window size dimensions (matching tauri.conf.json)
        let win_width = 360;
        let win_height = 280;

        let mut monitor_x = 0;
        let mut monitor_y = 0;
        let mut monitor_width = 1920;
        let mut monitor_height = 1080;

        if let Ok(monitors) = app.available_monitors() {
            for m in monitors {
                let pos = m.position();
                let size = m.size();
                let start_x = pos.x;
                let end_x = pos.x + size.width as i32;
                let start_y = pos.y;
                let end_y = pos.y + size.height as i32;

                if cursor_x >= start_x
                    && cursor_x <= end_x
                    && cursor_y >= start_y
                    && cursor_y <= end_y
                {
                    monitor_x = pos.x;
                    monitor_y = pos.y;
                    monitor_width = size.width as i32;
                    monitor_height = size.height as i32;
                    break;
                }
            }
        }

        // Offset the popup slightly down and right from the cursor
        let mut final_x = cursor_x + 12;
        let mut final_y = cursor_y + 12;

        if final_x + win_width > monitor_x + monitor_width {
            final_x = cursor_x - win_width - 12;
        }
        if final_y + win_height > monitor_y + monitor_height {
            final_y = cursor_y - win_height - 12;
        }

        if final_x < monitor_x {
            final_x = monitor_x + 10;
        }
        if final_y < monitor_y {
            final_y = monitor_y + 10;
        }

        // Position window at cursor
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            final_x, final_y,
        )));

        // Spawn a background capture task, show window, and emit the selection context
        tauri::async_runtime::spawn(async move {
            let selected_text = perform_capture().await;
            let _ = window_clone.show();
            let _ = window_clone.set_focus();
            let _ = window_clone.emit("selection-captured", selected_text);
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    dotenvy::dotenv().ok();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Register greet, ask_vyze, and clipboard commands
        .invoke_handler(tauri::generate_handler![
            greet,
            ask_vyze,
            read_clipboard,
            write_clipboard,
            capture_selection,
            show_main_window,
            capture_active_screen
        ])
        .setup(|app| {
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

            // 2. Global Shortcut setup
            let ctrl_space = Shortcut::new(Some(Modifiers::CONTROL), Code::Space);

            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, shortcut, event| {
                        if event.state() == ShortcutState::Pressed {
                            if shortcut.matches(Modifiers::CONTROL, Code::Space) {
                                toggle_window(app);
                            }
                        }
                    })
                    .build(),
            )?;

            app.global_shortcut().register(ctrl_space)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
