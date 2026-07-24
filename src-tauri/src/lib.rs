use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Manager
};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet])
        .setup(|app| {
            // 1. Create individual menu items
            let toggle = MenuItemBuilder::with_id("toggle", "Toggle Vyze").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            // 2. Combine these items into a dropdown menu
            let menu = MenuBuilder::new(app)
                .items(&[&toggle, &quit])
                .build()?;
            // 3. Register the tray icon and bind the menu to it
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "toggle" => {
                        // Find the main web window we defined in tauri.conf.json
                        if let Some(window) = app.get_webview_window("main") {
                            let is_visible = window.is_visible().unwrap_or(false);
                            if is_visible {
                                // If it's already open, hide it
                                window.hide().unwrap();
                            } else {
                                // If it's closed, show it and put focus on it
                                window.show().unwrap();
                                window.set_focus().unwrap();
                            }
                        }
                    }
                    "quit" => {
                        // Completely shut down the application
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}