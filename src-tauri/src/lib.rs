use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::PathBuf,
    process::Command,
    sync::Mutex,
    thread,
};
use tauri::{ipc::Channel, Manager, State};
use uuid::Uuid;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum WindowKind {
    #[default]
    Agent,
    Terminal,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredWindow {
    id: String,
    session_name: String,
    name: String,
    cwd: String,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    kind: WindowKind,
    created_at: String,
}

fn default_command() -> String {
    "codex".into()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    name: String,
    cwd: String,
    #[serde(default = "default_command")]
    default_command: String,
    created_at: String,
    #[serde(default, alias = "agents")]
    windows: Vec<StoredWindow>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoreData {
    #[serde(default = "store_version")]
    version: u32,
    #[serde(default)]
    projects: Vec<Project>,
}

fn store_version() -> u32 {
    3
}

struct Store {
    path: PathBuf,
    data: StoreData,
}

impl Store {
    fn load(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let source = if path.exists() {
            Some(path.clone())
        } else {
            let legacy = PathBuf::from(".data/agents.json");
            legacy.exists().then_some(legacy)
        };
        let mut data = if let Some(source) = source {
            migrate_store(&fs::read_to_string(source).map_err(|error| error.to_string())?)?
        } else {
            StoreData {
                version: store_version(),
                projects: Vec::new(),
            }
        };
        data.version = store_version();
        let store = Self { path, data };
        store.save()?;
        Ok(store)
    }

    fn save(&self) -> Result<(), String> {
        let temporary = self.path.with_extension("json.tmp");
        let contents =
            serde_json::to_string_pretty(&self.data).map_err(|error| error.to_string())?;
        fs::write(&temporary, format!("{contents}\n")).map_err(|error| error.to_string())?;
        fs::rename(temporary, &self.path).map_err(|error| error.to_string())
    }

    fn find_window(&self, id: &str) -> Option<&StoredWindow> {
        self.data
            .projects
            .iter()
            .flat_map(|project| &project.windows)
            .find(|window| window.id == id)
    }
}

fn migrate_store(raw: &str) -> Result<StoreData, String> {
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    if value.get("projects").is_some() {
        return serde_json::from_value(value).map_err(|error| error.to_string());
    }
    let windows: Vec<StoredWindow> = serde_json::from_value(
        value
            .get("agents")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    )
    .map_err(|error| error.to_string())?;
    let projects = if windows.is_empty() {
        Vec::new()
    } else {
        vec![Project {
            id: short_id(),
            name: "Imported agents".into(),
            cwd: windows[0].cwd.clone(),
            default_command: default_command(),
            created_at: timestamp(),
            windows,
        }]
    };
    Ok(StoreData {
        version: store_version(),
        projects,
    })
}

struct PtyConnection {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

struct RuntimeState {
    store: Mutex<Store>,
    connections: Mutex<HashMap<String, PtyConnection>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectInput {
    name: String,
    cwd: String,
    default_command: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowInput {
    name: String,
    cwd: String,
    command: Option<String>,
    kind: WindowKind,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowView {
    id: String,
    session_name: String,
    name: String,
    cwd: String,
    command: Option<String>,
    kind: WindowKind,
    created_at: String,
    state: String,
    current_command: Option<String>,
    last_activity_at: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectView {
    id: String,
    name: String,
    cwd: String,
    default_command: String,
    created_at: String,
    windows: Vec<WindowView>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
enum TerminalEvent {
    Output { id: String, data: String },
    Exit { id: String },
}

fn short_id() -> String {
    Uuid::new_v4().simple().to_string()[..10].to_owned()
}

fn timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

fn validate_directory(value: &str) -> Result<String, String> {
    let expanded = if value == "~" {
        dirs::home_dir().unwrap_or_default()
    } else if let Some(rest) = value.strip_prefix("~/") {
        dirs::home_dir().unwrap_or_default().join(rest)
    } else {
        PathBuf::from(value)
    };
    if !expanded.is_dir() {
        return Err(format!("Directory does not exist: {}", expanded.display()));
    }
    Ok(expanded
        .canonicalize()
        .unwrap_or(expanded)
        .to_string_lossy()
        .into_owned())
}

fn session_exists(session_name: &str) -> bool {
    Command::new("tmux")
        .args(["has-session", "-t", session_name])
        .output()
        .is_ok_and(|output| output.status.success())
}

fn kill_session(session_name: &str) {
    let _ = Command::new("tmux")
        .args(["kill-session", "-t", session_name])
        .output();
}

fn start_session(window: &StoredWindow) -> Result<(), String> {
    if session_exists(&window.session_name) {
        return Ok(());
    }
    let status = Command::new("tmux")
        .args([
            "new-session",
            "-d",
            "-s",
            &window.session_name,
            "-c",
            &window.cwd,
        ])
        .status()
        .map_err(|error| error.to_string())?;
    if !status.success() {
        return Err("tmux could not create the terminal session.".into());
    }

    let target = format!("{}:0.0", window.session_name);
    let _ = Command::new("tmux")
        .args([
            "rename-window",
            "-t",
            &format!("{}:0", window.session_name),
            &window.name,
        ])
        .status();
    let _ = Command::new("tmux")
        .args([
            "set-option",
            "-t",
            &window.session_name,
            "@agent-grid-id",
            &window.id,
        ])
        .status();
    if matches!(window.kind, WindowKind::Agent) {
        if let Some(command) = window
            .command
            .as_ref()
            .filter(|command| !command.trim().is_empty())
        {
            let typed = Command::new("tmux")
                .args(["send-keys", "-t", &target, "-l", command])
                .status();
            let entered = Command::new("tmux")
                .args(["send-keys", "-t", &target, "Enter"])
                .status();
            if !typed.is_ok_and(|status| status.success())
                || !entered.is_ok_and(|status| status.success())
            {
                kill_session(&window.session_name);
                return Err("tmux could not start the agent command.".into());
            }
        }
    }
    Ok(())
}

fn window_runtime_info(window: &StoredWindow) -> (Option<String>, Option<u64>) {
    let output = Command::new("tmux")
        .args([
            "list-panes",
            "-t",
            &format!("{}:0", window.session_name),
            "-F",
            "#{pane_current_command}\t#{window_activity}",
        ])
        .output();
    let Ok(output) = output else {
        return (None, None);
    };
    let Ok(value) = String::from_utf8(output.stdout) else {
        return (None, None);
    };
    let (command, activity) = value.trim().split_once('\t').unwrap_or((value.trim(), ""));
    let command = (!command.is_empty()).then(|| command.to_owned());
    let activity = activity
        .parse::<u64>()
        .ok()
        .and_then(|seconds| seconds.checked_mul(1000));
    (command, activity)
}

fn window_view(window: &StoredWindow) -> WindowView {
    let running = session_exists(&window.session_name);
    let (current_command, last_activity_at) = if running {
        window_runtime_info(window)
    } else {
        (None, None)
    };
    WindowView {
        id: window.id.clone(),
        session_name: window.session_name.clone(),
        name: window.name.clone(),
        cwd: window.cwd.clone(),
        command: window.command.clone(),
        kind: window.kind.clone(),
        created_at: window.created_at.clone(),
        state: if running { "running" } else { "stopped" }.into(),
        current_command,
        last_activity_at,
    }
}

fn stop_connection(id: &str, state: &RuntimeState) {
    if let Some(mut connection) = state.connections.lock().unwrap().remove(id) {
        let _ = connection.child.kill();
    }
}

#[tauri::command]
fn get_config() -> serde_json::Value {
    let default_cwd = dirs::home_dir().unwrap_or_default().join("projects");
    serde_json::json!({ "defaultCwd": default_cwd, "defaultCommand": "codex" })
}

#[tauri::command]
fn get_projects(state: State<'_, RuntimeState>) -> Result<Vec<ProjectView>, String> {
    let store = state.store.lock().map_err(|error| error.to_string())?;
    Ok(store
        .data
        .projects
        .iter()
        .map(|project| ProjectView {
            id: project.id.clone(),
            name: project.name.clone(),
            cwd: project.cwd.clone(),
            default_command: project.default_command.clone(),
            created_at: project.created_at.clone(),
            windows: project.windows.iter().map(window_view).collect(),
        })
        .collect())
}

#[tauri::command]
fn create_project(input: ProjectInput, state: State<'_, RuntimeState>) -> Result<Project, String> {
    let name = input.name.trim();
    let default_command = input.default_command.trim();
    if name.is_empty() {
        return Err("Project name is required.".into());
    }
    if default_command.is_empty() {
        return Err("Default agent command is required.".into());
    }
    let project = Project {
        id: short_id(),
        name: name.chars().take(60).collect(),
        cwd: validate_directory(&input.cwd)?,
        default_command: default_command.into(),
        created_at: timestamp(),
        windows: Vec::new(),
    };
    let mut store = state.store.lock().map_err(|error| error.to_string())?;
    store.data.projects.push(project.clone());
    store.save()?;
    Ok(project)
}

#[tauri::command]
fn delete_project(id: String, state: State<'_, RuntimeState>) -> Result<(), String> {
    let mut store = state.store.lock().map_err(|error| error.to_string())?;
    let project = store
        .data
        .projects
        .iter()
        .find(|project| project.id == id)
        .cloned()
        .ok_or("Project not found.")?;
    for window in &project.windows {
        stop_connection(&window.id, &state);
        kill_session(&window.session_name);
    }
    store.data.projects.retain(|project| project.id != id);
    store.save()
}

#[tauri::command]
fn create_window(
    project_id: String,
    input: WindowInput,
    state: State<'_, RuntimeState>,
) -> Result<WindowView, String> {
    {
        let store = state.store.lock().map_err(|error| error.to_string())?;
        if !store
            .data
            .projects
            .iter()
            .any(|project| project.id == project_id)
        {
            return Err("Project not found.".into());
        }
    }
    let name = input.name.trim();
    if name.is_empty() {
        return Err("Window name is required.".into());
    }
    if matches!(input.kind, WindowKind::Agent)
        && input
            .command
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
    {
        return Err("Agent command is required.".into());
    }
    let id = short_id();
    let window = StoredWindow {
        session_name: format!("agent-grid-{id}"),
        id,
        name: name.chars().take(60).collect(),
        cwd: validate_directory(&input.cwd)?,
        command: input
            .command
            .map(|command| command.trim().to_owned())
            .filter(|command| !command.is_empty()),
        kind: input.kind,
        created_at: timestamp(),
    };
    start_session(&window)?;
    let mut store = state.store.lock().map_err(|error| error.to_string())?;
    let project = store
        .data
        .projects
        .iter_mut()
        .find(|project| project.id == project_id)
        .ok_or("Project not found.")?;
    project.windows.push(window.clone());
    if let Err(error) = store.save() {
        kill_session(&window.session_name);
        return Err(error);
    }
    Ok(window_view(&window))
}

#[tauri::command]
fn delete_window(id: String, state: State<'_, RuntimeState>) -> Result<(), String> {
    let mut store = state.store.lock().map_err(|error| error.to_string())?;
    let window = store.find_window(&id).cloned().ok_or("Window not found.")?;
    stop_connection(&id, &state);
    kill_session(&window.session_name);
    for project in &mut store.data.projects {
        project.windows.retain(|window| window.id != id);
    }
    store.save()
}

#[tauri::command]
fn restart_window(id: String, state: State<'_, RuntimeState>) -> Result<(), String> {
    let store = state.store.lock().map_err(|error| error.to_string())?;
    let window = store.find_window(&id).cloned().ok_or("Window not found.")?;
    drop(store);
    stop_connection(&id, &state);
    kill_session(&window.session_name);
    start_session(&window)
}

#[tauri::command]
fn attach_terminal(
    id: String,
    cols: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    let store = state.store.lock().map_err(|error| error.to_string())?;
    let window = store.find_window(&id).cloned().ok_or("Window not found.")?;
    drop(store);
    if !session_exists(&window.session_name) {
        return Err("tmux session is not running.".into());
    }
    stop_connection(&id, &state);

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.clamp(5, 200),
            cols: cols.clamp(20, 400),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    let mut command = CommandBuilder::new("tmux");
    command.args(["attach-session", "-t", &window.session_name]);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    drop(pair.slave);
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| error.to_string())?;

    let event_id = id.clone();
    thread::spawn(move || {
        let mut buffer = vec![0_u8; 16 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let data = String::from_utf8_lossy(&buffer[..count]).into_owned();
                    if on_event
                        .send(TerminalEvent::Output {
                            id: event_id.clone(),
                            data,
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        let _ = on_event.send(TerminalEvent::Exit { id: event_id });
    });

    state
        .connections
        .lock()
        .map_err(|error| error.to_string())?
        .insert(
            id,
            PtyConnection {
                master: pair.master,
                writer,
                child,
            },
        );
    Ok(())
}

#[tauri::command]
fn write_terminal(id: String, data: String, state: State<'_, RuntimeState>) -> Result<(), String> {
    let mut connections = state
        .connections
        .lock()
        .map_err(|error| error.to_string())?;
    let connection = connections
        .get_mut(&id)
        .ok_or("Terminal is not attached.")?;
    connection
        .writer
        .write_all(data.as_bytes())
        .map_err(|error| error.to_string())?;
    connection.writer.flush().map_err(|error| error.to_string())
}

#[tauri::command]
fn resize_terminal(
    id: String,
    cols: u16,
    rows: u16,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    let connections = state
        .connections
        .lock()
        .map_err(|error| error.to_string())?;
    let connection = connections.get(&id).ok_or("Terminal is not attached.")?;
    connection
        .master
        .resize(PtySize {
            rows: rows.clamp(5, 200),
            cols: cols.clamp(20, 400),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn detach_terminal(id: String, state: State<'_, RuntimeState>) {
    stop_connection(&id, &state);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let path = app.path().app_data_dir()?.join("state.json");
            let store = Store::load(path).map_err(std::io::Error::other)?;
            app.manage(RuntimeState {
                store: Mutex::new(store),
                connections: Mutex::new(HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            get_projects,
            create_project,
            delete_project,
            create_window,
            delete_window,
            restart_window,
            attach_terminal,
            write_terminal,
            resize_terminal,
            detach_terminal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tmux Agent Grid");
}

#[cfg(test)]
mod tests {
    use super::*;

    struct SessionGuard(String);

    impl Drop for SessionGuard {
        fn drop(&mut self) {
            kill_session(&self.0);
        }
    }

    #[test]
    fn migrates_empty_flat_store() {
        let migrated = migrate_store(r#"{"agents":[]}"#).unwrap();
        assert_eq!(migrated.version, 3);
        assert!(migrated.projects.is_empty());
    }

    #[test]
    fn validates_home_directory() {
        assert!(validate_directory("~").is_ok());
    }

    #[test]
    fn starts_normal_terminal_and_agent_sessions() {
        let terminal_id = short_id();
        let terminal = StoredWindow {
            id: terminal_id.clone(),
            session_name: format!("agent-grid-{terminal_id}"),
            name: "Test terminal".into(),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            command: None,
            kind: WindowKind::Terminal,
            created_at: timestamp(),
        };
        let _terminal_guard = SessionGuard(terminal.session_name.clone());
        start_session(&terminal).unwrap();
        assert!(session_exists(&terminal.session_name));

        let agent_id = short_id();
        let agent = StoredWindow {
            id: agent_id.clone(),
            session_name: format!("agent-grid-{agent_id}"),
            name: "Test agent".into(),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            command: Some("printf tauri-agent-ready".into()),
            kind: WindowKind::Agent,
            created_at: timestamp(),
        };
        let _agent_guard = SessionGuard(agent.session_name.clone());
        start_session(&agent).unwrap();
        thread::sleep(std::time::Duration::from_millis(250));
        let output = Command::new("tmux")
            .args([
                "capture-pane",
                "-p",
                "-t",
                &format!("{}:0.0", agent.session_name),
            ])
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&output.stdout).contains("tauri-agent-ready"));
    }
}
