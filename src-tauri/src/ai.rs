use futures_util::Stream;
use futures_util::StreamExt;
use std::pin::Pin;
use tokio::sync::mpsc;

// Type alias for pinned, thread-safe asynchronous streams
pub type BoxStream<T> = Pin<Box<dyn Stream<Item = T> + Send>>;

// a message structure that we can read from React (JSON)
#[derive(serde::Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    pub image_base64: Option<String>,
}

// standard blueprint for any ai model provider
pub trait AiProvider: Send + Sync {
    // instead of a single prompt we now take a slice of previous chat messages
    fn stream_chat(&self, history: &[ChatMessage]) -> BoxStream<Result<String, String>>;
}

// ==========================================
// 1. GOOGLE GEMINI PROVIDER (Cloud API)
// ==========================================
pub struct GeminiProvider {
    api_key: String,
    model: String,
    system_prompt: Option<String>,
}

impl GeminiProvider {
    pub fn new(api_key: String, model: Option<String>, system_prompt: Option<String>) -> Self {
        Self {
            api_key,
            model: model.unwrap_or_else(|| "gemini-1.5-flash".to_string()),
            system_prompt,
        }
    }
}

impl AiProvider for GeminiProvider {
    fn stream_chat(&self, history: &[ChatMessage]) -> BoxStream<Result<String, String>> {
        let api_key = self.api_key.clone();
        let model = self.model.clone();
        let system_prompt = self.system_prompt.clone();
        let history = history.to_vec(); // Clone history to move into the async thread
        let (tx, rx) = mpsc::channel(100);

        tokio::spawn(async move {
            let client = reqwest::Client::new();
            let url = format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse&key={}",
                model, api_key
            );

            let mut contents: Vec<serde_json::Value> = Vec::new();

            // Dual-layer enforcement: Prepend system instruction directly to contents array
            if let Some(ref sys) = system_prompt {
                if !sys.trim().is_empty() {
                    contents.push(serde_json::json!({
                        "role": "user",
                        "parts": [{ "text": format!("[SYSTEM INSTRUCTION]: {}\nFollow these operational rules strictly for all subsequent messages.", sys) }]
                    }));
                    contents.push(serde_json::json!({
                        "role": "model",
                        "parts": [{ "text": "Understood. I will strictly follow these system instructions." }]
                    }));
                }
            }

            for msg in history.iter() {
                let role = if msg.role == "assistant" {
                    "model"
                } else {
                    "user"
                };

                let mut parts = vec![serde_json::json!({
                    "text": msg.content
                })];

                if let Some(ref img) = msg.image_base64 {
                    if !img.is_empty() {
                        parts.push(serde_json::json!({
                            "inlineData": {
                                "mimeType": "image/png",
                                "data": img
                            }
                        }));
                    }
                }

                contents.push(serde_json::json!({
                    "role": role,
                    "parts": parts
                }));
            }

            let mut body_map = serde_json::json!({
                "contents": contents
            });

            if let Some(ref sys) = system_prompt {
                if !sys.trim().is_empty() {
                    body_map["system_instruction"] = serde_json::json!({
                        "parts": [{ "text": sys }]
                    });
                }
            }
            let body = body_map;

            let res = match client.post(&url).json(&body).send().await {
                Ok(response) => response,
                Err(e) => {
                    let _ = tx.send(Err(format!("Network error: {}", e))).await;
                    return;
                }
            };

            if !res.status().is_success() {
                let status = res.status();
                let err_text = res
                    .text()
                    .await
                    .unwrap_or_else(|_| "Unknown error".to_string());
                let _ = tx
                    .send(Err(format!("API error ({}): {}", status, err_text)))
                    .await;
                return;
            }

            let mut stream = res.bytes_stream();
            let mut buffer = String::new();

            while let Some(chunk_result) = stream.next().await {
                match chunk_result {
                    Ok(bytes) => {
                        if let Ok(text) = std::str::from_utf8(&bytes) {
                            buffer.push_str(text);

                            while let Some(newline_idx) = buffer.find('\n') {
                                let line = buffer[..newline_idx].trim().to_string();
                                buffer.drain(..=newline_idx);

                                if line.starts_with("data:") {
                                    let json_str = line["data:".len()..].trim();
                                    if let Ok(val) =
                                        serde_json::from_str::<serde_json::Value>(json_str)
                                    {
                                        if let Some(text_val) = val["candidates"][0]["content"]
                                            ["parts"][0]["text"]
                                            .as_str()
                                        {
                                            if tx.send(Ok(text_val.to_string())).await.is_err() {
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(format!("Stream error: {}", e))).await;
                        break;
                    }
                }
            }
        });

        let response_stream = futures_util::stream::unfold(rx, |mut rx| async move {
            match rx.recv().await {
                Some(item) => Some((item, rx)),
                None => None,
            }
        });

        Box::pin(response_stream)
    }
}

// ==========================================
// 2. OLLAMA PROVIDER (Local Offline API)
// ==========================================
pub struct OllamaProvider {
    model: String,
    base_url: String,
    system_prompt: Option<String>,
}

impl OllamaProvider {
    pub fn new(model: Option<String>, base_url: Option<String>, system_prompt: Option<String>) -> Self {
        Self {
            model: model.unwrap_or_else(|| "llama3".to_string()),
            base_url: base_url.unwrap_or_else(|| "http://127.0.0.1:11434".to_string()),
            system_prompt,
        }
    }
}

impl AiProvider for OllamaProvider {
    fn stream_chat(&self, history: &[ChatMessage]) -> BoxStream<Result<String, String>> {
        let model = self.model.clone();
        let base_url = self.base_url.clone();
        let system_prompt = self.system_prompt.clone();
        let history = history.to_vec(); // Clone history to move into the async thread
        let (tx, rx) = mpsc::channel(100);

        tokio::spawn(async move {
            let client = reqwest::Client::new();
            let url = format!("{}/api/chat", base_url.trim_end_matches('/'));

            let mut messages: Vec<serde_json::Value> = Vec::new();

            // Prepend system prompt message at index 0 for Ollama /api/chat
            if let Some(ref sys) = system_prompt {
                if !sys.trim().is_empty() {
                    messages.push(serde_json::json!({
                        "role": "system",
                        "content": sys
                    }));
                }
            }

            for msg in history.iter() {
                let content_str = msg.content.clone();

                if let Some(ref img) = msg.image_base64 {
                    if !img.is_empty() {
                        messages.push(serde_json::json!({
                            "role": msg.role,
                            "content": content_str,
                            "images": [img]
                        }));
                    } else {
                        messages.push(serde_json::json!({
                            "role": msg.role,
                            "content": content_str
                        }));
                    }
                } else {
                    messages.push(serde_json::json!({
                        "role": msg.role,
                        "content": content_str
                    }));
                }
            }

            // Construct native Ollama JSON payload with options (16384 context size)
            let body = serde_json::json!({
                "model": model,
                "messages": messages,
                "stream": true,
                "options": {
                    "num_ctx": 16384
                }
            });

            // Send request to local Ollama port
            let res = match client.post(&url).json(&body).send().await {
                Ok(response) => response,
                Err(e) => {
                    let _ = tx
                        .send(Err(format!("Local Ollama network error: {}", e)))
                        .await;
                    return;
                }
            };

            // Handle errors
            if !res.status().is_success() {
                let status = res.status();
                let err_text = res
                    .text()
                    .await
                    .unwrap_or_else(|_| "Unknown error".to_string());
                let _ = tx
                    .send(Err(format!(
                        "Local Ollama API error ({}): {}",
                        status, err_text
                    )))
                    .await;
                return;
            }

            let mut stream = res.bytes_stream();
            let mut buffer = String::new();

            while let Some(chunk_result) = stream.next().await {
                match chunk_result {
                    Ok(bytes) => {
                        if let Ok(text) = std::str::from_utf8(&bytes) {
                            buffer.push_str(text);

                            while let Some(newline_idx) = buffer.find('\n') {
                                let line = buffer[..newline_idx].trim().to_string();
                                buffer.drain(..=newline_idx);

                                if !line.is_empty() {
                                    if let Ok(val) =
                                        serde_json::from_str::<serde_json::Value>(&line)
                                    {
                                        let done = val["done"].as_bool().unwrap_or(false);

                                        if let Some(text_val) = val["message"]["content"].as_str() {
                                            if !text_val.is_empty() {
                                                if tx.send(Ok(text_val.to_string())).await.is_err()
                                                {
                                                    break;
                                                }
                                            }
                                        }

                                        if done {
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(format!("Stream error: {}", e))).await;
                        break;
                    }
                }
            }
        });

        let response_stream = futures_util::stream::unfold(rx, |mut rx| async move {
            match rx.recv().await {
                Some(item) => Some((item, rx)),
                None => None,
            }
        });

        Box::pin(response_stream)
    }
}

// ==========================================
// 3. OPENAI PROVIDER (ChatGPT API)
// ==========================================
pub struct OpenAIProvider {
    api_key: String,
    model: String,
    system_prompt: Option<String>,
}

impl OpenAIProvider {
    pub fn new(api_key: String, model: Option<String>, system_prompt: Option<String>) -> Self {
        Self {
            api_key,
            model: model.unwrap_or_else(|| "gpt-4o".to_string()),
            system_prompt,
        }
    }
}

impl AiProvider for OpenAIProvider {
    fn stream_chat(&self, history: &[ChatMessage]) -> BoxStream<Result<String, String>> {
        let api_key = self.api_key.clone();
        let model = self.model.clone();
        let system_prompt = self.system_prompt.clone();
        let history = history.to_vec();
        let (tx, rx) = mpsc::channel(100);

        tokio::spawn(async move {
            let client = reqwest::Client::new();
            let url = "https://api.openai.com/v1/chat/completions";

            let mut messages: Vec<serde_json::Value> = Vec::new();
            if let Some(ref sys) = system_prompt {
                if !sys.trim().is_empty() {
                    messages.push(serde_json::json!({
                        "role": "system",
                        "content": sys
                    }));
                }
            }

            for msg in history.iter() {
                messages.push(serde_json::json!({
                    "role": msg.role,
                    "content": msg.content
                }));
            }

            let body = serde_json::json!({
                "model": model,
                "messages": messages,
                "stream": true
            });

            let res = match client
                .post(url)
                .header("Authorization", format!("Bearer {}", api_key))
                .json(&body)
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    let _ = tx.send(Err(format!("OpenAI network error: {}", e))).await;
                    return;
                }
            };

            if !res.status().is_success() {
                let status = res.status();
                let err_text = res.text().await.unwrap_or_else(|_| "Unknown error".to_string());
                let _ = tx.send(Err(format!("OpenAI API error ({}): {}", status, err_text))).await;
                return;
            }

            let mut stream = res.bytes_stream();
            let mut buffer = String::new();

            while let Some(chunk_result) = stream.next().await {
                match chunk_result {
                    Ok(bytes) => {
                        if let Ok(text) = std::str::from_utf8(&bytes) {
                            buffer.push_str(text);

                            while let Some(newline_idx) = buffer.find('\n') {
                                let line = buffer[..newline_idx].trim().to_string();
                                buffer.drain(..=newline_idx);

                                if line.starts_with("data: ") {
                                    let data_str = line.trim_start_matches("data: ").trim();
                                    if data_str == "[DONE]" {
                                        break;
                                    }
                                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(data_str) {
                                        if let Some(delta) = val["choices"][0]["delta"]["content"].as_str() {
                                            if !delta.is_empty() {
                                                if tx.send(Ok(delta.to_string())).await.is_err() {
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(format!("Stream error: {}", e))).await;
                        break;
                    }
                }
            }
        });

        let response_stream = futures_util::stream::unfold(rx, |mut rx| async move {
            match rx.recv().await {
                Some(item) => Some((item, rx)),
                None => None,
            }
        });

        Box::pin(response_stream)
    }
}

// ==========================================
// 4. ANTHROPIC PROVIDER (Claude API)
// ==========================================
pub struct AnthropicProvider {
    api_key: String,
    model: String,
    system_prompt: Option<String>,
}

impl AnthropicProvider {
    pub fn new(api_key: String, model: Option<String>, system_prompt: Option<String>) -> Self {
        Self {
            api_key,
            model: model.unwrap_or_else(|| "claude-3-5-sonnet-20241022".to_string()),
            system_prompt,
        }
    }
}

impl AiProvider for AnthropicProvider {
    fn stream_chat(&self, history: &[ChatMessage]) -> BoxStream<Result<String, String>> {
        let api_key = self.api_key.clone();
        let model = self.model.clone();
        let system_prompt = self.system_prompt.clone();
        let history = history.to_vec();
        let (tx, rx) = mpsc::channel(100);

        tokio::spawn(async move {
            let client = reqwest::Client::new();
            let url = "https://api.anthropic.com/v1/messages";

            let mut messages: Vec<serde_json::Value> = Vec::new();
            for msg in history.iter() {
                let role = if msg.role == "assistant" { "assistant" } else { "user" };
                messages.push(serde_json::json!({
                    "role": role,
                    "content": msg.content
                }));
            }

            let mut body_map = serde_json::json!({
                "model": model,
                "max_tokens": 4096,
                "messages": messages,
                "stream": true
            });

            if let Some(ref sys) = system_prompt {
                if !sys.trim().is_empty() {
                    body_map["system"] = serde_json::json!(sys);
                }
            }

            let res = match client
                .post(url)
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&body_map)
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    let _ = tx.send(Err(format!("Anthropic network error: {}", e))).await;
                    return;
                }
            };

            if !res.status().is_success() {
                let status = res.status();
                let err_text = res.text().await.unwrap_or_else(|_| "Unknown error".to_string());
                let _ = tx.send(Err(format!("Anthropic API error ({}): {}", status, err_text))).await;
                return;
            }

            let mut stream = res.bytes_stream();
            let mut buffer = String::new();

            while let Some(chunk_result) = stream.next().await {
                match chunk_result {
                    Ok(bytes) => {
                        if let Ok(text) = std::str::from_utf8(&bytes) {
                            buffer.push_str(text);

                            while let Some(newline_idx) = buffer.find('\n') {
                                let line = buffer[..newline_idx].trim().to_string();
                                buffer.drain(..=newline_idx);

                                if line.starts_with("data: ") {
                                    let data_str = line.trim_start_matches("data: ").trim();
                                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(data_str) {
                                        if val["type"] == "content_block_delta" {
                                            if let Some(text_delta) = val["delta"]["text"].as_str() {
                                                if !text_delta.is_empty() {
                                                    if tx.send(Ok(text_delta.to_string())).await.is_err() {
                                                        break;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(format!("Stream error: {}", e))).await;
                        break;
                    }
                }
            }
        });

        let response_stream = futures_util::stream::unfold(rx, |mut rx| async move {
            match rx.recv().await {
                Some(item) => Some((item, rx)),
                None => None,
            }
        });

        Box::pin(response_stream)
    }
}
