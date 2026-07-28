mod ai;

use futures_util::StreamExt;
use tauri::ipc::Channel; // Import the Channel primitive
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Manager,
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

fn toggle_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let is_visible = window.is_visible().unwrap_or(false);
        if is_visible {
            window.hide().unwrap();
        } else {
            window.show().unwrap();
            window.set_focus().unwrap();
        }
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
            write_clipboard
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
