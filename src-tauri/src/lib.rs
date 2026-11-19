use std::{net::TcpListener, sync::Mutex};

use base64::Engine as _;
use rand::{distributions::Alphanumeric, Rng};
use serde_json::{json, Value};
use tauri::{Emitter, Manager, RunEvent, State};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

/// The browser extension looks for the engine here. If this port is taken, a random one is used instead.
const BRIDGE_PORT: u16 = 16800;

struct RpcConfig {
    port: u16,
    secret: String,
}

struct Aria2Child(Mutex<Option<CommandChild>>);

/// Magnet links and .torrent files that Windows handed to the app, waiting for the UI to pick them up.
struct Pending(Mutex<Vec<Value>>);

/// Looks through command-line arguments for magnet links and .torrent files.
/// Windows starts "NexFetch.exe <magnet-or-file>" when you click a magnet link or open a .torrent.
fn launch_items<I: IntoIterator<Item = String>>(args: I) -> Vec<Value> {
    let mut out = Vec::new();
    for arg in args {
        let lower = arg.to_lowercase();
        if lower.starts_with("magnet:") {
            out.push(json!({ "type": "magnet", "value": arg }));
        } else if lower.ends_with(".torrent") {
            let path = std::path::Path::new(&arg);
            let small_enough = std::fs::metadata(path)
                .map(|m| m.len() < 8 * 1024 * 1024)
                .unwrap_or(false);
            if small_enough {
                if let Ok(bytes) = std::fs::read(path) {
                    let name = path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| "file.torrent".to_string());
                    out.push(json!({
                        "type": "torrent",
                        "name": name,
                        "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                    }));
                }
            }
        }
    }
    out
}

/// The UI asks for these once on startup to connect to the local aria2 engine.
#[tauri::command]
fn rpc_config(cfg: State<'_, RpcConfig>) -> Value {
    json!({ "port": cfg.port, "secret": cfg.secret })
}

/// The UI calls this on startup and whenever it gets a "launch-items" event.
#[tauri::command]
fn take_launch_items(pending: State<'_, Pending>) -> Vec<Value> {
    std::mem::take(&mut *pending.0.lock().unwrap())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Must be the first plugin. A second launch (for example clicking a magnet link)
        // hands its arguments to the copy that is already running, then exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let items = launch_items(argv.into_iter().skip(1));
            if let Some(pending) = app.try_state::<Pending>() {
                pending.0.lock().unwrap().extend(items);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app.emit("launch-items", ());
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![rpc_config, take_launch_items])
        .setup(|app| {
            // Items from the very first launch (app was closed when the link was clicked).
            app.manage(Pending(Mutex::new(launch_items(std::env::args().skip(1)))));

            // Same port and secret on every launch, so the browser extension only has to be paired once.
            let port = if TcpListener::bind(("127.0.0.1", BRIDGE_PORT)).is_ok() {
                BRIDGE_PORT
            } else {
                TcpListener::bind("127.0.0.1:0")?.local_addr()?.port()
            };
            let config_dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&config_dir)?;
            let secret_file = config_dir.join("rpc-secret.txt");
            let secret: String = match std::fs::read_to_string(&secret_file) {
                Ok(saved) if saved.trim().len() >= 24 => saved.trim().to_string(),
                _ => {
                    let fresh: String = rand::thread_rng()
                        .sample_iter(&Alphanumeric)
                        .take(32)
                        .map(char::from)
                        .collect();
                    let _ = std::fs::write(&secret_file, &fresh);
                    fresh
                }
            };
            let dir = app.path().download_dir()?.to_string_lossy().to_string();

            let args: Vec<String> = vec![
                "--enable-rpc=true".into(),
                format!("--rpc-listen-port={port}"),
                format!("--rpc-secret={secret}"),
                "--rpc-listen-all=false".into(),
                format!("--stop-with-process={}", std::process::id()),
                format!("--dir={dir}"),
                "--continue=true".into(),
                "--max-concurrent-downloads=5".into(),
                "--max-connection-per-server=16".into(),
                "--split=16".into(),
                "--min-split-size=1M".into(),
                "--file-allocation=none".into(),
                "--auto-file-renaming=true".into(),
                "--console-log-level=warn".into(),
                "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36".into(),
            ];

            let (mut rx, child) = app.shell().sidecar("aria2c")?.args(args).spawn()?;

            tauri::async_runtime::spawn(async move { while rx.recv().await.is_some() {} });

            app.manage(RpcConfig { port, secret });
            app.manage(Aria2Child(Mutex::new(Some(child))));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building NexFetch");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<Aria2Child>() {
                if let Some(child) = state.0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        }
    });
}
