use tokio::process::Command as TokioCommand;

/// Opens any system URI protocol (spotify:, mailto:, whatsapp:, https:) or file path.
pub async fn open_uri(uri: &str) -> Result<(), String> {
    let clean_uri = uri.trim();
    if clean_uri.is_empty() {
        return Err("URI target is empty".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let output = TokioCommand::new("powershell")
            .args(&["-NoProfile", "-Command", &format!("Start-Process '{}'", clean_uri)])
            .output()
            .await
            .map_err(|e| format!("Failed to launch URI: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Err(format!("URI launch failed: {}", stderr))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("OS Automation currently supported on Windows".to_string())
    }
}

/// Sets screen brightness percentage (0 to 100) via Windows WMI.
pub async fn set_brightness(level: u32) -> Result<(), String> {
    let target = level.min(100);

    #[cfg(target_os = "windows")]
    {
        let script = format!(
            "(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1, {})",
            target
        );

        let output = TokioCommand::new("powershell")
            .args(&["-NoProfile", "-Command", &script])
            .output()
            .await
            .map_err(|e| format!("Failed to set brightness: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Err(format!("WMI Brightness set failed: {}", stderr))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Brightness control currently supported on Windows".to_string())
    }
}

/// Sets master volume level (0 to 100).
pub async fn set_volume(level: u32) -> Result<(), String> {
    let target = level.min(100);

    #[cfg(target_os = "windows")]
    {
        // Calculate volume steps (50 steps scale)
        let script = format!(
            "$wsh = New-Object -ComObject WScript.Shell; 1..50 | % {{ $wsh.SendKeys([char]174) }}; 1..{} | % {{ $wsh.SendKeys([char]175) }}",
            target / 2
        );

        let output = TokioCommand::new("powershell")
            .args(&["-NoProfile", "-Command", &script])
            .output()
            .await
            .map_err(|e| format!("Failed to set volume: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Err(format!("Volume set failed: {}", stderr))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Volume control currently supported on Windows".to_string())
    }
}

/// Locks the Windows Workstation immediately.
pub async fn lock_workstation() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let output = TokioCommand::new("powershell")
            .args(&["-NoProfile", "-Command", "rundll32.exe user32.dll,LockWorkStation"])
            .output()
            .await
            .map_err(|e| format!("Failed to lock workstation: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            Err("Failed to lock workstation".to_string())
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Lock Workstation supported on Windows".to_string())
    }
}

/// Opens desktop applications or Windows File Explorer paths.
pub async fn open_app_or_folder(target: &str) -> Result<(), String> {
    let clean = target.trim();
    if clean.is_empty() {
        return Err("App/folder target is empty".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let script = match clean.to_lowercase().as_str() {
            "vscode" | "code" => "code .".to_string(),
            "downloads" => "explorer.exe shell:Downloads".to_string(),
            "documents" => "explorer.exe shell:Personal".to_string(),
            "desktop" => "explorer.exe shell:Desktop".to_string(),
            "taskmanager" | "task manager" => "start taskmgr".to_string(),
            "notepad" => "start notepad".to_string(),
            "calculator" | "calc" => "start calc".to_string(),
            "cmd" | "terminal" => "start wt.exe".to_string(),
            _ => format!("Start-Process '{}'", clean),
        };

        let output = TokioCommand::new("powershell")
            .args(&["-NoProfile", "-Command", &script])
            .output()
            .await
            .map_err(|e| format!("Failed to open app/folder: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Err(format!("App/folder launch failed: {}", stderr))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("App launch currently supported on Windows".to_string())
    }
}
