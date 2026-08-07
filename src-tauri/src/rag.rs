use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Emitter};
use crate::embeddings;
use crate::AppState;

/// Splits a text document into character chunks with overlap
fn chunk_text(text: &str, chunk_size: usize, overlap: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return chunks;
    }
    
    let mut start = 0;
    while start < chars.len() {
        let end = std::cmp::min(start + chunk_size, chars.len());
        let chunk: String = chars[start..end].iter().collect();
        chunks.push(chunk);
        
        if end == chars.len() {
            break;
        }
        
        if start + chunk_size > overlap {
            start += chunk_size - overlap;
        } else {
            start += 1;
        }
    }
    chunks
}

/// Ingests a single file, chunks it, generates embeddings, and saves to database
pub async fn ingest_file(
    app: &AppHandle,
    session_id: &str,
    file_path: &Path,
    provider: &str,
    document_id: i64,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    
    // 1. Read file contents as UTF-8 string
    let content = std::fs::read_to_string(file_path)
        .map_err(|e| format!("Failed to read file contents: {}", e))?;
        
    // 2. Slice text into chunks
    let chunks = chunk_text(&content, 1000, 200);
    
    // 3. For each chunk, call active AI provider embeddings API and save to DB
    for (i, chunk) in chunks.iter().enumerate() {
        if chunk.trim().is_empty() {
            continue;
        }
        
        // Generate high-dimensional vector
        let vector = embeddings::generate_embedding(chunk, provider)
            .await
            .map_err(|e| format!("Failed to generate embedding for chunk {}: {}", i, e))?;
            
        // Store in SQLite
        state.db.add_document_chunk(
            document_id,
            session_id,
            i as i32,
            chunk,
            &vector,
        ).map_err(|e| format!("Failed to store chunk embedding: {}", e))?;
    }
    
    Ok(())
}

/// Recursively collects text files in folder path
pub fn collect_files_recursive(dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if dir.is_dir() {
        let entries = std::fs::read_dir(dir)
            .map_err(|e| format!("Failed to read folder entries: {}", e))?;
            
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            
            // Skip hidden folders, version controls, packages, and compile targets
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                let lower_name = name.to_lowercase();
                if name.starts_with('.') 
                    || lower_name == "node_modules" 
                    || lower_name == "target" 
                    || lower_name == "dist" 
                    || lower_name == "build" 
                    || lower_name == "bin" 
                    || lower_name == "obj" 
                    || lower_name == "package-lock.json"
                {
                    continue;
                }
            }
            
            if path.is_dir() {
                collect_files_recursive(&path, files)?;
            } else {
                // Ingest plain text based extensions only
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    let text_extensions = [
                        "txt", "md", "json", "toml", "yaml", "yml", "xml", "csv",
                        "rs", "tsx", "ts", "js", "py", "go", "java", "cpp", "h", "c",
                        "css", "html", "sh", "bat", "ps1", "sql", "ini", "conf", "env"
                    ];
                    if text_extensions.contains(&ext.to_lowercase().as_str()) {
                        files.push(path);
                    }
                }
            }
        }
    }
    Ok(())
}

/// Ingests all text files inside a folder recursively in a background task
pub async fn ingest_folder(
    app: &AppHandle,
    session_id: &str,
    folder_path: &Path,
    provider: &str,
) -> Result<usize, String> {
    let mut files = Vec::new();
    collect_files_recursive(folder_path, &mut files)?;
    
    let total_files = files.len();
    let mut ingested_count = 0;
    
    let state = app.state::<AppState>();
    
    for (idx, file) in files.iter().enumerate() {
        let file_name = file.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
            
        let file_path_str = file.to_string_lossy().to_string();
        
        // Add folder document entry in database
        let doc_id = state.db.add_document(session_id, &file_path_str, &file_name)
            .map_err(|e| format!("Failed to add document record: {}", e))?;
            
        // Emit progress updates back to React
        let _ = app.emit("rag-progress", serde_json::json!({
            "status": "processing",
            "file_name": file_name,
            "current": idx + 1,
            "total": total_files
        }));
        
        // Index the content chunks
        if let Err(e) = ingest_file(app, session_id, file, provider, doc_id).await {
            // Roll back database entry if indexing failed
            let _ = state.db.delete_document(doc_id);
            println!("Skipping indexing failed for file {:?}: {}", file, e);
            continue;
        }
        
        ingested_count += 1;
    }
    
    // Ingestion finished success event
    let _ = app.emit("rag-progress", serde_json::json!({
        "status": "complete",
        "total_ingested": ingested_count
    }));
    
    Ok(ingested_count)
}
