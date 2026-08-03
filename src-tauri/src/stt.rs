use reqwest::Client;
use std::io::Write;

/// Converts a 16,000 Hz Mono f32 audio buffer into a 16-bit PCM WAV file in memory.
fn samples_to_wav_bytes(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let mut cursor = std::io::Cursor::new(Vec::new());

    let data_len = (samples.len() * 2) as u32;
    let file_len = 36 + data_len;

    // RIFF Header
    let _ = cursor.write_all(b"RIFF");
    let _ = cursor.write_all(&file_len.to_le_bytes());
    let _ = cursor.write_all(b"WAVE");

    // fmt Sub-chunk
    let _ = cursor.write_all(b"fmt ");
    let _ = cursor.write_all(&16u32.to_le_bytes()); // Subchunk1Size (16 for PCM)
    let _ = cursor.write_all(&1u16.to_le_bytes());  // AudioFormat (1 for PCM)
    let _ = cursor.write_all(&1u16.to_le_bytes());  // NumChannels (1 Mono)
    let _ = cursor.write_all(&sample_rate.to_le_bytes()); // SampleRate (16000)
    let byte_rate = sample_rate * 2;
    let _ = cursor.write_all(&byte_rate.to_le_bytes());   // ByteRate
    let _ = cursor.write_all(&2u16.to_le_bytes());         // BlockAlign
    let _ = cursor.write_all(&16u16.to_le_bytes());        // BitsPerSample (16-bit)

    // data Sub-chunk
    let _ = cursor.write_all(b"data");
    let _ = cursor.write_all(&data_len.to_le_bytes());

    // Convert f32 samples (-1.0 to 1.0) into i16 (-32768 to 32767)
    for &sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        let sample_i16 = (clamped * 32767.0) as i16;
        let _ = cursor.write_all(&sample_i16.to_le_bytes());
    }

    cursor.into_inner()
}

/// Transcribes 16kHz PCM audio samples into text using OpenAI Whisper API or local Whisper endpoint.
pub async fn transcribe_audio(samples: &[f32]) -> Result<String, String> {
    if samples.is_empty() {
        return Err("No audio samples recorded".to_string());
    }

    let wav_bytes = samples_to_wav_bytes(samples, 16000);
    let client = Client::new();

    // Check if OpenAI API key is present
    if let Ok(api_key) = std::env::var("OPENAI_API_KEY") {
        let part = reqwest::multipart::Part::bytes(wav_bytes)
            .file_name("speech.wav")
            .mime_str("audio/wav")
            .map_err(|e| format!("Multipart format error: {}", e))?;

        let form = reqwest::multipart::Form::new()
            .text("model", "whisper-1")
            .part("file", part);

        let res = client
            .post("https://api.openai.com/v1/audio/transcriptions")
            .header("Authorization", format!("Bearer {}", api_key))
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("Whisper API HTTP request failed: {}", e))?;

        if !res.status().is_success() {
            let err_body = res.text().await.unwrap_or_default();
            return Err(format!("Whisper API error: {}", err_body));
        }

        #[derive(serde::Deserialize)]
        struct WhisperResponse {
            text: String,
        }

        let parsed: WhisperResponse = res
            .json()
            .await
            .map_err(|e| format!("Failed to parse Whisper response JSON: {}", e))?;

        return Ok(parsed.text.trim().to_string());
    }

    // Local Whisper Server Fallback (http://localhost:8080/inference)
    let local_url = std::env::var("WHISPER_LOCAL_URL")
        .unwrap_or_else(|_| "http://localhost:8080/inference".to_string());

    let part = reqwest::multipart::Part::bytes(wav_bytes)
        .file_name("speech.wav")
        .mime_str("audio/wav")
        .map_err(|e| format!("Multipart format error: {}", e))?;

    let form = reqwest::multipart::Form::new().part("file", part);

    match client.post(&local_url).multipart(form).send().await {
        Ok(res) => {
            if res.status().is_success() {
                #[derive(serde::Deserialize)]
                struct LocalWhisperResponse {
                    text: Option<String>,
                }
                if let Ok(parsed) = res.json::<LocalWhisperResponse>().await {
                    if let Some(text) = parsed.text {
                        return Ok(text.trim().to_string());
                    }
                }
            }
        }
        Err(_) => {}
    }

    Err("Neither OPENAI_API_KEY nor local Whisper server (http://localhost:8080/inference) was accessible.".to_string())
}
