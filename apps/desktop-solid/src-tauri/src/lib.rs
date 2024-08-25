mod camera;
mod display;
mod ffmpeg;
mod macos;
mod project;
mod recording;
mod utils;
mod video_renderer;

use mp4::Mp4Reader;
use objc2_app_kit::NSScreenSaverWindowLevel;
use project::ProjectConfiguration;
use recording::{DisplaySource, InProgressRecording};
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::fs::File;
use std::io::BufReader;
use std::{
    collections::HashMap, marker::PhantomData, path::PathBuf, process::Command, sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_nspanel::{cocoa::appkit::NSMainMenuWindowLevel, ManagerExt};
use tauri_plugin_decorum::WebviewWindowExt;
use tauri_specta::Event;
use tokio::{sync::RwLock, time::sleep};

use crate::utils::ffmpeg_path_as_str;
use crate::video_renderer::{render_video, RenderOptions};
use camera::{create_camera_window, get_cameras};
use display::{get_capture_windows, Bounds, CaptureTarget};

use ffmpeg_sidecar::{
    command::ffmpeg_is_installed,
    download::{check_latest_version, download_ffmpeg_package, ffmpeg_download_url, unpack_ffmpeg},
    paths::sidecar_dir,
    version::ffmpeg_version,
};

#[derive(specta::Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecordingOptions {
    capture_target: CaptureTarget,
    camera_label: Option<String>,
}

#[derive(specta::Type, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    start_recording_options: RecordingOptions,
    #[serde(skip)]
    handle: AppHandle,
    #[serde(skip)]
    current_recording: Option<InProgressRecording>,
    prev_recordings: Vec<PathBuf>,
}

const WINDOW_CAPTURE_OCCLUDER_LABEL: &str = "window-capture-occluder";

impl App {
    pub fn set_current_recording(&mut self, new_value: InProgressRecording) {
        let current_recording = self.current_recording.insert(new_value);

        if let DisplaySource::Window { .. } = &current_recording.display_source {
            match self
                .handle
                .get_webview_window(WINDOW_CAPTURE_OCCLUDER_LABEL)
            {
                None => {
                    let monitor = self.handle.primary_monitor().unwrap().unwrap();

                    let occluder_window = WebviewWindow::builder(
                        &self.handle,
                        WINDOW_CAPTURE_OCCLUDER_LABEL,
                        tauri::WebviewUrl::App("/window-capture-occluder".into()),
                    )
                    .title("Cap Window Capture Occluder")
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .decorations(false)
                    .shadow(false)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .content_protected(true)
                    .inner_size(
                        (monitor.size().width as f64) / monitor.scale_factor(),
                        (monitor.size().height as f64) / monitor.scale_factor(),
                    )
                    .position(0.0, 0.0)
                    .build()
                    .unwrap();

                    occluder_window
                        .set_window_level(NSScreenSaverWindowLevel as u32)
                        .unwrap();
                    occluder_window.set_ignore_cursor_events(true).unwrap();
                    occluder_window.make_transparent().unwrap();
                }
                Some(w) => {
                    w.show();
                }
            }
        } else {
            self.close_occluder_window();
        }
    }

    pub fn clear_current_recording(&mut self) -> Option<InProgressRecording> {
        self.close_occluder_window();

        self.current_recording.take()
    }

    fn close_occluder_window(&self) {
        self.handle
            .get_webview_window(WINDOW_CAPTURE_OCCLUDER_LABEL)
            .map(|window| window.close().ok());
    }

    fn set_start_recording_options(&mut self, new_value: RecordingOptions) {
        self.start_recording_options = new_value;
        let options = &self.start_recording_options;

        match self.handle.get_webview_window(camera::WINDOW_LABEL) {
            Some(window) if options.camera_label.is_none() => {
                window.close().ok();
            }
            None if options.camera_label.is_some() => {
                create_camera_window(self.handle.clone());
            }
            _ => {}
        }

        RecordingOptionsChanged.emit(&self.handle).ok();
    }
}

