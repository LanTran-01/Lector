//! Native inference for the Kokoro neural voice (Apache-2.0).
//!
//! The web view prepares the input (text cleanup, phonemes, token ids and the
//! voice's style vector); this module runs the ONNX model with ONNX Runtime on
//! all CPU cores and returns raw audio samples. The ~90 MB model is downloaded
//! once by the web view and stored in the app's data folder.

use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use ort::{
    environment::Environment,
    session::{builder::GraphOptimizationLevel, Session},
    value::Tensor,
};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    AppHandle, Manager, State,
};

const MODEL_FILE: &str = "kokoro-82m-v1.0-q8.onnx";
const STYLE_DIM: usize = 256;

#[derive(Default)]
pub struct VoiceState {
    inner: Arc<Mutex<Option<Loaded>>>,
}

struct Loaded {
    session: Session,
    _env: Environment, // must outlive the session
}

fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(MODEL_FILE))
}

fn load(path: &PathBuf) -> Result<Loaded, String> {
    let env = ort::init().with_name("lector").build().map_err(|e| e.to_string())?;
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 8);
    let session = Session::builder(&env)
        .map_err(|e| e.to_string())?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| e.to_string())?
        .with_intra_threads(threads)
        .map_err(|e| e.to_string())?
        .commit_from_file(path)
        .map_err(|e| e.to_string())?;
    Ok(Loaded { session, _env: env })
}

/// Returns true when the model is ready, loading it from disk if it was downloaded before.
#[tauri::command]
pub async fn voice_status(app: AppHandle, state: State<'_, VoiceState>) -> Result<bool, String> {
    let inner = state.inner.clone();
    let path = model_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = inner.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Ok(true);
        }
        if !path.exists() {
            return Ok(false);
        }
        match load(&path) {
            Ok(l) => {
                *guard = Some(l);
                Ok(true)
            }
            Err(e) => {
                // A corrupt/partial file: delete it so the next attempt downloads again.
                let _ = fs::remove_file(&path);
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Receives the downloaded model bytes (raw request body), saves and loads them.
#[tauri::command]
pub async fn voice_install(app: AppHandle, state: State<'_, VoiceState>, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw model bytes".into());
    };
    if bytes.len() < 1_000_000 {
        return Err("model download looks incomplete".into());
    }
    let bytes = bytes.clone();
    let path = model_path(&app)?;
    let inner = state.inner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let tmp = path.with_extension("part");
        fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        let loaded = load(&path).inspect_err(|_| {
            let _ = fs::remove_file(&path);
        })?;
        *inner.lock().map_err(|e| e.to_string())? = Some(loaded);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runs the model. Returns the waveform as little-endian f32 bytes at 24 kHz.
#[tauri::command]
pub async fn voice_infer(
    state: State<'_, VoiceState>,
    input_ids: Vec<i64>,
    style: Vec<f32>,
    speed: f32,
) -> Result<Response, String> {
    if style.len() != STYLE_DIM {
        return Err(format!("style vector must have {STYLE_DIM} values"));
    }
    let inner = state.inner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = inner.lock().map_err(|e| e.to_string())?;
        let loaded = guard.as_mut().ok_or("voice model is not loaded")?;

        let n = input_ids.len();
        let ids = Tensor::from_array(([1usize, n], input_ids)).map_err(|e| e.to_string())?;
        let style = Tensor::from_array(([1usize, STYLE_DIM], style)).map_err(|e| e.to_string())?;
        let speed = Tensor::from_array(([1usize], vec![speed])).map_err(|e| e.to_string())?;

        let outputs = loaded
            .session
            .run(ort::inputs!["input_ids" => ids, "style" => style, "speed" => speed])
            .map_err(|e| e.to_string())?;
        let (_, samples) = outputs["waveform"]
            .try_extract_tensor::<f32>()
            .map_err(|e| e.to_string())?;

        let mut bytes = Vec::with_capacity(samples.len() * 4);
        for s in samples {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        Ok(Response::new(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}
