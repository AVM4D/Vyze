use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DbSession {
    pub id: String,
    pub title: String,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DbMessage {
    pub id: i64,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub image_base64: Option<String>,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SearchResult {
    pub session_id: String,
    pub session_title: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

pub struct DbManager {
    db_path: PathBuf,
}

impl DbManager {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&app_data_dir);
        let db_path = app_data_dir.join("vyze.db");
        Self { db_path }
    }

    pub fn from_db_path(db_path: PathBuf) -> Self {
        Self { db_path }
    }

    pub fn get_db_path(&self) -> PathBuf {
        self.db_path.clone()
    }

    fn get_connection(&self) -> Result<Connection> {
        Connection::open(&self.db_path)
    }

    pub fn init_tables(&self) -> Result<()> {
        let conn = self.get_connection()?;

        // Enable foreign key enforcement
        conn.execute("PRAGMA foreign_keys = ON", [])?;

        // 1. Sessions table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // 2. Messages table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                image_base64 TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )",
            [],
        )?;

        // 3. FTS5 Search table
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                session_id,
                role,
                content
            )",
            [],
        )?;

        // 4. Vector Embeddings Table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS message_embeddings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id INTEGER NOT NULL,
                session_id TEXT NOT NULL,
                embedding_json TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )",
            [],
        )?;

        // 5. Settings table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )",
            [],
        )?;

        Ok(())
    }

    // Sessions API
    pub fn create_session(&self, title: &str) -> Result<String> {
        let conn = self.get_connection()?;
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO sessions (id, title) VALUES (?1, ?2)",
            params![id, title],
        )?;
        Ok(id)
    }

    pub fn update_session_title(&self, session_id: &str, title: &str) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute(
            "UPDATE sessions SET title = ?1 WHERE id = ?2",
            params![title, session_id],
        )?;
        Ok(())
    }

    pub fn get_sessions(&self) -> Result<Vec<DbSession>> {
        let conn = self.get_connection()?;
        let mut stmt =
            conn.prepare("SELECT id, title, created_at FROM sessions ORDER BY created_at DESC")?;
        let session_iter = stmt.query_map([], |row| {
            Ok(DbSession {
                id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
            })
        })?;

        let mut list = Vec::new();
        for s in session_iter {
            list.push(s?);
        }
        Ok(list)
    }

    pub fn delete_session(&self, session_id: &str) -> Result<()> {
        let conn = self.get_connection()?;
        let _ = conn.execute(
            "DELETE FROM message_embeddings WHERE session_id = ?1",
            params![session_id],
        );
        let _ = conn.execute(
            "DELETE FROM messages_fts WHERE session_id = ?1",
            params![session_id],
        );
        let _ = conn.execute(
            "DELETE FROM messages WHERE session_id = ?1",
            params![session_id],
        );
        conn.execute("DELETE FROM sessions WHERE id = ?1", params![session_id])?;
        Ok(())
    }

    // Messages API
    pub fn add_message(
        &self,
        session_id: &str,
        role: &str,
        content: &str,
        image_base64: Option<&str>,
    ) -> Result<i64> {
        let conn = self.get_connection()?;

        // Insert into normal table
        conn.execute(
            "INSERT INTO messages (session_id, role, content, image_base64) VALUES (?1, ?2, ?3, ?4)",
            params![session_id, role, content, image_base64],
        )?;
        let msg_id = conn.last_insert_rowid();

        // Insert into FTS table (only index non-empty text)
        if !content.trim().is_empty() {
            let _ = conn.execute(
                "INSERT INTO messages_fts (session_id, role, content) VALUES (?1, ?2, ?3)",
                params![session_id, role, content],
            );
        }

        Ok(msg_id)
    }

    pub fn get_messages(&self, session_id: &str) -> Result<Vec<DbMessage>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, role, content, image_base64, created_at 
             FROM messages WHERE session_id = ?1 ORDER BY id ASC",
        )?;
        let msg_iter = stmt.query_map(params![session_id], |row| {
            Ok(DbMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                image_base64: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;

        let mut list = Vec::new();
        for m in msg_iter {
            list.push(m?);
        }
        Ok(list)
    }

    // Vector Embeddings API
    pub fn add_message_embedding(
        &self,
        message_id: i64,
        session_id: &str,
        vector: &[f32],
    ) -> Result<()> {
        let conn = self.get_connection()?;
        let json_str = serde_json::to_string(vector).unwrap_or_default();
        conn.execute(
            "INSERT INTO message_embeddings (message_id, session_id, embedding_json) VALUES (?1, ?2, ?3)",
            params![message_id, session_id, json_str],
        )?;
        Ok(())
    }

    /// Computes the Cosine Similarity between two equal-length vectors.
    pub fn cosine_similarity(v1: &[f32], v2: &[f32]) -> f32 {
        if v1.len() != v2.len() || v1.is_empty() {
            return 0.0;
        }
        let mut dot = 0.0f32;
        let mut norm_a = 0.0f32;
        let mut norm_b = 0.0f32;

        for i in 0..v1.len() {
            dot += v1[i] * v2[i];
            norm_a += v1[i] * v1[i];
            norm_b += v2[i] * v2[i];
        }

        if norm_a == 0.0 || norm_b == 0.0 {
            return 0.0;
        }

        dot / (norm_a.sqrt() * norm_b.sqrt())
    }

    /// Searches past sessions using Cosine Similarity against high-dimensional vector embeddings.
    pub fn semantic_search_past_context(
        &self,
        current_session_id: &str,
        query_vector: &[f32],
        top_k: usize,
        threshold: f32,
    ) -> Result<Vec<SearchResult>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT e.message_id, e.session_id, s.title, m.role, m.content, e.embedding_json, m.created_at
             FROM message_embeddings e
             JOIN messages m ON e.message_id = m.id
             JOIN sessions s ON e.session_id = s.id
             WHERE e.session_id != ?1 AND m.content != ''",
        )?;

        let rows = stmt.query_map(params![current_session_id], |row| {
            let session_id: String = row.get(1)?;
            let title: String = row.get(2)?;
            let role: String = row.get(3)?;
            let content: String = row.get(4)?;
            let json_str: String = row.get(5)?;
            let created_at: String = row.get(6)?;
            let vector: Vec<f32> = serde_json::from_str(&json_str).unwrap_or_default();

            Ok((session_id, title, role, content, vector, created_at))
        })?;

        let mut candidates = Vec::new();
        for r in rows {
            if let Ok((sid, title, role, content, vec, created_at)) = r {
                let score = Self::cosine_similarity(query_vector, &vec);
                if score >= threshold {
                    candidates.push((
                        score,
                        SearchResult {
                            session_id: sid,
                            session_title: title,
                            role,
                            content,
                            created_at,
                        },
                    ));
                }
            }
        }

        // Sort candidates by highest cosine similarity score
        candidates.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        candidates.truncate(top_k);

        Ok(candidates.into_iter().map(|(_, res)| res).collect())
    }

    // Fallback search
    pub fn search_past_context(
        &self,
        current_session_id: &str,
        _query: &str,
    ) -> Result<Vec<SearchResult>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT m.session_id, s.title, m.role, m.content, m.created_at
             FROM messages m
             JOIN sessions s ON m.session_id = s.id
             WHERE m.session_id != ?1 AND m.content != ''
             ORDER BY m.id DESC
             LIMIT 10",
        )?;

        let iter = stmt.query_map(params![current_session_id], |row| {
            Ok(SearchResult {
                session_id: row.get(0)?,
                session_title: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;

        let mut results = Vec::new();
        for r in iter {
            if let Ok(res) = r {
                results.push(res);
            }
        }
        Ok(results)
    }

    // Settings API
    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            let val: String = row.get(0)?;
            Ok(Some(val))
        } else {
            Ok(None)
        }
    }
}
