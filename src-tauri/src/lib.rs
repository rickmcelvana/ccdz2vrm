//! The desktop shell: the page asks, Rust does every file and process job.
//!
//! Conversion runs in the user's own Blender (see blender.rs for why none ships). The pipeline
//! scripts travel as resources (`pipeline/`); a debug build reads them from the repo instead.

mod blender;
mod fbx;
mod pipeline;

use pipeline::{ConvertRequest, JobEvent, Running};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Settings {
    blender_path: Option<String>,
    out_dir: Option<String>,
}

fn settings_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: &Settings) {
    if let Some(p) = settings_file(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, serde_json::to_string_pretty(s).unwrap_or_default());
    }
}

fn scripts_dir(app: &AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/blender")
    } else {
        app.path()
            .resource_dir()
            .map(|d| d.join("pipeline"))
            .unwrap_or_default()
    }
}

fn chosen_blender(app: &AppHandle) -> Option<PathBuf> {
    load_settings(app).blender_path.map(PathBuf::from)
}

/// Blender in use, its version, and whether the VRM add-on is there. Takes a few seconds (it
/// starts Blender twice), so the page shows a spinner.
#[tauri::command]
async fn blender_status(app: AppHandle) -> blender::BlenderStatus {
    let chosen = chosen_blender(&app);
    tauri::async_runtime::spawn_blocking(move || blender::status(chosen.as_deref()))
        .await
        .unwrap_or_default()
}

/// Use this Blender from now on (a path from the found list, or one the person picked).
#[tauri::command]
async fn set_blender(app: AppHandle, path: String) -> blender::BlenderStatus {
    let mut s = load_settings(&app);
    s.blender_path = Some(path);
    save_settings(&app, &s);
    blender_status(app).await
}

#[tauri::command]
async fn pick_blender(app: AppHandle) -> Option<blender::BlenderStatus> {
    let mut dialog = app.dialog().file().set_title("Find blender.exe");
    if cfg!(windows) {
        dialog = dialog.add_filter("Blender", &["exe"]);
    }
    let picked = dialog.blocking_pick_file()?.into_path().ok()?;
    Some(set_blender(app, picked.display().to_string()).await)
}

/// Download and enable the VRM add-on into the person's Blender (asked for on the page first).
#[tauri::command]
async fn install_vrm_addon(app: AppHandle) -> Result<blender::BlenderStatus, String> {
    let status = blender_status(app.clone()).await;
    let exe = status.path.clone().ok_or("No Blender to install into.")?;
    tauri::async_runtime::spawn_blocking(move || blender::install_vrm_addon(Path::new(&exe)))
        .await
        .map_err(|e| e.to_string())??;
    Ok(blender_status(app).await)
}

#[tauri::command]
async fn inspect_fbx(path: String) -> Result<fbx::FbxInfo, String> {
    tauri::async_runtime::spawn_blocking(move || fbx::inspect(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pick_fbx(app: AppHandle) -> Result<Option<fbx::FbxInfo>, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("Choose a Daz or Character Creator FBX export")
        .add_filter("FBX", &["fbx", "Fbx", "FBX"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    inspect_fbx(path.display().to_string()).await.map(Some)
}

/// Where VRMs are saved: the last folder chosen, else Documents/ccdz2vrm.
#[tauri::command]
fn out_dir(app: AppHandle) -> String {
    load_settings(&app).out_dir.unwrap_or_else(|| {
        app.path()
            .document_dir()
            .map(|d| d.join("ccdz2vrm").display().to_string())
            .unwrap_or_default()
    })
}

#[tauri::command]
async fn pick_out_dir(app: AppHandle) -> Option<String> {
    let dir = app
        .dialog()
        .file()
        .set_title("Save VRMs in")
        .blocking_pick_folder()?
        .into_path()
        .ok()?
        .display()
        .to_string();
    let mut s = load_settings(&app);
    s.out_dir = Some(dir.clone());
    save_settings(&app, &s);
    Some(dir)
}

/// Start a conversion; progress arrives as `job` events. Returns at once.
#[tauri::command]
fn start_convert(
    app: AppHandle,
    running: State<'_, Running>,
    req: ConvertRequest,
) -> Result<(), String> {
    let exe = blender::status(chosen_blender(&app).as_deref());
    if !exe.ready() {
        return Err(exe
            .problem
            .unwrap_or_else(|| "Blender is not ready.".into()));
    }
    let blender_exe = PathBuf::from(exe.path.unwrap_or_default());
    let scripts = scripts_dir(&app);
    let job = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("job");
    let running = running.inner().clone();
    std::thread::spawn(move || {
        let emit = |ev: JobEvent| {
            let _ = app.emit("job", ev);
        };
        pipeline::run(&blender_exe, &req, &scripts, &job, &running, &emit);
    });
    Ok(())
}

#[tauri::command]
fn cancel_convert(running: State<'_, Running>) {
    running.cancel();
}

/// A finished VRM's bytes for the preview. Only .vrm files are served.
#[tauri::command]
async fn read_vrm(path: String) -> Result<tauri::ipc::Response, String> {
    if !path.to_ascii_lowercase().ends_with(".vrm") {
        return Err("Only .vrm files can be previewed.".into());
    }
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn reveal(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| e.to_string())
}

/// The few pages the app links to; the page names one, never a URL.
#[tauri::command]
fn open_link(app: AppHandle, which: String) -> Result<(), String> {
    let url = match which.as_str() {
        "blender" => "https://www.blender.org/download/",
        "vrm-addon" => "https://extensions.blender.org/add-ons/vrm/",
        "latentpresence" => "https://latentpresence.com",
        _ => return Err(format!("unknown link {which}")),
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Running::default())
        .invoke_handler(tauri::generate_handler![
            blender_status,
            set_blender,
            pick_blender,
            install_vrm_addon,
            inspect_fbx,
            pick_fbx,
            out_dir,
            pick_out_dir,
            start_convert,
            cancel_convert,
            read_vrm,
            reveal,
            open_link
        ])
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
