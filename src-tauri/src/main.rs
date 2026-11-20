// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod voice;

fn main() {
    tauri::Builder::default()
        .manage(voice::VoiceState::default())
        .invoke_handler(tauri::generate_handler![
            voice::voice_status,
            voice::voice_install,
            voice::voice_infer
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lector");
}
