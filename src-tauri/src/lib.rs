use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet])
        .setup(|app| {
           
            let toggle = MenuItemBuilder::with_id("toggle", "Toggle Vyze").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

            let menu = MenuBuilder::new(app)
                .items(&[&toggle, &quit])
                .build()?;

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