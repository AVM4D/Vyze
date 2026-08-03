use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[allow(dead_code)]
pub struct SendStream(pub Stream);
unsafe impl Send for SendStream {}
unsafe impl Sync for SendStream {}

pub struct AudioRecorder {
    recording: Arc<AtomicBool>,
    buffer: Arc<Mutex<Vec<f32>>>,
    stream: Option<SendStream>,
    sample_rate: u32,
}

impl AudioRecorder {
    pub fn new() -> Self {
        Self {
            recording: Arc::new(AtomicBool::new(false)),
            buffer: Arc::new(Mutex::new(Vec::new())),
            stream: None,
            sample_rate: 16000,
        }
    }

    pub fn is_recording(&self) -> bool {
        self.recording.load(Ordering::SeqCst)
    }

    pub fn start_recording(&mut self) -> Result<(), String> {
        if self.is_recording() {
            return Ok(());
        }

        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "No microphone input device found on system".to_string())?;

        let config = device
            .default_input_config()
            .map_err(|e| format!("Failed to get default microphone config: {}", e))?;

        let sample_rate = config.sample_rate().0;
        self.sample_rate = sample_rate;

        let buffer = Arc::new(Mutex::new(Vec::new()));
        self.buffer = buffer.clone();

        let recording = Arc::new(AtomicBool::new(true));
        self.recording = recording.clone();

        let err_fn = |err| eprintln!("Audio input stream error: {}", err);

        let stream = match config.sample_format() {
            SampleFormat::F32 => {
                let buf = buffer.clone();
                let rec = recording.clone();
                device.build_input_stream(
                    &config.into(),
                    move |data: &[f32], _: &_| {
                        if rec.load(Ordering::SeqCst) {
                            if let Ok(mut b) = buf.lock() {
                                b.extend_from_slice(data);
                            }
                        }
                    },
                    err_fn,
                    None,
                )
            }
            SampleFormat::I16 => {
                let buf = buffer.clone();
                let rec = recording.clone();
                device.build_input_stream(
                    &config.into(),
                    move |data: &[i16], _: &_| {
                        if rec.load(Ordering::SeqCst) {
                            if let Ok(mut b) = buf.lock() {
                                for &sample in data {
                                    b.push(sample as f32 / 32768.0);
                                }
                            }
                        }
                    },
                    err_fn,
                    None,
                )
            }
            SampleFormat::U16 => {
                let buf = buffer.clone();
                let rec = recording.clone();
                device.build_input_stream(
                    &config.into(),
                    move |data: &[u16], _: &_| {
                        if rec.load(Ordering::SeqCst) {
                            if let Ok(mut b) = buf.lock() {
                                for &sample in data {
                                    b.push((sample as f32 - 32768.0) / 32768.0);
                                }
                            }
                        }
                    },
                    err_fn,
                    None,
                )
            }
            _ => return Err("Unsupported audio sample format".to_string()),
        }
        .map_err(|e| format!("Failed to build audio input stream: {}", e))?;

        stream
            .play()
            .map_err(|e| format!("Failed to start audio playback stream: {}", e))?;

        self.stream = Some(SendStream(stream));
        Ok(())
    }

    pub fn stop_recording(&mut self) -> Result<Vec<f32>, String> {
        self.recording.store(false, Ordering::SeqCst);
        self.stream = None;

        let raw_samples = if let Ok(mut b) = self.buffer.lock() {
            std::mem::take(&mut *b)
        } else {
            Vec::new()
        };

        if raw_samples.is_empty() {
            return Ok(Vec::new());
        }

        // Resample from hardware sample rate (e.g., 44100/48000 Hz) down to 16000 Hz Mono
        let resampled = resample_to_16k(&raw_samples, self.sample_rate, 16000);
        Ok(resampled)
    }
}

/// Simple linear interpolation resampling helper to convert hardware PCM to 16,000 Hz Mono.
fn resample_to_16k(input: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate || input.is_empty() {
        return input.to_vec();
    }

    let ratio = from_rate as f64 / to_rate as f64;
    let new_len = (input.len() as f64 / ratio) as usize;
    let mut output = Vec::with_capacity(new_len);

    for i in 0..new_len {
        let index = i as f64 * ratio;
        let left = index.floor() as usize;
        let right = (left + 1).min(input.len() - 1);
        let frac = index - index.floor();

        let sample = input[left] * (1.0 - frac as f32) + input[right] * (frac as f32);
        output.push(sample);
    }

    output
}
