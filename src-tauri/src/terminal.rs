use serde::{Deserialize, Serialize};
use std::process::Stdio;
use tokio::process::Command;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Executes a terminal command safely using PowerShell on Windows.
pub async fn execute_command(command_str: &str, cwd: Option<&str>) -> Result<CommandOutput, String> {
    let clean_cmd = command_str.trim();
    if clean_cmd.is_empty() {
        return Err("Command string is empty".to_string());
    }

    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-Command", clean_cmd]);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    if let Some(dir) = cwd {
        let clean_dir = dir.trim().trim_matches('"').trim_matches('\'');
        if !clean_dir.is_empty() {
            cmd.current_dir(clean_dir);
        }
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn PowerShell process: {}", e))?;

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("Failed to wait for process output: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code().unwrap_or(-1);

    Ok(CommandOutput {
        stdout,
        stderr,
        exit_code,
    })
}
