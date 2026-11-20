fn main() {
    // ONNX Runtime's macOS static library uses `@available(...)` checks, which need
    // `___isPlatformVersionAtLeast` from clang's runtime library. Rust links with
    // `-nodefaultlibs`, so add that library explicitly.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        if let Ok(out) = std::process::Command::new("xcrun")
            .args(["clang", "--print-runtime-dir"])
            .output()
        {
            let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !dir.is_empty() {
                println!("cargo:rustc-link-search=native={dir}");
                println!("cargo:rustc-link-lib=static=clang_rt.osx");
            }
        }
    }
    tauri_build::build()
}