#[derive(specta::Type, Serialize, tauri_specta::Event, Clone)]
pub struct RecordingOptionsChanged;

// dedicated event + command used as panel must be accessed on main thread
#[derive(specta::Type, Serialize, tauri_specta::Event, Clone)]
pub struct ShowCapturesPanel;

type MutableState<'a, T> = State<'a, Arc<RwLock<T>>>;

#[tauri::command]
#[specta::specta]
async fn get_recording_options(state: MutableState<'_, App>) -> Result<RecordingOptions, ()> {
    let state = state.read().await;
    Ok(state.start_recording_options.clone())
}

#[tauri::command]
#[specta::specta]
async fn set_recording_options(
    state: MutableState<'_, App>,
    options: RecordingOptions,
) -> Result<(), ()> {
    state.write().await.set_start_recording_options(options);

    Ok(())
}

type Bruh<T> = (T,);

#[derive(Serialize, Type)]
struct JsonValue<T>(
    #[serde(skip)] PhantomData<T>,
    #[specta(type = Bruh<T>)] serde_json::Value,
);

impl<T: Serialize> JsonValue<T> {
    fn new(value: &T) -> Self {
        Self(PhantomData, json!(value))
    }
}

#[tauri::command]
#[specta::specta]
async fn get_current_recording(
    state: MutableState<'_, App>,
) -> Result<JsonValue<Option<InProgressRecording>>, ()> {
    let state = state.read().await;
    Ok(JsonValue::new(&state.current_recording))
}

#[tauri::command]
#[specta::specta]
async fn get_prev_recordings(state: MutableState<'_, App>) -> Result<Vec<PathBuf>, ()> {
    let state = state.read().await;
    Ok(state.prev_recordings.clone())
}

