use reqwest::Client;
use serde::{Deserialize, Serialize};

// --- Gemini API Request & Response Structs ---
#[derive(Serialize)]
struct GeminiPart {
    text: String,
}

#[derive(Serialize)]
struct GeminiContent {
    parts: Vec<GeminiPart>,
}

#[derive(Serialize)]
struct GeminiEmbeddingRequest {
    model: String,
    content: GeminiContent,
}

#[derive(Deserialize)]
struct GeminiEmbeddingObj {
    values: Vec<f32>,
}

#[derive(Deserialize)]
struct GeminiEmbeddingResponse {
    embedding: Option<GeminiEmbeddingObj>,
}

// --- Ollama API Request & Response Structs ---
#[derive(Serialize)]
struct OllamaEmbeddingRequest {
    model: String,
    prompt: String,
}

#[derive(Deserialize)]
struct OllamaEmbeddingResponse {
    embedding: Vec<f32>,
}

/// Generates a vector embedding for the given text using either Gemini or Ollama.
pub async fn generate_embedding(text: &str, provider: &str) -> Result<Vec<f32>, String> {
    let clean_text = text.trim();
    if clean_text.is_empty() {
        return Err("Cannot generate embedding for empty text".to_string());
    }

    let client = Client::new();

    match provider {
        "gemini" => {
            let api_key = std::env::var("GEMINI_API_KEY").map_err(|_| {
                "GEMINI_API_KEY environment variable is not set.".to_string()
            })?;

            let url = format!(
                "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key={}",
                api_key
            );

            let body = GeminiEmbeddingRequest {
                model: "models/text-embedding-004".to_string(),
                content: GeminiContent {
                    parts: vec![GeminiPart {
                        text: clean_text.to_string(),
                    }],
                },
            };

            let res = client
                .post(&url)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Gemini Embedding HTTP request failed: {}", e))?;

            if !res.status().is_success() {
                let err_text = res.text().await.unwrap_or_default();
                return Err(format!("Gemini Embedding API returned error: {}", err_text));
            }

            let response_json: GeminiEmbeddingResponse = res
                .json()
                .await
                .map_err(|e| format!("Failed to parse Gemini embedding JSON: {}", e))?;

            match response_json.embedding {
                Some(emb) => Ok(emb.values),
                None => Err("Gemini API returned an empty embedding object".to_string()),
            }
        }
        "ollama" => {
            let model = std::env::var("OLLAMA_EMBED_MODEL")
                .unwrap_or_else(|_| "nomic-embed-text".to_string());

            let url = "http://localhost:11434/api/embeddings";
            let body = OllamaEmbeddingRequest {
                model,
                prompt: clean_text.to_string(),
            };

            let res = client
                .post(url)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Ollama Embedding HTTP request failed: {}", e))?;

            if !res.status().is_success() {
                let err_text = res.text().await.unwrap_or_default();
                return Err(format!("Ollama Embedding API error: {}", err_text));
            }

            let response_json: OllamaEmbeddingResponse = res
                .json()
                .await
                .map_err(|e| format!("Failed to parse Ollama embedding JSON: {}", e))?;

            Ok(response_json.embedding)
        }
        _ => Err(format!("Unsupported embedding provider: {}", provider)),
    }
}
