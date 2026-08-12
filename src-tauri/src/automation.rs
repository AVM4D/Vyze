use tokio::process::Command as TokioCommand;
use enigo::{Enigo, Key, Settings, Keyboard, Direction::Click};
use std::time::Duration;

/// Opens any system URI protocol (spotify:, mailto:, whatsapp:, https:) or file path.
pub async fn open_uri(uri: &str) -> Result<(), String> {
    let clean_uri = uri.trim();
    if clean_uri.is_empty() {
        return Err("URI target is empty".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        // Escape single quotes in single-quoted PowerShell string literal
        let escaped_uri = clean_uri.replace("'", "''");
        let output = TokioCommand::new("powershell")
            .args(&[
                "-NoProfile",
                "-Command",
                &format!("Start-Process -FilePath '{}'", escaped_uri),
            ])
            .output()
            .await
            .map_err(|e| format!("Failed to launch URI: {}", e))?;

        if output.status.success() {
            // Trigger automatic press-Enter keys to autoplay or auto-send!
            if clean_uri.starts_with("spotify:search:") || clean_uri.starts_with("whatsapp://send") {
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(2500)).await;
                    let _ = tokio::task::spawn_blocking(move || {
                        if let Ok(mut enigo) = Enigo::new(&Settings::default()) {
                            let _ = enigo.key(Key::Return, Click);
                        }
                    }).await;
                });
            }
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
            if stderr.contains("Not supported") || stderr.contains("ManagementException") {
                Err("Screen brightness control is only supported on integrated laptop displays, not external desktop monitors.".to_string())
            } else {
                Err(format!("WMI Brightness set failed: {}", stderr))
            }
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
            "spotify" => "Start-Process 'spotify:'".to_string(),
            "youtube" => "Start-Process 'https://www.youtube.com'".to_string(),
            "whatsapp" => "Start-Process 'whatsapp:'".to_string(),
            "discord" => "Start-Process 'discord:'".to_string(),
            "settings" => "Start-Process 'ms-settings:'".to_string(),
            "downloads" | "downloads folder" => "explorer.exe shell:Downloads".to_string(),
            "documents" | "documents folder" => "explorer.exe shell:Personal".to_string(),
            "desktop" | "desktop folder" => "explorer.exe shell:Desktop".to_string(),
            "pictures" | "pictures folder" => "explorer.exe shell:Pictures".to_string(),
            "file explorer" | "explorer" | "my computer" | "this pc" => "explorer.exe".to_string(),
            "c drive" | "c:" => "explorer.exe C:\\".to_string(),
            "d drive" | "d:" => "explorer.exe D:\\".to_string(),
            "control panel" => "control.exe".to_string(),
            "vyze" | "project" | "d:\\vyze" | "d:/vyze" => "explorer.exe 'D:\\Vyze'".to_string(),
            _ => {
                // Call Find-And-Start-App powershell script
                format!(
                    r#"
                    function Find-And-Start-App {{
                        param([string]$AppName)
                        
                        # If the app name is already a valid absolute/relative path on disk, launch it directly!
                        if (Test-Path $AppName) {{
                            Start-Process $AppName
                            return $true
                        }}

                        $exeMap = @{{
                            "chrome" = "chrome.exe";
                            "google chrome" = "chrome.exe";
                            "vscode" = "Code.exe";
                            "code" = "Code.exe";
                            "visual studio code" = "Code.exe";
                            "pycharm" = "pycharm64.exe";
                            "pycharm professional" = "pycharm64.exe";
                            "pycharm community" = "pycharm64.exe";
                            "brave" = "brave.exe";
                            "brave browser" = "brave.exe";
                            "edge" = "msedge.exe";
                            "msedge" = "msedge.exe";
                            "microsoft edge" = "msedge.exe";
                            "visual studio" = "devenv.exe";
                            "devenv" = "devenv.exe";
                            "notepad" = "notepad.exe";
                            "calculator" = "calc.exe";
                            "calc" = "calc.exe";
                            "taskmgr" = "taskmgr.exe";
                            "task manager" = "taskmgr.exe";
                            "terminal" = "wt.exe";
                            "powershell" = "powershell.exe";
                            "cmd" = "cmd.exe"
                        }}
                        
                        $exeName = $AppName.ToLower().Trim()
                        if ($exeMap.ContainsKey($exeName)) {{
                            $exeName = $exeMap[$exeName]
                        }} else {{
                            if (-not $exeName.EndsWith(".exe")) {{
                                $exeName = $exeName + ".exe"
                            }}
                        }}
                        
                        # Special case for Calculator
                        if ($exeName -eq "calc.exe") {{
                            Start-Process "calculator:"
                            return $true
                        }}
                        
                        # Check system PATH
                        $pathResult = Get-Command $exeName -ErrorAction SilentlyContinue
                        if ($pathResult) {{
                            Start-Process $pathResult.Source
                            return $true
                        }}
                        
                        # Check Registry App Paths (HKLM and HKCU)
                        $regPaths = @(
                            "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exeName",
                            "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exeName"
                        )
                        foreach ($regPath in $regPaths) {{
                            if (Test-Path $regPath) {{
                                $val = (Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue)."(default)"
                                if ($val) {{
                                    $val = $val.Replace('"', '').Trim()
                                    if (Test-Path $val) {{
                                        Start-Process $val
                                        return $true
                                    }}
                                }}
                            }}
                        }}
                        
                        # Registry Uninstall Check (looks up install paths on other drives)
                        $uninstallPaths = @(
                            "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
                            "HKLM:\SOFTWARE\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
                            "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*"
                        )
                        $installedApps = Get-ItemProperty -Path $uninstallPaths -ErrorAction SilentlyContinue | 
                            Where-Object {{ `$_.DisplayName -and (`$_.DisplayName -match $AppName -or `$_.InstallLocation -match $AppName) }}
                        foreach ($app in $installedApps) {{
                            if ($app.DisplayIcon -and $app.DisplayIcon -match "\.exe") {{
                                $path = $app.DisplayIcon.Split(',')[0].Replace('"', '').Trim()
                                if (Test-Path $path) {{
                                    Start-Process $path
                                    return $true
                                }}
                            }}
                            if ($app.InstallLocation -and (Test-Path $app.InstallLocation)) {{
                                $found = Get-ChildItem -Path $app.InstallLocation -Filter $exeName -Recurse -Depth 3 -File -ErrorAction SilentlyContinue | Select-Object -First 1
                                if ($found) {{
                                    Start-Process $found.FullName
                                    return $true
                                }}
                            }}
                        }}

                        # Search first-level directories on all filesystem drives (robust fallback search)
                        $drives = Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root
                        foreach ($drive in $drives) {{
                            $firstLevelDirs = Get-ChildItem -Path $drive -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
                            foreach ($dir in $firstLevelDirs) {{
                                # Skip system folders to keep search very fast
                                if ($dir -match "Recycle|Volume|Windows|System32") {{ continue }}
                                $found = Get-ChildItem -Path $dir -Filter $exeName -Recurse -Depth 4 -File -ErrorAction SilentlyContinue | Select-Object -First 1
                                if ($found) {{
                                    Start-Process $found.FullName
                                    return $true
                                }}
                            }}
                        }}
                        
                        # Direct fallback try
                        Start-Process $exeName -ErrorAction SilentlyContinue
                        return $?
                    }}
                    
                    Find-And-Start-App '{}'
                    "#,
                    clean.replace("'", "''")
                )
            }
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

/// System Power and Session Management (Lock, Sleep, Restart, Shutdown)
pub async fn power_control(action: &str) -> Result<(), String> {
    let clean_action = action.trim().to_lowercase();
    #[cfg(target_os = "windows")]
    {
        if clean_action == "lock" || clean_action == "lock_workstation" {
            return lock_workstation().await;
        }

        let cmd = match clean_action.as_str() {
            "sleep" => "rundll32.exe powrprof.dll,SetSuspendState 0,1,0",
            "restart" => "shutdown /r /t 0",
            "shutdown" => "shutdown /s /t 0",
            _ => return Err(format!("Unknown power action: {}", clean_action)),
        };

        let output = TokioCommand::new("powershell")
            .args(&["-NoProfile", "-Command", cmd])
            .output()
            .await
            .map_err(|e| format!("Failed power control action '{}': {}", clean_action, e))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Err(format!("Power action failed: {}", stderr))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Power control supported on Windows".to_string())
    }
}

/// Media and Audio Playback Controls (Play/Pause, Next, Prev, Mute, Vol Up, Vol Down)
pub async fn media_control(command: &str) -> Result<(), String> {
    let clean_cmd = command.trim().to_lowercase();
    #[cfg(target_os = "windows")]
    {
        let script = match clean_cmd.as_str() {
            "play" | "pause" | "play_pause" | "toggle" => {
                "$wsh = New-Object -ComObject WScript.Shell; $wsh.SendKeys([char]179)"
            }
            "next" | "next_track" => {
                "$wsh = New-Object -ComObject WScript.Shell; $wsh.SendKeys([char]176)"
            }
            "prev" | "previous" | "prev_track" => {
                "$wsh = New-Object -ComObject WScript.Shell; $wsh.SendKeys([char]177)"
            }
            "mute" | "unmute" => {
                "$wsh = New-Object -ComObject WScript.Shell; $wsh.SendKeys([char]173)"
            }
            "volume_up" | "vol_up" => {
                "$wsh = New-Object -ComObject WScript.Shell; 1..5 | % { $wsh.SendKeys([char]175) }"
            }
            "volume_down" | "vol_down" => {
                "$wsh = New-Object -ComObject WScript.Shell; 1..5 | % { $wsh.SendKeys([char]174) }"
            }
            _ => return Err(format!("Unknown media command: {}", clean_cmd)),
        };

        let output = TokioCommand::new("powershell")
            .args(&["-NoProfile", "-Command", script])
            .output()
            .await
            .map_err(|e| format!("Failed media control: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Err(format!("Media control failed: {}", stderr))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Media control supported on Windows".to_string())
    }
}

/// Window Management (Show/Toggle Desktop, Minimize All)
pub async fn window_management(action: &str) -> Result<(), String> {
    let clean = action.trim().to_lowercase();
    #[cfg(target_os = "windows")]
    {
        let script = match clean.as_str() {
            "toggle_desktop" | "minimize_all" | "show_desktop" => {
                "(New-Object -ComObject Shell.Application).ToggleDesktop()"
            }
            _ => return Err(format!("Unknown window management action: {}", clean)),
        };

        let output = TokioCommand::new("powershell")
            .args(&["-NoProfile", "-Command", script])
            .output()
            .await
            .map_err(|e| format!("Failed window management: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Err(format!("Window management failed: {}", stderr))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Window management supported on Windows".to_string())
    }
}

/// Web & Developer Search Utilities
pub async fn search_web_or_dev(platform: &str, query: &str) -> Result<(), String> {
    let clean_platform = platform.trim().to_lowercase();
    let encoded_query = urlencoding::encode(query.trim());

    let url = match clean_platform.as_str() {
        "google" => format!("https://www.google.com/search?q={}", encoded_query),
        "bing" => format!("https://www.bing.com/search?q={}", encoded_query),
        "duckduckgo" | "ddg" => format!("https://duckduckgo.com/?q={}", encoded_query),
        "github" => format!("https://github.com/search?q={}", encoded_query),
        "stackoverflow" | "so" => format!("https://stackoverflow.com/search?q={}", encoded_query),
        "npm" => format!("https://www.npmjs.com/search?q={}", encoded_query),
        "pypi" => format!("https://pypi.org/search/?q={}", encoded_query),
        "maps" => format!("https://www.google.com/maps/search/{}", encoded_query),
        "weather" => format!("https://www.google.com/search?q=weather+{}", encoded_query),
        _ => format!("https://www.google.com/search?q={}", encoded_query),
    };

    open_uri(&url).await
}

/// System Telemetry and Hardware Status Reporter
pub async fn get_system_status() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let script = r#"
            $batt = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue
            $cpu = (Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Measure-Object -Property LoadPercentage -Average).Average
            $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
            
            # Retrieve all active local hard disks
            $disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction SilentlyContinue

            $ramTotalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
            $ramFreeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
            $ramUsedGB = [math]::Round($ramTotalGB - $ramFreeGB, 2)
            $ramPercent = [math]::Round(($ramUsedGB / $ramTotalGB) * 100, 1)

            $battStr = if ($batt) { "$($batt.EstimatedChargeRemaining)%" } else { "Desktop (AC Powered)" }
            
            # Robust CPU Load Check
            if ($cpu -eq $null) {
                $cpu = (Get-WmiObject Win32_Processor -ErrorAction SilentlyContinue | Measure-Object -Property LoadPercentage -Average).Average
                if ($cpu -eq $null) {
                    $cpu = [math]::Round((Get-Counter '\Processor(_Total)\% Processor Time' -ErrorAction SilentlyContinue).CounterSamples[0].CookedValue, 1)
                }
            }
            $cpuStr = if ($cpu -ne $null) { "${cpu}%" } else { "N/A" }

            $diskStr = ""
            foreach ($disk in $disks) {
                $diskFreeGB = [math]::Round($disk.FreeSpace / 1GB, 2)
                $diskTotalGB = [math]::Round($disk.Size / 1GB, 2)
                $diskPercent = [math]::Round((($diskTotalGB - $diskFreeGB) / $diskTotalGB) * 100, 1)
                $diskStr += "`n- Storage ($($disk.DeviceID)): ${diskFreeGB} GB Free / ${diskTotalGB} GB (${diskPercent}% used)"
            }

            # Retrieve GPU information
            $gpu = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
            $gpuName = if ($gpu) { ($gpu | Select-Object -First 1).Name } else { "N/A" }
            $gpuPercent = 0
            try {
                $gpuSamples = (Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples
                if ($gpuSamples) {
                    $gpuSum = ($gpuSamples | Measure-Object -Property CookedValue -Sum).Sum
                    $gpuPercent = [math]::Round($gpuSum, 1)
                }
            } catch {}
            $gpuStr = if ($gpuName -ne "N/A") { "`n- GPU: $gpuName (Usage: $gpuPercent%)" } else { "" }

            "📊 Vyze System Hardware Report:`n- Battery: $battStr`n- CPU Utilization: $cpuStr$gpuStr`n- RAM Usage: ${ramUsedGB} GB / ${ramTotalGB} GB (${ramPercent}%)$diskStr"
        "#;

        let output = TokioCommand::new("powershell")
            .args(&["-NoProfile", "-Command", script])
            .output()
            .await
            .map_err(|e| format!("Failed to fetch system status: {}", e))?;

        if output.status.success() {
            let result_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok(result_str)
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Err(format!("System status query failed: {}", stderr))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("System status telemetry supported on Windows".to_string())
    }
}

/// Process Management (List or Terminate Application)
pub async fn process_control(action: &str, target: &str) -> Result<String, String> {
    let clean_action = action.trim().to_lowercase();
    let clean_target = target.trim();

    #[cfg(target_os = "windows")]
    {
        match clean_action.as_str() {
            "kill" | "close" => {
                // Strip .exe suffix if present to prevent Stop-Process failures
                let process_name = if clean_target.to_lowercase().ends_with(".exe") {
                    &clean_target[..clean_target.len() - 4]
                } else {
                    clean_target
                };

                let script = format!(
                    "Stop-Process -Name '{}' -Force -ErrorAction Stop",
                    process_name
                );
                let output = TokioCommand::new("powershell")
                    .args(&["-NoProfile", "-Command", &script])
                    .output()
                    .await
                    .map_err(|e| format!("Failed process termination: {}", e))?;

                if output.status.success() {
                    Ok(format!("Successfully terminated process: {}", process_name))
                } else {
                    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                    Err(format!("Failed to kill process '{}': {}", process_name, stderr))
                }
            }
            "list" => {
                let script = "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 | ForEach-Object { '- **' + $_.ProcessName + '**: ' + [math]::Round($_.WorkingSet64/1MB, 1) + ' MB' }";
                let output = TokioCommand::new("powershell")
                    .args(&["-NoProfile", "-Command", script])
                    .output()
                    .await
                    .map_err(|e| format!("Failed process list query: {}", e))?;

                if output.status.success() {
                    let res = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    Ok(format!("🔥 Top Active Processes (Memory Usage):\n{}", res))
                } else {
                    Err("Failed to fetch running process list".to_string())
                }
            }
            _ => Err(format!("Unknown process action: {}", clean_action)),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Process control supported on Windows".to_string())
    }
}

/// Create quick note/file in user Desktop folder
pub async fn create_file(target: &str) -> Result<String, String> {
    let parts: Vec<&str> = target.splitn(2, '|').collect();
    let filename = parts.first().copied().unwrap_or("note.txt").trim();
    let content = parts.get(1).copied().unwrap_or("").trim();

    let desktop_dir = std::env::var("USERPROFILE")
        .map(|p| std::path::PathBuf::from(p).join("Desktop"))
        .or_else(|_| std::env::var("HOME").map(|p| std::path::PathBuf::from(p).join("Desktop")))
        .map_err(|_| "Could not resolve user Profile or Home directory".to_string())?;

    let file_path = desktop_dir.join(filename);

    std::fs::write(&file_path, content)
        .map_err(|e| format!("Failed to create file at {:?}: {}", file_path, e))?;

    Ok(format!("✓ Successfully created file on Desktop: {}", filename))
}

/// Search user local files by name/glob in common folders (Desktop, Documents, Downloads)
pub async fn search_files(query: &str) -> Result<String, String> {
    let clean_query = query.trim();
    if clean_query.is_empty() {
        return Err("Search query is empty".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let script = format!(
            r#"
            $query = "{}"
            $paths = @(
                [System.IO.Path]::Combine($env:USERPROFILE, "Desktop"),
                [System.IO.Path]::Combine($env:USERPROFILE, "Documents"),
                [System.IO.Path]::Combine($env:USERPROFILE, "Downloads")
            )
            $results = @()
            foreach ($path in $paths) {{
                if (Test-Path $path) {{
                    $results += Get-ChildItem -Path $path -Filter $query -Recurse -Depth 3 -File -ErrorAction SilentlyContinue | Select-Object -First 15
                }}
            }}
            if ($results.Count -eq 0) {{
                "No matching files found."
            }} else {{
                $results | ForEach-Object {{ "- **" + $_.Name + "**: " + $_.FullName }} | Out-String
            }}
            "#,
            clean_query.replace('"', "`\"")
        );

        let output = TokioCommand::new("powershell")
            .args(&["-NoProfile", "-Command", &script])
            .output()
            .await
            .map_err(|e| format!("File search execution failed: {}", e))?;

        if output.status.success() {
            let res = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok(format!("🔍 File Search Results for '{}':\n{}", clean_query, res))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Err(format!("File search query failed: {}", stderr))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("File search supported on Windows only".to_string())
    }
}