#[tauri::command]
#[specta::specta]
async fn start_recording(app: AppHandle, state: MutableState<'_, App>) -> Result<(), String> {
    let mut state = state.write().await;

    let id = uuid::Uuid::new_v4().to_string();

    let recording_dir = app
        .path()
        .app_data_dir()
        .unwrap()
        .join("recordings")
        .join(format!("{id}.cap"));

    let recording = recording::start(recording_dir, &state.start_recording_options).await;

    state.set_current_recording(recording);

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn stop_recording(app: AppHandle, state: MutableState<'_, App>) -> Result<(), String> {
    let mut state = state.write().await;
    let ffmpeg_binary_path_str = ffmpeg_path_as_str().unwrap().to_owned();

    let Some(mut current_recording) = state.clear_current_recording() else {
        return Err("Recording not in progress".to_string());
    };

    current_recording.stop().await;

    std::fs::create_dir_all(current_recording.recording_dir.join("screenshots")).ok();

    dbg!(&current_recording.display.output_path);
    Command::new(ffmpeg_binary_path_str)
        .args(["-ss", "0:00:00", "-i"])
        .arg(&current_recording.display.output_path)
        .args(["-frames:v", "1", "-q:v", "2"])
        .arg(
            current_recording
                .recording_dir
                .join("screenshots/display.jpg"),
        )
        .output()
        .unwrap();

    state.prev_recordings.push(current_recording.recording_dir);

    ShowCapturesPanel.emit(&app);

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn get_rendered_video(
    app: AppHandle,
    video_id: String,
    project: ProjectConfiguration,
) -> Result<PathBuf, String> {
    let video_dir = app
        .path()
        .app_data_dir()
        .unwrap()
        .join("recordings")
        .join(format!("{video_id}.cap"));

    dbg!(&video_dir);
    if video_dir.exists() {
        let output_path = video_dir.join("output/result.mp4");
        dbg!(&output_path);
        if output_path.exists() {
            Ok(output_path)
        } else {
            use recording::recording_meta::*;

            let meta: RecordingMeta = serde_json::from_str(
                &std::fs::read_to_string(video_dir.join("recording-meta.json")).unwrap(),
            )
            .unwrap();

            dbg!(&meta);

            let render_options = RenderOptions {
                output_path: output_path.clone(),
                screen_recording_path: video_dir.join("content/display.mp4"),
                webcam_recording_path: video_dir.join("content/camera.mp4"),
                webcam_size: meta.camera.map(|c| (c.width, c.height)).unwrap_or((0, 0)),
                // webcam_style: WebcamStyle {
                //     border_radius: 10.0,
                //     shadow_color: [0.0, 0.0, 0.0, 0.5],
                //     shadow_blur: 5.0,
                //     shadow_offset: (2.0, 2.0),
                // },
                output_size: (meta.display.width, meta.display.height),
                // background: Background::Color([0.0, 0.0, 0.0, 1.0]),
            };
            render_video(render_options, project).await?;

            Ok(output_path)
        }
    } else {
        Err(format!("Video directory does not exist: {:?}", video_dir))
    }
}

#[tauri::command]
#[specta::specta]
async fn copy_rendered_video_to_clipboard(
    app: AppHandle,
    video_id: String,
    project: ProjectConfiguration,
) -> Result<(), String> {
    println!("Copying to clipboard");

    let output_path = match get_rendered_video(app.clone(), video_id.clone(), project).await {
        Ok(path) => {
            println!("Successfully retrieved rendered video path: {:?}", path);
            path
        }
        Err(e) => {
            println!("Failed to get rendered video: {}", e);
            return Err(format!("Failed to get rendered video: {}", e));
        }
    };

    let output_path_str = output_path.to_str().unwrap();

    #[cfg(target_os = "macos")]
    {
        use cocoa::appkit::NSPasteboard;
        use cocoa::base::{id, nil};
        use cocoa::foundation::{NSArray, NSString, NSURL};
        use objc::rc::autoreleasepool;

        unsafe {
            autoreleasepool(|| {
                let pasteboard: id = NSPasteboard::generalPasteboard(nil);
                NSPasteboard::clearContents(pasteboard);

                let url =
                    NSURL::fileURLWithPath_(nil, NSString::alloc(nil).init_str(output_path_str));

                let objects: id = NSArray::arrayWithObject(nil, url);

                NSPasteboard::writeObjects(pasteboard, objects);
            });
        }
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn get_screen_video_metadata(
    app: AppHandle,
    video_id: String,
    state: MutableState<'_, App>,
) -> Result<(f64, f64), String> {
    let screen_video_path = {
        println!("Getting screen video metadata");

        let recordings_dir = app
            .path()
            .app_data_dir()
            .unwrap()
            .join("recordings")
            .join(format!("{video_id}.cap"));
        let screen_video_path = recordings_dir.join("content/display.mp4");

        println!("Screen video path: {:?}", screen_video_path);

        if !screen_video_path.exists() {
            return Err(format!(
                "Screen video does not exist: {:?}",
                screen_video_path
            ));
        }

        screen_video_path
    };

    let file = File::open(&screen_video_path).map_err(|e| {
        println!("Failed to open video file: {}", e);
        format!("Failed to open video file: {}", e)
    })?;

    println!("File opened successfully: {:?}", file);

    let size = (file
        .metadata()
        .map_err(|e| {
            println!("Failed to get file metadata: {}", e);
            format!("Failed to get file metadata: {}", e)
        })?
        .len() as f64)
        / (1024.0 * 1024.0);

    println!("File size: {} MB", size);

    let reader = BufReader::new(file);
    let file_size = screen_video_path
        .metadata()
        .map_err(|e| {
            println!("Failed to get file metadata: {}", e);
            format!("Failed to get file metadata: {}", e)
        })?
        .len();

    println!("File size in bytes: {}", file_size);

    let mp4 = Mp4Reader::read_header(reader, file_size).map_err(|e| {
        println!("Failed to read MP4 header: {}", e);
        format!("Failed to read MP4 header: {}", e)
    })?;

    println!("MP4 header read successfully: {:?}", mp4);

    let duration = mp4.duration().as_secs_f64();

    println!("Video duration: {} seconds", duration);
    println!("Video size: {} MB", size);

    Ok((duration, size))
}

struct FakeWindowBounds(pub Arc<RwLock<HashMap<String, HashMap<String, Bounds>>>>);

#[tauri::command]
#[specta::specta]
async fn set_fake_window_bounds(
    window: tauri::Window,
    name: String,
    bounds: Bounds,
    state: tauri::State<'_, FakeWindowBounds>,
) -> Result<(), String> {
    let mut state = state.0.write().await;
    let map = state.entry(window.label().to_string()).or_default();

    map.insert(name, bounds);

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn remove_fake_window(
    window: tauri::Window,
    name: String,
    state: tauri::State<'_, FakeWindowBounds>,
) -> Result<(), String> {
    let mut state = state.0.write().await;
    let Some(map) = state.get_mut(window.label()) else {
        return Ok(());
    };

    map.remove(&name);

    if map.is_empty() {
        state.remove(window.label());
    }

    Ok(())
}

const PREV_RECORDINGS_WINDOW: &str = "prev-recordings";

#[tauri::command]
#[specta::specta]
fn show_previous_recordings_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window(PREV_RECORDINGS_WINDOW) {
        window.show().ok();
        return;
    }
    // if let Ok(panel) = app.get_webview_panel(PREV_RECORDINGS_WINDOW) {
    //     panel.show();
    //     return;
    // };

    let monitor = app.primary_monitor().unwrap().unwrap();

    let window = WebviewWindow::builder(
        &app,
        PREV_RECORDINGS_WINDOW,
        tauri::WebviewUrl::App("/prev-recordings".into()),
    )
    .title("Cap Recordings")
    .maximized(false)
    .resizable(false)
    .fullscreen(false)
    .decorations(false)
    .shadow(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .content_protected(true)
    .inner_size(
        (monitor.size().width as f64) / monitor.scale_factor(),
        (monitor.size().height as f64) / monitor.scale_factor(),
    )
    .position(0.0, 0.0)
    .build()
    .unwrap();

    use tauri_nspanel::cocoa::appkit::NSWindowCollectionBehavior;
    use tauri_nspanel::WebviewWindowExt as NSPanelWebviewWindowExt;
    use tauri_plugin_decorum::WebviewWindowExt;

    window.make_transparent().ok();
    let panel = window.to_panel().unwrap();

    panel.set_level(NSMainMenuWindowLevel + 1);

    panel.set_collection_behaviour(
        NSWindowCollectionBehavior::NSWindowCollectionBehaviorTransient
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorMoveToActiveSpace
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle,
    );

    // seems like this doesn't work properly -_-
    #[allow(non_upper_case_globals)]
    const NSWindowStyleMaskNonActivatingPanel: i32 = 1 << 7;
    panel.set_style_mask(NSWindowStyleMaskNonActivatingPanel);

    tokio::spawn(async move {
        let state = app.state::<FakeWindowBounds>();

        loop {
            sleep(Duration::from_millis(1000 / 60)).await;

            let map = state.0.read().await;
            let Some(windows) = map.get("prev-recordings") else {
                window.set_ignore_cursor_events(true).ok();
                continue;
            };

            let window_position = window.outer_position().unwrap();
            let mouse_position = window.cursor_position().unwrap();
            let scale_factor = window.scale_factor().unwrap();

            let mut ignore = true;

            for (_, bounds) in windows {
                let x_min = (window_position.x as f64) + bounds.x * scale_factor;
                let x_max = (window_position.x as f64) + (bounds.x + bounds.width) * scale_factor;
                let y_min = (window_position.y as f64) + bounds.y * scale_factor;
                let y_max = (window_position.y as f64) + (bounds.y + bounds.height) * scale_factor;

                if mouse_position.x >= x_min
                    && mouse_position.x <= x_max
                    && mouse_position.y >= y_min
                    && mouse_position.y <= y_max
                {
                    ignore = false;
                    ShowCapturesPanel.emit(&app).ok();
                    break;
                }
            }

            window.set_ignore_cursor_events(ignore).ok();
        }
    });
}

fn handle_ffmpeg_installation() -> Result<(), String> {
    if ffmpeg_is_installed() {
        println!("FFmpeg is already installed! 🎉");
        return Ok(());
    }

    println!("FFmpeg not found. Attempting to install...");
    match check_latest_version() {
        Ok(version) => println!("Latest available version: {}", version),
        Err(e) => println!("Skipping version check due to error: {e}"),
    }

    let download_url = ffmpeg_download_url().map_err(|e| e.to_string())?;
    let destination = sidecar_dir().map_err(|e| e.to_string())?;

    println!("Downloading from: {:?}", download_url);
    let archive_path =
        download_ffmpeg_package(download_url, &destination).map_err(|e| e.to_string())?;
    println!("Downloaded package: {:?}", archive_path);

    println!("Extracting...");
    unpack_ffmpeg(&archive_path, &destination).map_err(|e| e.to_string())?;

    let version = ffmpeg_version().map_err(|e| e.to_string())?;

    println!("Done! Installed FFmpeg version {} 🏁", version);
    Ok(())
}

fn on_recording_options_change(app: &AppHandle, options: &RecordingOptions) {
    match app.get_webview_window(camera::WINDOW_LABEL) {
        Some(window) if options.camera_label.is_none() => {
            window.close().ok();
        }
        None if options.camera_label.is_some() => {
            create_camera_window(app.clone());
        }
        _ => {}
    }

    RecordingOptionsChanged.emit(app).ok();
}

#[tauri::command]
#[specta::specta]
fn focus_captures_panel(app: AppHandle) {
    let panel = app.get_webview_panel(PREV_RECORDINGS_WINDOW).unwrap();
    panel.make_key_window();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let specta_builder = tauri_specta::Builder::new()
        .commands(tauri_specta::collect_commands![
            get_recording_options,
            set_recording_options,
            create_camera_window,
            start_recording,
            stop_recording,
            get_cameras,
            get_capture_windows,
            get_prev_recordings,
            show_previous_recordings_window,
            set_fake_window_bounds,
            remove_fake_window,
            focus_captures_panel,
            get_current_recording,
            render_video,
            get_rendered_video,
            copy_rendered_video_to_clipboard,
            get_screen_video_metadata
        ])
        .events(tauri_specta::collect_events![
            RecordingOptionsChanged,
            ShowCapturesPanel
        ])
        .ty::<ProjectConfiguration>();

    #[cfg(debug_assertions)] // <- Only export on non-release builds
    specta_builder
        .export(
            specta_typescript::Typescript::default(),
            "../src/utils/tauri.ts",
        )
        .expect("Failed to export typescript bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_nspanel::init())
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            specta_builder.mount_events(app);

            if let Err(_error) = handle_ffmpeg_installation() {
                println!("Failed to install FFmpeg, which is required for Cap to function. Shutting down now");
                // TODO: UI message instead
                panic!("Failed to install FFmpeg, which is required for Cap to function. Shutting down now")
            };

            app.manage(Arc::new(RwLock::new(App {
                handle: app.handle().clone(),
                start_recording_options: RecordingOptions {
                    capture_target: CaptureTarget::Screen,
                    camera_label: None,
                },
                current_recording: None,
                prev_recordings: std::fs::read_dir(
                    app.path().app_data_dir().unwrap().join("recordings"),
                )
                .map(|d| d.into_iter().collect::<Vec<_>>())
                .unwrap_or_default()
                .into_iter()
                .filter_map(|entry| {
                    let path = entry.unwrap().path();
                    if path.extension()? == "cap" {
                        Some(path)
                    } else {
                        None
                    }
                })
                .collect(),
            })));

            app.manage(FakeWindowBounds(Arc::new(RwLock::new(HashMap::new()))));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
