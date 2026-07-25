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

// Struct representing the Google Gemini client
pub struct GeminiProvider {
    api_key: String,
    model: String, // Made the model name configurable
}

impl GeminiProvider {
    // We create a new client, letting the user pass an optional model.
    // If they pass None, we default to "gemini-2.5-flash".
    pub fn new(api_key: String, model: Option<String>) -> Self {
        Self {
            api_key,
            model: model.unwrap_or_else(|| "gemini-2.5-flash".to_string()),
        }
    }
}

impl AiProvider for GeminiProvider {
    fn stream_chat(&self, prompt: &str) -> BoxStream<Result<String, String>> {
        // Clone variables so they can be moved inside the async background task
        let api_key = self.api_key.clone();
        let model = self.model.clone();
        let prompt = prompt.to_string();

        // Create a channel (sender/receiver) to pass words from the background thread to the UI
        let (tx, rx) = mpsc::channel(100);

        // Spawn a background task to handle the web request
        tokio::spawn(async move {
            let client = reqwest::Client::new();
            let url = format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse&key={}",
                model, api_key
            );

            // Construct the JSON request body required by Gemini's API
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

            // Send the POST request to Google's server
            let res = match client.post(&url).json(&body).send().await {
                Ok(response) => response,
                Err(e) => {
                    let _ = tx.send(Err(format!("Network error: {}", e))).await;
                    return;
                }
            };

            // If Google returned an error status code (like 400 Bad Request or 403 Invalid Key)
            if !res.status().is_success() {
                let status = res.status(); // Save the status first!
                let err_text = res
                    .text()
                    .await
                    .unwrap_or_else(|_| "Unknown error".to_string());
                let _ = tx
                    .send(Err(format!("API error ({}): {}", status, err_text)))
                    .await;
                return;
            }

            // Convert the response into a stream of raw bytes
            let mut stream = res.bytes_stream();
            let mut buffer = String::new();

            // Loop and read chunks as they arrive over the internet
            while let Some(chunk_result) = stream.next().await {
                match chunk_result {
                    Ok(bytes) => {
                        // Convert binary bytes to a UTF-8 string slice
                        if let Ok(text) = std::str::from_utf8(&bytes) {
                            buffer.push_str(text);

                            // Process buffer line-by-line
                            while let Some(newline_idx) = buffer.find('\n') {
                                // Extract the line (excluding the \n character)
                                let line = buffer[..newline_idx].trim().to_string();
                                // Remove the processed line from the buffer
                                buffer.drain(..=newline_idx);

                                // If the line starts with "data:", it contains a JSON packet
                                if line.starts_with("data:") {
                                    let json_str = line["data:".len()..].trim();

                                    // Parse the JSON and extract the text token
                                    if let Ok(val) =
                                        serde_json::from_str::<serde_json::Value>(json_str)
                                    {
                                        if let Some(text_val) = val["candidates"][0]["content"]
                                            ["parts"][0]["text"]
                                            .as_str()
                                        {
                                            // Send the word token through the channel
                                            if tx.send(Ok(text_val.to_string())).await.is_err() {
                                                break; // Receiver hung up, exit loop
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

        // Convert our Channel Receiver into a futures Stream using unfold
        let response_stream = futures_util::stream::unfold(rx, |mut rx| async move {
            match rx.recv().await {
                Some(item) => Some((item, rx)),
                None => None, // Stream finished
            }
        });

        // Pin the stream in memory and return it
        Box::pin(response_stream)
    }
}
