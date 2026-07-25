use futures_util::Stream;
use futures_util::StreamExt;
use std::pin::Pin;
use tokio::sync::mpsc;

// Type alias for pinned, thread-safe asynchronous streams
pub type BoxStream<T> = Pin<Box<dyn Stream<Item = T> + Send>>;

// Standard blueprint for any AI model provider
pub trait AiProvider: Send + Sync {
    fn stream_chat(&self, prompt: &str) -> BoxStream<Result<String, String>>;
}

// ==========================================
// 1. GOOGLE GEMINI PROVIDER (Cloud API)
// ==========================================
pub struct GeminiProvider {
    api_key: String,
    model: String,
}

impl GeminiProvider {
    // We create a new client, letting the user pass an optional model.
    // If they pass None, we default to "gemini-3.5-flash".
    pub fn new(api_key: String, model: Option<String>) -> Self {
        Self {
            api_key,
            model: model.unwrap_or_else(|| "gemini-3.5-flash".to_string()),
        }
    }
}

impl AiProvider for GeminiProvider {
    fn stream_chat(&self, prompt: &str) -> BoxStream<Result<String, String>> {
        let api_key = self.api_key.clone();
        let model = self.model.clone();
        let prompt = prompt.to_string();
        let (tx, rx) = mpsc::channel(100);

        tokio::spawn(async move {
            let client = reqwest::Client::new();
            let url = format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse&key={}",
                model, api_key
            );

            let body = serde_json::json!({
                "contents": [
                    {
                        "parts": [
                            {
                                "text": prompt
                            }
                        ]
                    }
                ]
            });

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
}

impl OllamaProvider {
    pub fn new(model: Option<String>) -> Self {
        Self {
            model: model.unwrap_or_else(|| "llama3".to_string()),
        }
    }
}

impl AiProvider for OllamaProvider {
    fn stream_chat(&self, prompt: &str) -> BoxStream<Result<String, String>> {
        let model = self.model.clone();
        let prompt = prompt.to_string();
        let (tx, rx) = mpsc::channel(100);

        tokio::spawn(async move {
            let client = reqwest::Client::new();
            let url = "http://localhost:11434/v1/chat/completions";

            // Construct standard OpenAI JSON payload
            let body = serde_json::json!({
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                "stream": true
            });

            // Send request to local Ollama port
            let res = match client.post(url).json(&body).send().await {
                Ok(response) => response,
                Err(e) => {
                    let _ = tx
                        .send(Err(format!("Local Ollama network error: {}", e)))
                        .await;
                    return;
                }
            };

            // Handle errors (e.g. if the user didn't pull the Llama3 model first)
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

                                if line.starts_with("data:") {
                                    let json_str = line["data:".len()..].trim();

                                    // Ollama sends [DONE] to signal completion
                                    if json_str == "[DONE]" {
                                        break;
                                    }

                                    // Parse choices[0].delta.content
                                    if let Ok(val) =
                                        serde_json::from_str::<serde_json::Value>(json_str)
                                    {
                                        if let Some(text_val) =
                                            val["choices"][0]["delta"]["content"].as_str()
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
