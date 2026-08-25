use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{Read, Seek, SeekFrom, Write},
    net::{Ipv4Addr, Ipv6Addr},
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{ipc::Channel, Emitter, Manager, State};
use uuid::Uuid;

const TIMELINE_MAX_EVENTS: usize = 500;
const TIMELINE_MAX_AGE_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const INTERACTION_RUNNING_TTL_MS: u64 = 10_000;
const GIT_GRAPH_LIMIT: usize = 500;
const REPOSITORY_ENTRY_LIMIT: usize = 5_000;
const REPOSITORY_FILE_LIMIT: u64 = 1024 * 1024;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum WindowKind {
    #[default]
    Agent,
    Terminal,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortView {
    port: u16,
    address: String,
    url: String,
    pid: u32,
    process: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TimelineEvent {
    id: String,
    at: u64,
    kind: String,
    summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    port: Option<PortView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    updated_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    terminal_line: Option<u32>,
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
    #[serde(default)]
    timeline: Vec<TimelineEvent>,
}

fn default_command() -> String {
    "omp".into()
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
    5
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
        let mut data: StoreData =
            serde_json::from_value(value).map_err(|error| error.to_string())?;
        for project in &mut data.projects {
            if project.default_command == "codex" {
                project.default_command = default_command();
            }
        }
        return Ok(data);
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
    history_modes: Mutex<HashSet<String>>,
    snapshots: Mutex<HashMap<String, RuntimeSnapshot>>,
    omp_states: Mutex<HashMap<PathBuf, (u64, Option<String>)>>,
    compact_window: Mutex<Option<(i32, i32, u32, u32)>>,
    app_data_dir: PathBuf,
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
    activity_state: String,
    ports: Vec<PortView>,
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStatusView {
    available: bool,
    branch: Option<String>,
    head: String,
    branches: Vec<String>,
    dirty: bool,
    ahead: u32,
    behind: u32,
    has_upstream: bool,
    upstream: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitGraphCommitView {
    hash: String,
    short_hash: String,
    parents: Vec<String>,
    refs: Vec<String>,
    author: String,
    date: String,
    subject: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitGraphView {
    commits: Vec<GitGraphCommitView>,
    truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitChangedFileView {
    status: String,
    path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCommitDetailView {
    hash: String,
    short_hash: String,
    parents: Vec<String>,
    refs: Vec<String>,
    author: String,
    date: String,
    subject: String,
    body: String,
    stats: String,
    files: Vec<GitChangedFileView>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryEntry {
    path: String,
    name: String,
    is_directory: bool,
    depth: u16,
    documentation: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryView {
    entries: Vec<RepositoryEntry>,
    truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryFileView {
    path: String,
    content: String,
    size: u64,
    documentation: bool,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
enum TerminalEvent {
    Output { id: String, data: String },
    Exit { id: String },
}

#[derive(Clone, Debug, Default)]
struct RuntimeSnapshot {
    running: bool,
    pane_pid: Option<u32>,
    current_command: Option<String>,
    last_activity_at: Option<u64>,
    activity_state: String,
    ports: Vec<PortView>,
    agent_busy: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HandoffView {
    id: String,
    path: String,
    copy_text: String,
    can_fork: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HandoffForkView {
    window: WindowView,
    exact_fork: bool,
}

fn short_id() -> String {
    Uuid::new_v4().simple().to_string()[..10].to_owned()
}

fn timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn prune_timeline(events: &mut Vec<TimelineEvent>, current_time: u64) {
    let oldest = current_time.saturating_sub(TIMELINE_MAX_AGE_MS);
    events.retain(|event| event.at >= oldest);
    if events.len() > TIMELINE_MAX_EVENTS {
        events.drain(..events.len() - TIMELINE_MAX_EVENTS);
    }
}

fn append_timeline_event(
    window: &mut StoredWindow,
    kind: &str,
    summary: impl Into<String>,
    port: Option<PortView>,
) {
    let at = now_ms();
    let summary: String = summary.into();
    window.timeline.push(TimelineEvent {
        id: short_id(),
        at,
        kind: kind.into(),
        summary: summary.chars().take(4_096).collect(),
        port,
        updated_at: None,
        status: None,
        terminal_line: None,
    });
    prune_timeline(&mut window.timeline, at);
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

fn ignored_repository_directory(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".cache"
            | ".next"
            | ".nuxt"
            | "build"
            | "coverage"
            | "dist"
            | "node_modules"
            | "target"
    )
}

fn documentation_path(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(extension.as_str(), "md" | "mdx" | "rst" | "adoc")
        || name.starts_with("readme")
        || name.starts_with("changelog")
        || name.starts_with("contributing")
        || matches!(name.as_str(), "license" | "authors" | "agents" | "claude")
}

fn collect_repository_entries(
    directory: &Path,
    relative_directory: &Path,
    depth: u16,
    entries: &mut Vec<RepositoryEntry>,
    truncated: &mut bool,
) -> Result<(), String> {
    let mut children = fs::read_dir(directory)
        .map_err(|error| format!("Could not read {}: {error}", directory.display()))?
        .map(|entry| {
            let entry = entry.map_err(|error| error.to_string())?;
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            Ok((entry, file_type))
        })
        .collect::<Result<Vec<_>, String>>()?;
    children.sort_by(|(left, left_type), (right, right_type)| {
        (
            !left_type.is_dir(),
            left.file_name().to_string_lossy().to_ascii_lowercase(),
        )
            .cmp(&(
                !right_type.is_dir(),
                right.file_name().to_string_lossy().to_ascii_lowercase(),
            ))
    });

    for (entry, file_type) in children {
        if entries.len() >= REPOSITORY_ENTRY_LIMIT {
            *truncated = true;
            return Ok(());
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if file_type.is_dir() && ignored_repository_directory(&name) {
            continue;
        }
        let relative = relative_directory.join(&name);
        let path = relative.to_string_lossy().replace('\\', "/");
        let is_directory = file_type.is_dir();
        entries.push(RepositoryEntry {
            path,
            name,
            is_directory,
            depth,
            documentation: !is_directory && documentation_path(&relative),
        });
        if is_directory {
            collect_repository_entries(
                &entry.path(),
                &relative,
                depth.saturating_add(1),
                entries,
                truncated,
            )?;
            if *truncated {
                return Ok(());
            }
        }
    }
    Ok(())
}

fn canonical_repository_root(root: &Path) -> Result<PathBuf, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("Could not open repository: {error}"))?;
    if !root.is_dir() {
        return Err("Project directory is not available.".into());
    }
    Ok(root)
}

fn list_repository_path(root: &Path) -> Result<RepositoryView, String> {
    let root = canonical_repository_root(root)?;
    let mut entries = Vec::new();
    let mut truncated = false;
    collect_repository_entries(&root, Path::new(""), 0, &mut entries, &mut truncated)?;
    Ok(RepositoryView { entries, truncated })
}

fn resolve_repository_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    if relative_path.as_os_str().is_empty()
        || relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("Invalid repository path.".into());
    }
    let root = canonical_repository_root(root)?;
    let target = root
        .join(relative_path)
        .canonicalize()
        .map_err(|error| format!("Could not open file: {error}"))?;
    if !target.starts_with(&root) || !target.is_file() {
        return Err("File is outside the project or is not available.".into());
    }
    Ok(target)
}

fn read_repository_path(root: &Path, relative: &str) -> Result<RepositoryFileView, String> {
    let target = resolve_repository_file(root, relative)?;
    let size = target
        .metadata()
        .map_err(|error| format!("Could not inspect file: {error}"))?
        .len();
    if size > REPOSITORY_FILE_LIMIT {
        return Err(format!(
            "File is larger than the {} MiB preview limit.",
            REPOSITORY_FILE_LIMIT / (1024 * 1024)
        ));
    }
    let bytes = fs::read(&target).map_err(|error| format!("Could not read file: {error}"))?;
    if bytes.contains(&0) {
        return Err("Binary files cannot be previewed.".into());
    }
    let content =
        String::from_utf8(bytes).map_err(|_| "File is not valid UTF-8 and cannot be previewed.")?;
    Ok(RepositoryFileView {
        path: relative.replace('\\', "/"),
        content,
        size,
        documentation: documentation_path(Path::new(relative)),
    })
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

fn configure_session(session_name: &str) -> Result<(), String> {
    let mouse = Command::new("tmux")
        // xterm owns drag selection. Wheel events enter tmux copy mode through
        // an explicit command, so tmux mouse reporting must remain disabled.
        .args(["set-option", "-t", session_name, "mouse", "off"])
        .status()
        .map_err(|error| error.to_string())?;
    let history = Command::new("tmux")
        .args([
            "set-option",
            "-w",
            "-t",
            &format!("{session_name}:0"),
            "history-limit",
            "5000",
        ])
        .status()
        .map_err(|error| error.to_string())?;
    if mouse.success() && history.success() {
        Ok(())
    } else {
        Err("tmux could not configure mouse handling for the terminal session.".into())
    }
}

fn start_session(window: &StoredWindow) -> Result<(), String> {
    if session_exists(&window.session_name) {
        return configure_session(&window.session_name);
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
    if let Err(error) = configure_session(&window.session_name) {
        kill_session(&window.session_name);
        return Err(error);
    }
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

fn shell_command(command: Option<&str>) -> bool {
    matches!(
        command.unwrap_or_default().to_ascii_lowercase().as_str(),
        "" | "bash" | "dash" | "elvish" | "fish" | "nu" | "pwsh" | "sh" | "tcsh" | "zsh"
    )
}

fn activity_state(window: &StoredWindow, snapshot: &RuntimeSnapshot) -> String {
    if !snapshot.running {
        return "stopped".into();
    }
    let at_shell = shell_command(snapshot.current_command.as_deref());
    if matches!(window.kind, WindowKind::Terminal) {
        return if at_shell { "ready" } else { "running" }.into();
    }
    if at_shell {
        return "idle".into();
    }
    if let Some(busy) = snapshot.agent_busy {
        return if busy { "running" } else { "waiting" }.into();
    }
    let interaction = window
        .timeline
        .iter()
        .rev()
        .find(|event| event.kind == "interaction");
    let actively_running = interaction.is_some_and(|event| {
        event.status.as_deref() == Some("running")
            && now_ms().saturating_sub(event.updated_at.unwrap_or(event.at))
                < INTERACTION_RUNNING_TTL_MS
    });
    if actively_running {
        "running".into()
    } else {
        "waiting".into()
    }
}

fn codex_command(command: Option<&str>) -> bool {
    command
        .and_then(|value| value.split_whitespace().next())
        .and_then(|value| Path::new(value).file_name())
        .and_then(|value| value.to_str())
        == Some("codex")
}

fn omp_command(command: Option<&str>) -> bool {
    command
        .and_then(|value| value.split_whitespace().next())
        .and_then(|value| Path::new(value).file_name())
        .and_then(|value| value.to_str())
        == Some("omp")
}

fn terminal_breadcrumb_id(terminal: &Path) -> Option<String> {
    let relative = terminal.strip_prefix("/dev").ok()?;
    let encoded = relative
        .to_string_lossy()
        .trim_start_matches('/')
        .replace('/', "-");
    (!encoded.is_empty()).then_some(encoded)
}

fn omp_session_path(root_pid: u32) -> Option<PathBuf> {
    for pid in process_cohort(root_pid) {
        let executable = fs::read_link(format!("/proc/{pid}/exe")).ok();
        let is_omp = executable
            .as_deref()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            == Some("omp");
        if !is_omp {
            continue;
        }

        let Ok(terminal) = fs::read_link(format!("/proc/{pid}/fd/0")) else {
            continue;
        };
        let Some(breadcrumb_id) = terminal_breadcrumb_id(&terminal) else {
            continue;
        };
        let Ok(entries) = fs::read_dir(format!("/proc/{pid}/fd")) else {
            continue;
        };
        let Some(agent_directory) = entries.flatten().find_map(|entry| {
            let target = fs::read_link(entry.path()).ok()?;
            (target.file_name()?.to_str()? == "agent.db")
                .then(|| target.parent().map(Path::to_path_buf))
                .flatten()
        }) else {
            continue;
        };
        let Ok(breadcrumb) = fs::read_to_string(
            agent_directory
                .join("terminal-sessions")
                .join(breadcrumb_id),
        ) else {
            continue;
        };
        let Some(session) = breadcrumb.lines().nth(1).map(str::trim) else {
            continue;
        };
        if !session.is_empty() {
            return Some(PathBuf::from(session));
        }
    }
    None
}

fn omp_turn_state(path: &Path) -> Option<&'static str> {
    const MAX_TAIL_SIZE: u64 = 768 * 1024;

    let mut file = fs::File::open(path).ok()?;
    let end = file.metadata().ok()?.len();
    let start = end.saturating_sub(MAX_TAIL_SIZE);
    let mut buffer = vec![0; (end - start) as usize];
    file.seek(SeekFrom::Start(start)).ok()?;
    file.read_exact(&mut buffer).ok()?;
    let text = String::from_utf8_lossy(&buffer);
    let mut completed_tools = HashSet::new();
    let mut lines = text.rsplit('\n').peekable();

    while let Some(line) = lines.next() {
        if start > 0 && lines.peek().is_none() {
            break;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match entry.get("type").and_then(|value| value.as_str()) {
            Some("message") => {
                let Some(message) = entry.get("message") else {
                    continue;
                };
                match message.get("role").and_then(|value| value.as_str()) {
                    Some("toolResult") => {
                        if let Some(id) = message.get("toolCallId").and_then(|value| value.as_str())
                        {
                            completed_tools.insert(id.to_owned());
                        }
                    }
                    Some("user") => return Some("running"),
                    Some("assistant") => {
                        return match message.get("stopReason").and_then(|value| value.as_str()) {
                            Some("stop") => Some("waiting"),
                            Some("aborted" | "error") => Some("attention"),
                            Some("toolUse") => Some("running"),
                            _ => None,
                        };
                    }
                    _ => {}
                }
            }
            Some("custom") => {
                let custom_type = entry.get("customType").and_then(|value| value.as_str());
                if custom_type == Some("session_exit") {
                    return Some("attention");
                }
                if custom_type != Some("tool_execution_start") {
                    continue;
                }
                let Some(data) = entry.get("data") else {
                    continue;
                };
                let id = data.get("toolCallId").and_then(|value| value.as_str());
                let tool = data.get("toolName").and_then(|value| value.as_str());
                if tool == Some("ask") && id.is_some_and(|value| !completed_tools.contains(value)) {
                    return Some("needs-input");
                }
            }
            _ => {}
        }
    }
    None
}

fn cached_omp_turn_state(
    path: &Path,
    cache: &mut HashMap<PathBuf, (u64, Option<String>)>,
) -> Option<String> {
    let length = fs::metadata(path).ok()?.len();
    if let Some((cached_length, state)) = cache.get(path) {
        if *cached_length == length {
            return state.clone();
        }
    }
    let state = omp_turn_state(path).map(ToOwned::to_owned);
    cache.insert(path.to_path_buf(), (length, state.clone()));
    state
}

fn rollout_paths(root_pid: u32) -> HashSet<PathBuf> {
    let mut paths = HashSet::new();
    for pid in process_tree(root_pid) {
        let Ok(entries) = fs::read_dir(format!("/proc/{pid}/fd")) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(target) = fs::read_link(entry.path()) else {
                continue;
            };
            let is_rollout = target
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"));
            if is_rollout {
                paths.insert(target);
            }
        }
    }
    paths
}

fn last_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .rposition(|window| window == needle)
}

fn rollout_turn_active(path: &Path) -> Option<bool> {
    const CHUNK_SIZE: u64 = 64 * 1024;
    const OVERLAP: u64 = 64;
    const STARTED: &[u8] = br#""type":"task_started""#;
    const COMPLETE: &[u8] = br#""type":"task_complete""#;

    let mut file = fs::File::open(path).ok()?;
    let mut end = file.metadata().ok()?.len();
    while end > 0 {
        let start = end.saturating_sub(CHUNK_SIZE);
        let length = (end - start) as usize;
        let mut buffer = vec![0; length];
        file.seek(SeekFrom::Start(start)).ok()?;
        file.read_exact(&mut buffer).ok()?;
        let started = last_subslice(&buffer, STARTED);
        let complete = last_subslice(&buffer, COMPLETE);
        match (started, complete) {
            (Some(started), Some(complete)) => return Some(started > complete),
            (Some(_), None) => return Some(true),
            (None, Some(_)) => return Some(false),
            (None, None) => {}
        }
        if start == 0 {
            break;
        }
        end = start.saturating_add(OVERLAP);
    }
    None
}

fn codex_turn_active(root_pid: u32) -> Option<bool> {
    let states: Vec<_> = rollout_paths(root_pid)
        .iter()
        .filter_map(|path| rollout_turn_active(path))
        .collect();
    (!states.is_empty()).then(|| states.into_iter().any(|active| active))
}

fn process_tree(root: u32) -> HashSet<u32> {
    let mut found = HashSet::from([root]);
    let mut pending = vec![root];
    while let Some(pid) = pending.pop() {
        let path = format!("/proc/{pid}/task/{pid}/children");
        let Ok(children) = fs::read_to_string(path) else {
            continue;
        };
        for child in children
            .split_whitespace()
            .filter_map(|value| value.parse::<u32>().ok())
        {
            if found.insert(child) {
                pending.push(child);
            }
        }
    }
    found
}

fn process_session_id(pid: u32) -> Option<u32> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_name = stat.rsplit_once(") ")?.1;
    after_name
        .split_whitespace()
        .nth(3)
        .and_then(|value| value.parse().ok())
}

fn process_environment_value(pid: u32, name: &str) -> Option<String> {
    let environment = fs::read(format!("/proc/{pid}/environ")).ok()?;
    environment.split(|byte| *byte == 0).find_map(|entry| {
        let separator = entry.iter().position(|byte| *byte == b'=')?;
        let (key, value) = entry.split_at(separator);
        let value = value.get(1..)?;
        (key == name.as_bytes()).then(|| String::from_utf8_lossy(value).into_owned())
    })
}

fn process_cohort(root: u32) -> HashSet<u32> {
    let mut found = process_tree(root);
    let session_id = process_session_id(root);
    let pane_marker = process_environment_value(root, "TMUX_PANE");
    if session_id.is_none() && pane_marker.is_none() {
        return found;
    }
    let Ok(entries) = fs::read_dir("/proc") else {
        return found;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|value| value.parse::<u32>().ok())
        else {
            continue;
        };
        let same_session = session_id.is_some() && process_session_id(pid) == session_id;
        let same_pane = pane_marker.is_some()
            && process_environment_value(pid, "TMUX_PANE").as_ref() == pane_marker.as_ref();
        if same_session || same_pane {
            found.insert(pid);
        }
    }
    found
}

fn socket_owners(pids: &HashSet<u32>) -> HashMap<u64, u32> {
    let mut owners = HashMap::new();
    for pid in pids {
        let Ok(entries) = fs::read_dir(format!("/proc/{pid}/fd")) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(target) = fs::read_link(entry.path()) else {
                continue;
            };
            let target = target.to_string_lossy();
            let Some(inode) = target
                .strip_prefix("socket:[")
                .and_then(|value| value.strip_suffix(']'))
                .and_then(|value| value.parse::<u64>().ok())
            else {
                continue;
            };
            owners.insert(inode, *pid);
        }
    }
    owners
}

fn decode_ipv4(value: &str) -> Option<Ipv4Addr> {
    let raw = u32::from_str_radix(value, 16).ok()?;
    Some(Ipv4Addr::from(raw.to_le_bytes()))
}

fn decode_ipv6(value: &str) -> Option<Ipv6Addr> {
    if value.len() != 32 {
        return None;
    }
    let mut bytes = [0_u8; 16];
    for (index, chunk) in value.as_bytes().chunks(8).enumerate() {
        let word = u32::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
        bytes[index * 4..index * 4 + 4].copy_from_slice(&word.to_le_bytes());
    }
    Some(Ipv6Addr::from(bytes))
}

fn browser_url(address: &str, port: u16) -> String {
    if address == "0.0.0.0" || address.starts_with("127.") {
        format!("http://127.0.0.1:{port}")
    } else if address == "::" || address == "::1" {
        format!("http://[::1]:{port}")
    } else if address.contains(':') {
        format!("http://[{address}]:{port}")
    } else {
        format!("http://{address}:{port}")
    }
}

fn parse_listening_sockets(
    contents: &str,
    ipv6: bool,
    owners: &HashMap<u64, u32>,
    ports: &mut BTreeMap<(u16, u32), PortView>,
) {
    for line in contents.lines().skip(1) {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() < 10 || fields[3] != "0A" {
            continue;
        }
        let Some((address_hex, port_hex)) = fields[1].split_once(':') else {
            continue;
        };
        let Some(port) = u16::from_str_radix(port_hex, 16).ok() else {
            continue;
        };
        let Some(inode) = fields[9].parse::<u64>().ok() else {
            continue;
        };
        let Some(pid) = owners.get(&inode).copied() else {
            continue;
        };
        let address = if ipv6 {
            decode_ipv6(address_hex).map(|value| value.to_string())
        } else {
            decode_ipv4(address_hex).map(|value| value.to_string())
        };
        let Some(address) = address else {
            continue;
        };
        let process = fs::read_to_string(format!("/proc/{pid}/comm"))
            .unwrap_or_default()
            .trim()
            .to_owned();
        let candidate = PortView {
            port,
            address: address.clone(),
            url: browser_url(&address, port),
            pid,
            process,
        };
        ports
            .entry((port, pid))
            .and_modify(|existing| {
                if existing.address.contains(':') && !candidate.address.contains(':') {
                    *existing = candidate.clone();
                }
            })
            .or_insert(candidate);
    }
}

fn listening_ports(root_pid: u32) -> Vec<PortView> {
    let owners = socket_owners(&process_cohort(root_pid));
    if owners.is_empty() {
        return Vec::new();
    }
    let mut ports = BTreeMap::new();
    if let Ok(contents) = fs::read_to_string("/proc/net/tcp") {
        parse_listening_sockets(&contents, false, &owners, &mut ports);
    }
    if let Ok(contents) = fs::read_to_string("/proc/net/tcp6") {
        parse_listening_sockets(&contents, true, &owners, &mut ports);
    }
    ports.into_values().collect()
}

fn collect_runtime_snapshots(
    windows: &[StoredWindow],
    omp_states: &mut HashMap<PathBuf, (u64, Option<String>)>,
) -> HashMap<String, RuntimeSnapshot> {
    let by_session: HashMap<_, _> = windows
        .iter()
        .map(|window| (window.session_name.as_str(), window))
        .collect();
    let mut snapshots: HashMap<String, RuntimeSnapshot> = windows
        .iter()
        .map(|window| (window.id.clone(), RuntimeSnapshot::default()))
        .collect();
    let output = Command::new("tmux")
        .args([
            "list-panes",
            "-a",
            "-F",
            "#{session_name}\t#{pane_pid}\t#{pane_current_command}\t#{window_activity}",
        ])
        .output();
    let Ok(output) = output else {
        return snapshots;
    };
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.splitn(4, '\t');
        let (Some(session), Some(pid), command, activity) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let Some(window) = by_session.get(session) else {
            continue;
        };
        let pane_pid = pid.parse::<u32>().ok();
        let agent_busy = if codex_command(window.command.as_deref()) {
            pane_pid.and_then(codex_turn_active)
        } else {
            None
        };
        let omp_state = if omp_command(window.command.as_deref()) {
            pane_pid
                .and_then(omp_session_path)
                .and_then(|path| cached_omp_turn_state(&path, omp_states))
        } else {
            None
        };
        let mut snapshot = RuntimeSnapshot {
            running: true,
            pane_pid,
            current_command: command
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned),
            last_activity_at: activity
                .and_then(|value| value.parse::<u64>().ok())
                .and_then(|seconds| seconds.checked_mul(1_000)),
            activity_state: String::new(),
            ports: pane_pid.map(listening_ports).unwrap_or_default(),
            agent_busy,
        };
        snapshot.activity_state = omp_state.unwrap_or_else(|| activity_state(window, &snapshot));
        snapshots.insert(window.id.clone(), snapshot);
    }
    for window in windows {
        if let Some(snapshot) = snapshots.get_mut(&window.id) {
            if snapshot.activity_state.is_empty() {
                snapshot.activity_state = activity_state(window, snapshot);
            }
        }
    }
    snapshots
}

fn window_view(window: &StoredWindow, snapshot: Option<&RuntimeSnapshot>) -> WindowView {
    let fallback = RuntimeSnapshot {
        running: session_exists(&window.session_name),
        activity_state: String::new(),
        ..RuntimeSnapshot::default()
    };
    let snapshot = snapshot.unwrap_or(&fallback);
    let state = if snapshot.running {
        "running"
    } else {
        "stopped"
    };
    let activity_state = if snapshot.activity_state.is_empty() {
        activity_state(window, snapshot)
    } else {
        snapshot.activity_state.clone()
    };
    WindowView {
        id: window.id.clone(),
        session_name: window.session_name.clone(),
        name: window.name.clone(),
        cwd: window.cwd.clone(),
        command: window.command.clone(),
        kind: window.kind.clone(),
        created_at: window.created_at.clone(),
        state: state.into(),
        current_command: snapshot.current_command.clone(),
        last_activity_at: snapshot.last_activity_at,
        activity_state,
        ports: snapshot.ports.clone(),
    }
}

fn strip_control_sequences(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut characters = input.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\u{1b}' {
            match characters.peek().copied() {
                Some('[') => {
                    characters.next();
                    for value in characters.by_ref() {
                        if ('@'..='~').contains(&value) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    characters.next();
                    let mut previous_escape = false;
                    for value in characters.by_ref() {
                        if value == '\u{7}' || (previous_escape && value == '\\') {
                            break;
                        }
                        previous_escape = value == '\u{1b}';
                    }
                }
                _ => {
                    characters.next();
                }
            }
            continue;
        }
        if character == '\n' || character == '\t' || !character.is_control() {
            output.push(character);
        }
    }
    output
}

fn terminal_color_report_prefix_len(input: &str) -> usize {
    let bytes = input.as_bytes();
    let mut cursor = 0;
    loop {
        let report_start = cursor;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        if cursor == report_start || bytes.get(cursor) != Some(&b';') {
            return report_start;
        }
        cursor += 1;
        let parameter_start = cursor;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        if cursor > parameter_start && bytes.get(cursor) == Some(&b';') {
            cursor += 1;
        } else {
            cursor = parameter_start;
        }
        if bytes.get(cursor..cursor + 4) != Some(b"rgb:") {
            return report_start;
        }
        cursor += 4;
        for component in 0..3 {
            let Some(value) = bytes.get(cursor..cursor + 4) else {
                return report_start;
            };
            if !value.iter().all(u8::is_ascii_hexdigit) {
                return report_start;
            }
            cursor += 4;
            if component < 2 {
                if bytes.get(cursor) != Some(&b'/') {
                    return report_start;
                }
                cursor += 1;
            }
        }
    }
}

fn clean_submission_text(input: &str) -> String {
    let cleaned = strip_control_sequences(input);
    let cleaned = cleaned.trim();
    let prefix = terminal_color_report_prefix_len(cleaned);
    cleaned[prefix..].trim().to_owned()
}

fn capture_pane(window: &StoredWindow) -> String {
    let output = Command::new("tmux")
        .args([
            "capture-pane",
            "-p",
            "-S",
            "-200",
            "-t",
            &format!("{}:0.0", window.session_name),
        ])
        .output();
    let Ok(output) = output else {
        return String::new();
    };
    let cleaned = strip_control_sequences(&String::from_utf8_lossy(&output.stdout));
    let mut bytes = cleaned.into_bytes();
    if bytes.len() > 128 * 1024 {
        bytes.drain(..bytes.len() - 128 * 1024);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn git_checked(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|error| format!("Could not run git: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        return Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("git {} failed.", args.join(" "))
        });
    }
    Ok(
        strip_control_sequences(&String::from_utf8_lossy(&output.stdout))
            .trim()
            .to_owned(),
    )
}

fn git_output(cwd: &str, args: &[&str]) -> String {
    git_checked(Path::new(cwd), args).unwrap_or_default()
}

fn git_status_for_path(cwd: &Path) -> Result<GitStatusView, String> {
    let probe = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map_err(|error| format!("Could not run git: {error}"))?;
    if !probe.status.success() {
        return Ok(GitStatusView {
            available: false,
            branch: None,
            head: "Not a Git repository".into(),
            branches: Vec::new(),
            dirty: false,
            ahead: 0,
            behind: 0,
            has_upstream: false,
            upstream: None,
        });
    }

    let branch = git_checked(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .filter(|value| !value.is_empty());
    let head = branch.clone().unwrap_or_else(|| {
        git_checked(cwd, &["rev-parse", "--short", "HEAD"])
            .map(|value| format!("detached@{value}"))
            .unwrap_or_else(|_| "Detached HEAD".into())
    });
    let branches = git_checked(
        cwd,
        &[
            "for-each-ref",
            "--sort=refname",
            "--format=%(refname:short)",
            "refs/heads",
        ],
    )?
    .lines()
    .map(ToOwned::to_owned)
    .collect();
    let dirty =
        !git_checked(cwd, &["status", "--porcelain", "--untracked-files=normal"])?.is_empty();
    let upstream = git_checked(
        cwd,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .ok()
    .filter(|value| !value.is_empty());
    let (ahead, behind) = upstream
        .as_ref()
        .and_then(|_| {
            git_checked(
                cwd,
                &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
            )
            .ok()
        })
        .and_then(|counts| {
            let mut values = counts
                .split_whitespace()
                .filter_map(|value| value.parse().ok());
            Some((values.next()?, values.next()?))
        })
        .unwrap_or((0, 0));
    Ok(GitStatusView {
        available: true,
        branch,
        head,
        branches,
        dirty,
        ahead,
        behind,
        has_upstream: upstream.is_some(),
        upstream,
    })
}

fn switch_git_branch_for_path(cwd: &Path, branch: &str) -> Result<GitStatusView, String> {
    let status = git_status_for_path(cwd)?;
    if !status.available {
        return Err("Project is not a Git repository.".into());
    }
    if !status.branches.iter().any(|candidate| candidate == branch) {
        return Err("Unknown local branch.".into());
    }
    git_checked(cwd, &["switch", "--", branch])?;
    git_status_for_path(cwd)
}

fn pull_git_for_path(cwd: &Path) -> Result<GitStatusView, String> {
    let status = git_status_for_path(cwd)?;
    if !status.available {
        return Err("Project is not a Git repository.".into());
    }
    if !status.has_upstream {
        return Err("Current branch has no upstream branch.".into());
    }
    git_checked(cwd, &["pull", "--ff-only"])?;
    git_status_for_path(cwd)
}

fn push_git_for_path(cwd: &Path) -> Result<GitStatusView, String> {
    let status = git_status_for_path(cwd)?;
    if !status.available {
        return Err("Project is not a Git repository.".into());
    }
    let branch = status
        .branch
        .as_deref()
        .ok_or("Cannot push a detached HEAD.")?;
    if status.has_upstream {
        git_checked(cwd, &["push"])?;
    } else {
        let remotes = git_checked(cwd, &["remote"])?;
        if !remotes.lines().any(|remote| remote == "origin") {
            return Err("Current branch has no upstream and remote 'origin' is missing.".into());
        }
        git_checked(cwd, &["push", "--set-upstream", "origin", branch])?;
    }
    git_status_for_path(cwd)
}

fn git_refs_for_commit(cwd: &Path, hash: &str) -> Result<Vec<String>, String> {
    Ok(git_checked(
        cwd,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "--points-at",
            hash,
        ],
    )?
    .lines()
    .filter(|reference| !reference.is_empty())
    .map(ToOwned::to_owned)
    .collect())
}

fn parse_git_graph_output(output: &str) -> GitGraphView {
    let mut commits = output
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(6, '\t');
            let hash = fields.next()?.to_owned();
            let parents = fields
                .next()?
                .split_whitespace()
                .map(ToOwned::to_owned)
                .collect();
            let refs = fields
                .next()?
                .split(", ")
                .filter(|reference| !reference.is_empty())
                .map(ToOwned::to_owned)
                .collect();
            let author = fields.next()?.to_owned();
            let date = fields.next()?.to_owned();
            let subject = fields.next()?.to_owned();
            Some(GitGraphCommitView {
                short_hash: hash.chars().take(7).collect(),
                hash,
                parents,
                refs,
                author,
                date,
                subject,
            })
        })
        .collect::<Vec<_>>();
    let truncated = commits.len() > GIT_GRAPH_LIMIT;
    if truncated {
        commits.truncate(GIT_GRAPH_LIMIT);
    }
    GitGraphView { commits, truncated }
}

fn git_graph_for_path(cwd: &Path) -> Result<GitGraphView, String> {
    if !git_status_for_path(cwd)?.available {
        return Err("Project is not a Git repository.".into());
    }
    let limit = format!("--max-count={}", GIT_GRAPH_LIMIT + 1);
    let output = git_checked(
        cwd,
        &[
            "log",
            "--all",
            "--topo-order",
            "--decorate=short",
            &limit,
            "--pretty=format:%H%x09%P%x09%D%x09%an%x09%aI%x09%s",
        ],
    )?;
    Ok(parse_git_graph_output(&output))
}

fn git_commit_detail_for_path(cwd: &Path, hash: &str) -> Result<GitCommitDetailView, String> {
    if !(7..=40).contains(&hash.len()) || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid commit hash.".into());
    }
    let metadata = git_checked(cwd, &["show", "-s", "--format=%H%n%P%n%an%n%aI%n%s", hash])?;
    let mut lines = metadata.lines();
    let resolved_hash = lines.next().ok_or("Commit not found.")?.to_owned();
    let parents = lines
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .map(ToOwned::to_owned)
        .collect();
    let author = lines.next().unwrap_or_default().to_owned();
    let date = lines.next().unwrap_or_default().to_owned();
    let subject = lines.next().unwrap_or_default().to_owned();
    let body = git_checked(cwd, &["show", "-s", "--format=%B", &resolved_hash])?;
    let stats = git_checked(cwd, &["show", "--format=", "--shortstat", &resolved_hash])?;
    let files = git_checked(
        cwd,
        &[
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--name-status",
            "-r",
            &resolved_hash,
        ],
    )?
    .lines()
    .filter_map(|line| {
        let fields = line.split('\t').collect::<Vec<_>>();
        Some(GitChangedFileView {
            status: fields.first()?.to_string(),
            path: if fields.len() > 2 {
                format!("{} → {}", fields[1], fields.last()?)
            } else {
                fields.get(1)?.to_string()
            },
        })
    })
    .collect();
    Ok(GitCommitDetailView {
        short_hash: resolved_hash.chars().take(7).collect(),
        refs: git_refs_for_commit(cwd, &resolved_hash)?,
        hash: resolved_hash,
        parents,
        author,
        date,
        subject,
        body,
        stats,
        files,
    })
}

fn codex_session_id(root_pid: Option<u32>) -> Option<String> {
    let root_pid = root_pid?;
    for pid in process_tree(root_pid) {
        let Ok(entries) = fs::read_dir(format!("/proc/{pid}/fd")) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(target) = fs::read_link(entry.path()) else {
                continue;
            };
            let Some(name) = target.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let Some(stem) = name.strip_suffix(".jsonl") else {
                continue;
            };
            if !stem.starts_with("rollout-") || stem.len() < 36 {
                continue;
            }
            let candidate = &stem[stem.len() - 36..];
            if Uuid::parse_str(candidate).is_ok() {
                return Some(candidate.to_owned());
            }
        }
    }
    None
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn cleanup_handoffs(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_millis(TIMELINE_MAX_AGE_MS))
        .unwrap_or(UNIX_EPOCH);
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_file() && metadata.modified().is_ok_and(|modified| modified < cutoff) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn render_handoff(project: &Project, window: &StoredWindow, snapshot: &RuntimeSnapshot) -> String {
    let branch = git_output(&window.cwd, &["branch", "--show-current"]);
    let status = git_output(&window.cwd, &["status", "--short"]);
    let diff = git_output(&window.cwd, &["diff", "--stat"]);
    let commits = git_output(&window.cwd, &["log", "-5", "--oneline"]);
    let timeline = window
        .timeline
        .iter()
        .rev()
        .take(100)
        .rev()
        .map(|event| {
            format!(
                "- {} · {} · {}",
                event.at,
                event.kind,
                event.summary.replace('\n', " ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let ports = snapshot
        .ports
        .iter()
        .map(|port| format!("- {} — {} ({})", port.url, port.process, port.pid))
        .collect::<Vec<_>>()
        .join("\n");
    let pane = capture_pane(window);
    format!(
        "# Agent Grid handoff\n\n\
Generated: {generated}\n\n\
## Source\n\n\
- Project: {project_name}\n\
- Window: {window_name}\n\
- Working directory: `{cwd}`\n\
- Process: `{process}`\n\
- Activity: {activity}\n\n\
## Open ports\n\n{ports}\n\n\
## Git\n\n\
- Branch: `{branch}`\n\n\
### Status\n\n```text\n{status}\n```\n\n\
### Diff stat\n\n```text\n{diff}\n```\n\n\
### Recent commits\n\n```text\n{commits}\n```\n\n\
## Recent timeline\n\n{timeline}\n\n\
## Last 200 terminal lines\n\n```text\n{pane}\n```\n",
        generated = now_ms(),
        project_name = project.name,
        window_name = window.name,
        cwd = window.cwd,
        process = snapshot.current_command.as_deref().unwrap_or("unknown"),
        activity = snapshot.activity_state,
        ports = if ports.is_empty() {
            "- None".into()
        } else {
            ports
        },
        branch = if branch.is_empty() {
            "not a git repository".into()
        } else {
            branch
        },
        status = status,
        diff = diff,
        commits = commits,
        timeline = if timeline.is_empty() {
            "- No events".into()
        } else {
            timeline
        },
        pane = pane,
    )
}

fn stop_connection(id: &str, state: &RuntimeState) {
    if let Some(mut connection) = state.connections.lock().unwrap().remove(id) {
        let _ = connection.child.kill();
    }
}

fn refresh_runtime(state: &RuntimeState) -> Result<HashMap<String, RuntimeSnapshot>, String> {
    let windows: Vec<StoredWindow> = {
        let store = state.store.lock().map_err(|error| error.to_string())?;
        store
            .data
            .projects
            .iter()
            .flat_map(|project| project.windows.clone())
            .collect()
    };
    let snapshots = {
        let mut omp_states = state.omp_states.lock().map_err(|error| error.to_string())?;
        collect_runtime_snapshots(&windows, &mut omp_states)
    };
    let mut previous = state.snapshots.lock().map_err(|error| error.to_string())?;
    let mut store = state.store.lock().map_err(|error| error.to_string())?;
    let mut changed = false;
    for window in store
        .data
        .projects
        .iter_mut()
        .flat_map(|project| &mut project.windows)
    {
        let Some(current) = snapshots.get(&window.id) else {
            continue;
        };
        if let Some(old) = previous.get(&window.id) {
            if old.activity_state != current.activity_state {
                append_timeline_event(
                    window,
                    "activity",
                    format!("Activity changed to {}", current.activity_state),
                    None,
                );
                changed = true;
            }
            if old.current_command != current.current_command {
                if let Some(command) = current.current_command.as_deref() {
                    append_timeline_event(
                        window,
                        "process",
                        format!("Process changed to {command}"),
                        None,
                    );
                    changed = true;
                }
            }
            for port in &current.ports {
                if !old.ports.iter().any(|item| {
                    item.port == port.port && item.pid == port.pid && item.address == port.address
                }) {
                    append_timeline_event(
                        window,
                        "portOpened",
                        format!("Port {} opened by {}", port.port, port.process),
                        Some(port.clone()),
                    );
                    changed = true;
                }
            }
            for port in &old.ports {
                if !current.ports.iter().any(|item| {
                    item.port == port.port && item.pid == port.pid && item.address == port.address
                }) {
                    append_timeline_event(
                        window,
                        "portClosed",
                        format!("Port {} closed", port.port),
                        Some(port.clone()),
                    );
                    changed = true;
                }
            }
        } else if window.timeline.is_empty() {
            append_timeline_event(
                window,
                "activity",
                format!("Activity is {}", current.activity_state),
                None,
            );
            changed = true;
        }
    }
    *previous = snapshots.clone();
    previous.retain(|id, _| windows.iter().any(|window| &window.id == id));
    if changed {
        store.save()?;
    }
    Ok(snapshots)
}

#[tauri::command]
fn get_config() -> serde_json::Value {
    let default_cwd = dirs::home_dir().unwrap_or_default().join("projects");
    serde_json::json!({ "defaultCwd": default_cwd, "defaultCommand": "omp" })
}

#[tauri::command]
fn set_compact_mode(
    enabled: bool,
    window: tauri::WebviewWindow,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    if enabled {
        let position = window.outer_position().map_err(|error| error.to_string())?;
        let size = window.outer_size().map_err(|error| error.to_string())?;
        let mut previous = state
            .compact_window
            .lock()
            .map_err(|error| error.to_string())?;
        if previous.is_none() {
            *previous = Some((position.x, position.y, size.width, size.height));
        }
        drop(previous);

        window
            .set_min_size(Some(tauri::LogicalSize::new(340.0, 500.0)))
            .map_err(|error| error.to_string())?;
        window
            .set_size(tauri::LogicalSize::new(390.0, 780.0))
            .map_err(|error| error.to_string())?;
        window
            .set_always_on_top(true)
            .map_err(|error| error.to_string())?;
        if let Ok(Some(monitor)) = window.current_monitor() {
            let compact =
                tauri::LogicalSize::new(390.0, 780.0).to_physical::<u32>(monitor.scale_factor());
            let monitor_position = monitor.position();
            let monitor_size = monitor.size();
            let x = monitor_position.x + monitor_size.width as i32 - compact.width as i32 - 20;
            let y = monitor_position.y + 20;
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        }
        return Ok(());
    }

    window
        .set_always_on_top(false)
        .map_err(|error| error.to_string())?;
    window
        .set_min_size(Some(tauri::LogicalSize::new(900.0, 600.0)))
        .map_err(|error| error.to_string())?;
    let previous = state
        .compact_window
        .lock()
        .map_err(|error| error.to_string())?
        .take();
    if let Some((x, y, width, height)) = previous {
        window
            .set_size(tauri::PhysicalSize::new(width, height))
            .map_err(|error| error.to_string())?;
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    } else {
        window
            .set_size(tauri::LogicalSize::new(1440.0, 900.0))
            .map_err(|error| error.to_string())?;
        let _ = window.center();
    }
    Ok(())
}

fn popout_window_label(id: &str) -> Result<String, String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("Invalid chat window id.".into());
    }
    Ok(format!("chat-{id}"))
}

#[tauri::command]
fn open_chat_popout(
    id: String,
    app: tauri::AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    let label = popout_window_label(&id)?;
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let title = {
        let store = state.store.lock().map_err(|error| error.to_string())?;
        store
            .find_window(&id)
            .map(|window| window.name.clone())
            .ok_or("Window not found.")?
    };
    tauri::WebviewWindowBuilder::new(
        &app,
        label,
        tauri::WebviewUrl::App(format!("index.html?popout={id}").into()),
    )
    .title(title)
    .inner_size(900.0, 650.0)
    .min_inner_size(600.0, 420.0)
    .always_on_top(false)
    .build()
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn close_chat_popout(id: String, app: tauri::AppHandle) -> Result<(), String> {
    let label = popout_window_label(&id)?;
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_projects(state: State<'_, RuntimeState>) -> Result<Vec<ProjectView>, String> {
    let snapshots = refresh_runtime(&state)?;
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
            windows: project
                .windows
                .iter()
                .map(|window| window_view(window, snapshots.get(&window.id)))
                .collect(),
        })
        .collect())
}

fn validated_project_fields(input: &ProjectInput) -> Result<(String, String, String), String> {
    let name = input.name.trim();
    let default_command = input.default_command.trim();
    if name.is_empty() {
        return Err("Project name is required.".into());
    }
    if default_command.is_empty() {
        return Err("Default agent command is required.".into());
    }
    Ok((
        name.chars().take(60).collect(),
        validate_directory(&input.cwd)?,
        default_command.into(),
    ))
}

fn update_project_record(project: &mut Project, input: ProjectInput) -> Result<(), String> {
    let (name, cwd, default_command) = validated_project_fields(&input)?;
    project.name = name;
    project.cwd = cwd;
    project.default_command = default_command;
    Ok(())
}

fn reorder_project_records(projects: &mut [Project], ids: &[String]) -> Result<(), String> {
    if ids.len() != projects.len() {
        return Err("Project order must include every project.".into());
    }
    let positions: HashMap<_, _> = ids
        .iter()
        .enumerate()
        .map(|(index, id)| (id.as_str(), index))
        .collect();
    if positions.len() != ids.len()
        || projects
            .iter()
            .any(|project| !positions.contains_key(project.id.as_str()))
    {
        return Err("Project order contains unknown or duplicate projects.".into());
    }
    projects.sort_by_key(|project| positions[project.id.as_str()]);
    Ok(())
}

#[tauri::command]
fn create_project(input: ProjectInput, state: State<'_, RuntimeState>) -> Result<Project, String> {
    let (name, cwd, default_command) = validated_project_fields(&input)?;
    let project = Project {
        id: short_id(),
        name,
        cwd,
        default_command,
        created_at: timestamp(),
        windows: Vec::new(),
    };
    let mut store = state.store.lock().map_err(|error| error.to_string())?;
    store.data.projects.push(project.clone());
    store.save()?;
    Ok(project)
}

#[tauri::command]
fn update_project(
    id: String,
    input: ProjectInput,
    state: State<'_, RuntimeState>,
) -> Result<Project, String> {
    let mut store = state.store.lock().map_err(|error| error.to_string())?;
    let project = store
        .data
        .projects
        .iter_mut()
        .find(|project| project.id == id)
        .ok_or("Project not found.")?;
    update_project_record(project, input)?;
    let updated = project.clone();
    store.save()?;
    Ok(updated)
}

#[tauri::command]
fn reorder_projects(ids: Vec<String>, state: State<'_, RuntimeState>) -> Result<(), String> {
    let mut store = state.store.lock().map_err(|error| error.to_string())?;
    reorder_project_records(&mut store.data.projects, &ids)?;
    store.save()
}

fn project_path(project_id: &str, state: &RuntimeState) -> Result<PathBuf, String> {
    let store = state.store.lock().map_err(|error| error.to_string())?;
    store
        .data
        .projects
        .iter()
        .find(|project| project.id == project_id)
        .map(|project| PathBuf::from(&project.cwd))
        .ok_or_else(|| "Project not found.".into())
}

#[tauri::command]
fn get_git_status(
    project_id: String,
    state: State<'_, RuntimeState>,
) -> Result<GitStatusView, String> {
    git_status_for_path(&project_path(&project_id, &state)?)
}

#[tauri::command]
fn switch_git_branch(
    project_id: String,
    branch: String,
    state: State<'_, RuntimeState>,
) -> Result<GitStatusView, String> {
    switch_git_branch_for_path(&project_path(&project_id, &state)?, &branch)
}

#[tauri::command]
fn pull_git(project_id: String, state: State<'_, RuntimeState>) -> Result<GitStatusView, String> {
    pull_git_for_path(&project_path(&project_id, &state)?)
}

#[tauri::command]
fn push_git(project_id: String, state: State<'_, RuntimeState>) -> Result<GitStatusView, String> {
    push_git_for_path(&project_path(&project_id, &state)?)
}

#[tauri::command]
fn get_git_graph(
    project_id: String,
    state: State<'_, RuntimeState>,
) -> Result<GitGraphView, String> {
    git_graph_for_path(&project_path(&project_id, &state)?)
}

#[tauri::command]
fn get_git_commit(
    project_id: String,
    hash: String,
    state: State<'_, RuntimeState>,
) -> Result<GitCommitDetailView, String> {
    git_commit_detail_for_path(&project_path(&project_id, &state)?, &hash)
}

#[tauri::command]
fn get_repository(
    project_id: String,
    state: State<'_, RuntimeState>,
) -> Result<RepositoryView, String> {
    list_repository_path(&project_path(&project_id, &state)?)
}

#[tauri::command]
fn read_repository_file(
    project_id: String,
    path: String,
    state: State<'_, RuntimeState>,
) -> Result<RepositoryFileView, String> {
    read_repository_path(&project_path(&project_id, &state)?, &path)
}

#[tauri::command]
fn open_project_in_editor(
    project_id: String,
    editor_command: String,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    let editor_command = editor_command.trim();
    if editor_command.is_empty() {
        return Err("Choose an editor in Settings first.".into());
    }
    let root = canonical_repository_root(&project_path(&project_id, &state)?)?;
    let mut child = Command::new(editor_command)
        .arg(root)
        .spawn()
        .map_err(|error| format!("Could not start {editor_command}: {error}"))?;
    thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
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
    let mut window = StoredWindow {
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
        timeline: Vec::new(),
    };
    append_timeline_event(&mut window, "activity", "Window created", None);
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
    Ok(window_view(&window, None))
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
fn get_window_timeline(
    id: String,
    state: State<'_, RuntimeState>,
) -> Result<Vec<TimelineEvent>, String> {
    let mut store = state.store.lock().map_err(|error| error.to_string())?;
    let window = store
        .data
        .projects
        .iter_mut()
        .flat_map(|project| &mut project.windows)
        .find(|window| window.id == id)
        .ok_or("Window not found.")?;
    let before = window.timeline.len();
    let mut changed = false;
    for event in &mut window.timeline {
        if event.kind != "interaction" && event.kind != "command" {
            continue;
        }
        let cleaned = clean_submission_text(&event.summary);
        if cleaned != event.summary {
            event.summary = cleaned;
            changed = true;
        }
    }
    prune_timeline(&mut window.timeline, now_ms());
    let events = window.timeline.clone();
    if changed || events.len() != before {
        store.save()?;
    }
    Ok(events)
}

#[tauri::command]
fn record_submission(
    id: String,
    text: String,
    terminal_line: Option<u32>,
    state: State<'_, RuntimeState>,
) -> Result<String, String> {
    let cleaned = clean_submission_text(&text);
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        return Err("Submission is empty.".into());
    }
    let mut store = state.store.lock().map_err(|error| error.to_string())?;
    let window = store
        .data
        .projects
        .iter_mut()
        .flat_map(|project| &mut project.windows)
        .find(|window| window.id == id)
        .ok_or("Window not found.")?;
    let now = now_ms();
    if let Some(previous) =
        window.timeline.iter_mut().rev().find(|event| {
            event.kind == "interaction" && event.status.as_deref() != Some("completed")
        })
    {
        previous.status = Some("completed".into());
        previous.updated_at = Some(now);
    }
    let event_id = short_id();
    window.timeline.push(TimelineEvent {
        id: event_id.clone(),
        at: now,
        kind: "interaction".into(),
        summary: cleaned.chars().take(4_096).collect(),
        port: None,
        updated_at: Some(now),
        status: Some("running".into()),
        terminal_line,
    });
    prune_timeline(&mut window.timeline, now);
    store.save()?;
    Ok(event_id)
}

#[tauri::command]
fn update_submission(
    id: String,
    event_id: String,
    status: String,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    if !matches!(status.as_str(), "running" | "waiting" | "completed") {
        return Err("Invalid submission status.".into());
    }
    let mut store = state.store.lock().map_err(|error| error.to_string())?;
    let window = store
        .data
        .projects
        .iter_mut()
        .flat_map(|project| &mut project.windows)
        .find(|window| window.id == id)
        .ok_or("Window not found.")?;
    let event = window
        .timeline
        .iter_mut()
        .find(|event| event.id == event_id && event.kind == "interaction")
        .ok_or("Submission not found.")?;
    event.updated_at = Some(now_ms());
    event.status = Some(status);
    store.save()
}

#[tauri::command]
fn create_handoff(id: String, state: State<'_, RuntimeState>) -> Result<HandoffView, String> {
    let snapshots = refresh_runtime(&state)?;
    let (project, window) = {
        let store = state.store.lock().map_err(|error| error.to_string())?;
        store
            .data
            .projects
            .iter()
            .find_map(|project| {
                project
                    .windows
                    .iter()
                    .find(|window| window.id == id)
                    .map(|window| (project.clone(), window.clone()))
            })
            .ok_or("Window not found.")?
    };
    let snapshot = snapshots.get(&id).cloned().unwrap_or_default();
    let handoff_id = short_id();
    let directory = state.app_data_dir.join("handoffs");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    cleanup_handoffs(&directory);
    let path = directory.join(format!("{handoff_id}.md"));
    fs::write(&path, render_handoff(&project, &window, &snapshot))
        .map_err(|error| error.to_string())?;
    let path_text = path.to_string_lossy().into_owned();
    let copy_text = format!("Continue from this Agent Grid handoff. Read it first: {path_text}");
    let can_fork = codex_session_id(snapshot.pane_pid).is_some();

    let mut store = state.store.lock().map_err(|error| error.to_string())?;
    let source = store
        .data
        .projects
        .iter_mut()
        .flat_map(|project| &mut project.windows)
        .find(|window| window.id == id)
        .ok_or("Window not found.")?;
    append_timeline_event(
        source,
        "handoff",
        format!("Handoff {handoff_id} created"),
        None,
    );
    store.save()?;
    Ok(HandoffView {
        id: handoff_id,
        path: path_text,
        copy_text,
        can_fork,
    })
}

#[tauri::command]
fn fork_handoff(
    source_id: String,
    handoff_id: String,
    state: State<'_, RuntimeState>,
) -> Result<HandoffForkView, String> {
    if handoff_id.len() != 10
        || !handoff_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric())
    {
        return Err("Invalid handoff identifier.".into());
    }
    let path = state
        .app_data_dir
        .join("handoffs")
        .join(format!("{handoff_id}.md"));
    if !path.is_file() {
        return Err("Handoff snapshot was not found.".into());
    }
    let snapshots = refresh_runtime(&state)?;
    let (project_id, project, source) = {
        let store = state.store.lock().map_err(|error| error.to_string())?;
        store
            .data
            .projects
            .iter()
            .find_map(|project| {
                project
                    .windows
                    .iter()
                    .find(|window| window.id == source_id)
                    .map(|window| (project.id.clone(), project.clone(), window.clone()))
            })
            .ok_or("Source window not found.")?
    };
    let session_id = snapshots
        .get(&source_id)
        .and_then(|snapshot| codex_session_id(snapshot.pane_pid));
    let prompt = format!(
        "Continue this work. The transfer snapshot is at {}",
        path.to_string_lossy()
    );
    let (command, exact_fork) = if let Some(session_id) = session_id {
        (
            format!("codex fork {session_id} {}", shell_quote(&prompt)),
            true,
        )
    } else {
        (project.default_command.clone(), false)
    };
    let id = short_id();
    let mut window = StoredWindow {
        id: id.clone(),
        session_name: format!("agent-grid-{id}"),
        name: format!("{} handoff", source.name)
            .chars()
            .take(60)
            .collect(),
        cwd: source.cwd.clone(),
        command: Some(command),
        kind: WindowKind::Agent,
        created_at: timestamp(),
        timeline: Vec::new(),
    };
    append_timeline_event(
        &mut window,
        "handoff",
        format!("Opened from handoff {handoff_id}"),
        None,
    );
    start_session(&window)?;
    let view = window_view(&window, None);
    let mut store = state.store.lock().map_err(|error| error.to_string())?;
    let target = store
        .data
        .projects
        .iter_mut()
        .find(|project| project.id == project_id)
        .ok_or("Project not found.")?;
    target.windows.push(window);
    if let Some(source) = target
        .windows
        .iter_mut()
        .find(|window| window.id == source_id)
    {
        append_timeline_event(
            source,
            "handoff",
            format!("Handoff {handoff_id} opened in a new agent"),
            None,
        );
    }
    if let Err(error) = store.save() {
        kill_session(&view.session_name);
        return Err(error);
    }
    Ok(HandoffForkView {
        window: view,
        exact_fork,
    })
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
    configure_session(&window.session_name)?;
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
fn scroll_terminal_history(
    id: String,
    lines: i16,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    let target = {
        let store = state.store.lock().map_err(|error| error.to_string())?;
        let window = store.find_window(&id).ok_or("Window not found.")?;
        format!("{}:0.0", window.session_name)
    };
    let lines = lines.clamp(-100, 100);
    if lines == 0 {
        return Ok(());
    }
    if lines > 0 {
        let status = Command::new("tmux")
            .args(["copy-mode", "-e", "-t", &target])
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() {
            return Err("Could not enter terminal history.".into());
        }
        state
            .history_modes
            .lock()
            .map_err(|error| error.to_string())?
            .insert(id);
    }
    let command = if lines > 0 {
        "scroll-up"
    } else {
        "scroll-down"
    };
    let status = Command::new("tmux")
        .args([
            "send-keys",
            "-X",
            "-t",
            &target,
            "-N",
            &lines.unsigned_abs().to_string(),
            command,
        ])
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Could not scroll terminal history.".into())
    }
}

fn tmux_search_pattern(text: &str) -> String {
    let first_line = text.lines().next().unwrap_or_default();
    let compact = first_line.split_whitespace().collect::<Vec<_>>().join(" ");
    compact
        .chars()
        .take(100)
        .flat_map(|character| {
            if r".*+?()[]{}^$|\".contains(character) {
                vec!['\\', character]
            } else {
                vec![character]
            }
        })
        .collect()
}

#[tauri::command]
fn jump_to_prompt(id: String, text: String, state: State<'_, RuntimeState>) -> Result<(), String> {
    let pattern = tmux_search_pattern(&clean_submission_text(&text));
    if pattern.is_empty() {
        return Err("Prompt is empty.".into());
    }
    let target = {
        let store = state.store.lock().map_err(|error| error.to_string())?;
        let window = store.find_window(&id).ok_or("Window not found.")?;
        format!("{}:0.0", window.session_name)
    };
    let entered = Command::new("tmux")
        .args(["copy-mode", "-e", "-t", &target])
        .status()
        .map_err(|error| error.to_string())?;
    let searched = Command::new("tmux")
        .args([
            "send-keys",
            "-X",
            "-t",
            &target,
            "search-backward",
            &pattern,
        ])
        .status()
        .map_err(|error| error.to_string())?;
    if !entered.success() || !searched.success() {
        return Err("Prompt is no longer in tmux history.".into());
    }
    state
        .history_modes
        .lock()
        .map_err(|error| error.to_string())?
        .insert(id);
    Ok(())
}

#[tauri::command]
fn write_terminal(id: String, data: String, state: State<'_, RuntimeState>) -> Result<(), String> {
    let was_in_history = state
        .history_modes
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&id);
    if was_in_history {
        let target = {
            let store = state.store.lock().map_err(|error| error.to_string())?;
            store
                .find_window(&id)
                .map(|window| format!("{}:0.0", window.session_name))
        };
        if let Some(target) = target {
            let _ = Command::new("tmux")
                .args(["send-keys", "-X", "-t", &target, "cancel"])
                .status();
        }
    }
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let path = app_data_dir.join("state.json");
            let store = Store::load(path).map_err(std::io::Error::other)?;
            app.manage(RuntimeState {
                store: Mutex::new(store),
                connections: Mutex::new(HashMap::new()),
                history_modes: Mutex::new(HashSet::new()),
                snapshots: Mutex::new(HashMap::new()),
                omp_states: Mutex::new(HashMap::new()),
                compact_window: Mutex::new(None),
                app_data_dir,
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if !matches!(event, tauri::WindowEvent::Destroyed) {
                return;
            }
            let Some(id) = window.label().strip_prefix("chat-") else {
                return;
            };
            let state = window.state::<RuntimeState>();
            stop_connection(id, &state);
            if let Some(main) = window.app_handle().get_webview_window("main") {
                let _ = main.emit("chat-popout-closed", id);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            get_projects,
            get_git_status,
            switch_git_branch,
            pull_git,
            push_git,
            get_git_graph,
            get_git_commit,
            get_repository,
            read_repository_file,
            open_project_in_editor,
            set_compact_mode,
            open_chat_popout,
            close_chat_popout,
            create_project,
            update_project,
            reorder_projects,
            delete_project,
            create_window,
            delete_window,
            restart_window,
            get_window_timeline,
            record_submission,
            update_submission,
            create_handoff,
            fork_handoff,
            attach_terminal,
            scroll_terminal_history,
            jump_to_prompt,
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
        assert_eq!(migrated.version, 5);
        assert!(migrated.projects.is_empty());
    }

    #[test]
    fn projects_default_to_omp_and_migrate_the_legacy_codex_default() {
        let new_project: Project = serde_json::from_str(
            r#"{"id":"new","name":"New","cwd":"/tmp","createdAt":"now","windows":[]}"#,
        )
        .unwrap();
        let migrated = migrate_store(
            r#"{"version":5,"projects":[
                {"id":"legacy","name":"Legacy","cwd":"/tmp","defaultCommand":"codex","createdAt":"now","windows":[]},
                {"id":"custom","name":"Custom","cwd":"/tmp","defaultCommand":"codex --model gpt-5","createdAt":"now","windows":[]}
            ]}"#,
        )
        .unwrap();
        assert_eq!(new_project.default_command, "omp");
        assert_eq!(migrated.projects[0].default_command, "omp");
        assert_eq!(migrated.projects[1].default_command, "codex --model gpt-5");
        assert_eq!(get_config()["defaultCommand"], "omp");
    }

    #[test]
    fn updates_project_settings_without_touching_windows() {
        let mut project: Project = serde_json::from_str(
            r#"{"id":"project","name":"Old","cwd":"/tmp","defaultCommand":"omp","createdAt":"now","windows":[{"id":"window","sessionName":"session","name":"Agent","cwd":"/tmp","command":"omp","kind":"agent","createdAt":"now"}]}"#,
        )
        .unwrap();
        update_project_record(
            &mut project,
            ProjectInput {
                name: "  Renamed project  ".into(),
                cwd: "~".into(),
                default_command: "omp --model slow".into(),
            },
        )
        .unwrap();
        assert_eq!(project.name, "Renamed project");
        assert_eq!(project.default_command, "omp --model slow");
        assert_eq!(project.windows[0].command.as_deref(), Some("omp"));
    }

    #[test]
    fn reorders_projects_only_with_a_complete_unique_id_list() {
        let mut projects: Vec<Project> = serde_json::from_str(
            r#"[
                {"id":"a","name":"A","cwd":"/tmp","createdAt":"now","windows":[]},
                {"id":"b","name":"B","cwd":"/tmp","createdAt":"now","windows":[]},
                {"id":"c","name":"C","cwd":"/tmp","createdAt":"now","windows":[]}
            ]"#,
        )
        .unwrap();
        reorder_project_records(&mut projects, &["c".into(), "a".into(), "b".into()]).unwrap();
        assert_eq!(
            projects
                .iter()
                .map(|project| project.id.as_str())
                .collect::<Vec<_>>(),
            ["c", "a", "b"]
        );
        assert!(reorder_project_records(&mut projects, &["a".into(), "b".into()]).is_err());
        assert!(
            reorder_project_records(&mut projects, &["a".into(), "a".into(), "c".into()]).is_err()
        );
    }

    #[test]
    fn creates_safe_chat_popout_window_labels() {
        assert_eq!(
            popout_window_label("01a032cc-5ea5").unwrap(),
            "chat-01a032cc-5ea5"
        );
        assert!(popout_window_label("../main").is_err());
        assert!(popout_window_label("").is_err());
    }

    #[test]
    fn reads_and_switches_local_git_branches() {
        let repository = std::env::temp_dir().join(format!("agent-grid-git-{}", short_id()));
        fs::create_dir_all(&repository).unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.name", "Agent Grid Test"],
            vec!["config", "user.email", "agent-grid@example.invalid"],
        ] {
            assert!(Command::new("git")
                .arg("-C")
                .arg(&repository)
                .args(args)
                .status()
                .unwrap()
                .success());
        }
        fs::write(repository.join("README"), "initial\n").unwrap();
        for args in [
            vec!["add", "README"],
            vec!["commit", "-m", "initial"],
            vec!["branch", "feature"],
        ] {
            assert!(Command::new("git")
                .arg("-C")
                .arg(&repository)
                .args(args)
                .status()
                .unwrap()
                .success());
        }

        let status = git_status_for_path(&repository).unwrap();
        assert!(status.available);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.branches, ["feature", "main"]);
        assert!(!status.dirty);
        assert!(!status.has_upstream);

        switch_git_branch_for_path(&repository, "feature").unwrap();
        let switched = git_status_for_path(&repository).unwrap();
        assert_eq!(switched.branch.as_deref(), Some("feature"));
        fs::write(repository.join("README"), "changed\n").unwrap();
        assert!(git_status_for_path(&repository).unwrap().dirty);
        for args in [
            vec!["add", "README"],
            vec!["commit", "-m", "feature change"],
        ] {
            assert!(Command::new("git")
                .arg("-C")
                .arg(&repository)
                .args(args)
                .status()
                .unwrap()
                .success());
        }
        let graph = git_graph_for_path(&repository).unwrap();
        assert_eq!(graph.commits.len(), 2);
        assert!(!graph.truncated);
        assert_eq!(graph.commits[0].subject, "feature change");
        assert!(graph.commits[0]
            .refs
            .iter()
            .any(|reference| reference.contains("feature")));
        assert_eq!(graph.commits[0].parents, [graph.commits[1].hash.clone()]);
        let detail = git_commit_detail_for_path(&repository, &graph.commits[0].hash).unwrap();
        assert_eq!(detail.subject, "feature change");
        assert_eq!(detail.files[0].status, "M");
        assert_eq!(detail.files[0].path, "README");
        assert!(git_commit_detail_for_path(&repository, "../invalid").is_err());
        assert!(switch_git_branch_for_path(&repository, "../invalid").is_err());
        let _ = fs::remove_dir_all(repository);
    }

    #[test]
    fn parses_and_limits_git_graph_output() {
        let output = (0..=GIT_GRAPH_LIMIT)
            .map(|index| {
                format!(
                    "{index:040x}\t\tbranch-{index}\tAuthor\t2026-08-25T10:00:00Z\tCommit {index}"
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let graph = parse_git_graph_output(&output);
        assert_eq!(graph.commits.len(), GIT_GRAPH_LIMIT);
        assert!(graph.truncated);
        assert_eq!(graph.commits[0].short_hash, "0000000");
        assert_eq!(graph.commits[0].refs, ["branch-0"]);
        assert_eq!(graph.commits[0].subject, "Commit 0");
    }

    #[test]
    fn pushes_and_fast_forward_pulls_with_a_local_remote() {
        let root = std::env::temp_dir().join(format!("agent-grid-git-remote-{}", short_id()));
        let repository = root.join("local");
        let remote = root.join("remote.git");
        let other = root.join("other");
        fs::create_dir_all(&root).unwrap();
        let run = |cwd: &Path, args: &[&str]| {
            assert!(Command::new("git")
                .arg("-C")
                .arg(cwd)
                .args(args)
                .status()
                .unwrap()
                .success());
        };

        run(
            &root,
            &[
                "init",
                "--bare",
                "--initial-branch=main",
                remote.to_str().unwrap(),
            ],
        );
        run(&root, &["init", "-b", "main", repository.to_str().unwrap()]);
        run(&repository, &["config", "user.name", "Agent Grid Test"]);
        run(
            &repository,
            &["config", "user.email", "agent-grid@example.invalid"],
        );
        fs::write(repository.join("README"), "initial\n").unwrap();
        run(&repository, &["add", "README"]);
        run(&repository, &["commit", "-m", "initial"]);
        run(
            &repository,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );

        let pushed = push_git_for_path(&repository).unwrap();
        assert!(pushed.has_upstream);
        assert_eq!(pushed.upstream.as_deref(), Some("origin/main"));

        run(
            &root,
            &["clone", remote.to_str().unwrap(), other.to_str().unwrap()],
        );
        run(&other, &["config", "user.name", "Agent Grid Test"]);
        run(
            &other,
            &["config", "user.email", "agent-grid@example.invalid"],
        );
        fs::write(other.join("README"), "remote change\n").unwrap();
        run(&other, &["add", "README"]);
        run(&other, &["commit", "-m", "remote change"]);
        run(&other, &["push"]);

        pull_git_for_path(&repository).unwrap();
        assert_eq!(
            fs::read_to_string(repository.join("README")).unwrap(),
            "remote change\n"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn prunes_timeline_by_age_and_count() {
        let current = 10_000_000_000_u64;
        let mut events = vec![TimelineEvent {
            id: "old".into(),
            at: current - TIMELINE_MAX_AGE_MS - 1,
            kind: "activity".into(),
            summary: "old".into(),
            port: None,
            updated_at: None,
            status: None,
            terminal_line: None,
        }];
        events.extend((0..510).map(|index| TimelineEvent {
            id: index.to_string(),
            at: current - 1_000 + index,
            kind: "command".into(),
            summary: index.to_string(),
            port: None,
            updated_at: None,
            status: None,
            terminal_line: None,
        }));
        prune_timeline(&mut events, current);
        assert_eq!(events.len(), TIMELINE_MAX_EVENTS);
        assert_eq!(events.first().unwrap().id, "10");
        assert_eq!(events.last().unwrap().id, "509");
    }

    #[test]
    fn parses_listening_ipv4_socket_for_owned_inode() {
        let contents = "\
sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n\
0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1\n";
        let owners = HashMap::from([(12_345_u64, 77_u32)]);
        let mut ports = BTreeMap::new();
        parse_listening_sockets(contents, false, &owners, &mut ports);
        let port = ports.values().find(|port| port.port == 8080).unwrap();
        assert_eq!(port.address, "127.0.0.1");
        assert_eq!(port.url, "http://127.0.0.1:8080");
        assert_eq!(port.pid, 77);
    }

    #[test]
    fn attributes_a_real_listener_to_the_current_process() {
        let Ok(listener) = std::net::TcpListener::bind("127.0.0.1:0") else {
            return;
        };
        let port = listener.local_addr().unwrap().port();
        let ports = listening_ports(std::process::id());
        assert!(ports.iter().any(|item| item.port == port));
    }

    #[test]
    fn strips_terminal_sequences_and_quotes_shell_values() {
        assert_eq!(
            strip_control_sequences("\u{1b}[31mred\u{1b}[0m\nplain"),
            "red\nplain"
        );
        assert_eq!(shell_quote("it's ready"), "'it'\"'\"'s ready'");
    }

    #[test]
    fn cleans_submission_text_and_escapes_tmux_searches() {
        assert_eq!(
            clean_submission_text("10;rgb:d7d7/d9d9/dcdc11;rgb:0c0c/0e0e/1010Where did it fail?"),
            "Where did it fail?"
        );
        assert_eq!(tmux_search_pattern("find [this]?"), r"find \[this\]\?");
    }

    #[test]
    fn reads_codex_turn_boundaries_from_rollout_tail() {
        let path = std::env::temp_dir().join(format!("agent-grid-rollout-{}.jsonl", short_id()));
        fs::write(
            &path,
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
        )
        .unwrap();
        assert_eq!(rollout_turn_active(&path), Some(true));
        fs::write(
            &path,
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n\
             {\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n",
        )
        .unwrap();
        assert_eq!(rollout_turn_active(&path), Some(false));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn reads_omp_turn_state_from_session_tail() {
        let path = std::env::temp_dir().join(format!("agent-grid-omp-{}.jsonl", short_id()));
        fs::write(
            &path,
            "{\"type\":\"session\"}\n\
             {\"type\":\"message\",\"message\":{\"role\":\"user\"}}\n",
        )
        .unwrap();
        assert_eq!(omp_turn_state(&path), Some("running"));

        fs::write(
            &path,
            "{\"type\":\"session\"}\n\
             {\"type\":\"message\",\"message\":{\"role\":\"user\"}}\n\
             {\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"toolUse\"}}\n\
             {\"type\":\"custom\",\"customType\":\"tool_execution_start\",\"data\":{\"toolCallId\":\"ask-1\",\"toolName\":\"ask\"}}\n",
        )
        .unwrap();
        assert_eq!(omp_turn_state(&path), Some("needs-input"));

        fs::write(
            &path,
            "{\"type\":\"session\"}\n\
             {\"type\":\"message\",\"message\":{\"role\":\"user\"}}\n\
             {\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"toolUse\"}}\n\
             {\"type\":\"custom\",\"customType\":\"tool_execution_start\",\"data\":{\"toolCallId\":\"ask-1\",\"toolName\":\"ask\"}}\n\
             {\"type\":\"message\",\"message\":{\"role\":\"toolResult\",\"toolCallId\":\"ask-1\"}}\n",
        )
        .unwrap();
        assert_eq!(omp_turn_state(&path), Some("running"));

        fs::write(
            &path,
            "{\"type\":\"session\"}\n\
             {\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\"}}\n",
        )
        .unwrap();
        assert_eq!(omp_turn_state(&path), Some("waiting"));

        fs::write(
            &path,
            "{\"type\":\"session\"}\n\
             {\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"error\"}}\n",
        )
        .unwrap();
        assert_eq!(omp_turn_state(&path), Some("attention"));
        assert_eq!(
            terminal_breadcrumb_id(Path::new("/dev/pts/8")).as_deref(),
            Some("pts-8")
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn resolves_a_live_omp_terminal_breadcrumb_when_requested() {
        let Some(pid) = std::env::var("AGENT_GRID_TEST_OMP_PID")
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
        else {
            return;
        };
        let path = omp_session_path(pid).expect("OMP terminal breadcrumb");
        assert!(path.exists());
        assert!(omp_turn_state(&path).is_some());
    }

    #[test]
    fn codex_rollout_state_overrides_terminal_activity() {
        let window = StoredWindow {
            id: "agent".into(),
            session_name: "agent-grid-agent".into(),
            name: "Agent".into(),
            cwd: "/tmp".into(),
            command: Some("codex --model gpt-5".into()),
            kind: WindowKind::Agent,
            created_at: timestamp(),
            timeline: Vec::new(),
        };
        let mut snapshot = RuntimeSnapshot {
            running: true,
            current_command: Some("node".into()),
            agent_busy: Some(false),
            ..RuntimeSnapshot::default()
        };
        assert!(codex_command(window.command.as_deref()));
        assert_eq!(activity_state(&window, &snapshot), "waiting");
        snapshot.agent_busy = Some(true);
        assert_eq!(activity_state(&window, &snapshot), "running");
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
            timeline: Vec::new(),
        };
        let _terminal_guard = SessionGuard(terminal.session_name.clone());
        start_session(&terminal).unwrap();
        assert!(session_exists(&terminal.session_name));
        let mouse = Command::new("tmux")
            .args(["show-options", "-t", &terminal.session_name, "-v", "mouse"])
            .output()
            .unwrap();
        assert!(mouse.status.success());
        assert_eq!(String::from_utf8_lossy(&mouse.stdout).trim(), "off");

        let agent_id = short_id();
        let agent = StoredWindow {
            id: agent_id.clone(),
            session_name: format!("agent-grid-{agent_id}"),
            name: "Test agent".into(),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            command: Some("printf tauri-agent-ready".into()),
            kind: WindowKind::Agent,
            created_at: timestamp(),
            timeline: Vec::new(),
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

    #[test]
    fn lists_repository_sources_and_documentation_without_generated_directories() {
        let repository = std::env::temp_dir().join(format!("agent-grid-repository-{}", short_id()));
        fs::create_dir_all(repository.join("src")).unwrap();
        fs::create_dir_all(repository.join("node_modules/package")).unwrap();
        fs::write(repository.join("README.md"), "# Test\n").unwrap();
        fs::write(repository.join("src/lib.rs"), "pub fn ready() {}\n").unwrap();
        fs::write(repository.join("Dockerfile"), "FROM scratch\n").unwrap();
        fs::write(
            repository.join("node_modules/package/index.js"),
            "generated\n",
        )
        .unwrap();

        let listing = list_repository_path(&repository).unwrap();
        assert!(!listing.truncated);
        assert!(listing
            .entries
            .iter()
            .any(|entry| entry.path == "README.md" && entry.documentation));
        assert!(listing
            .entries
            .iter()
            .any(|entry| entry.path == "src/lib.rs" && !entry.is_directory));
        assert!(listing
            .entries
            .iter()
            .any(|entry| entry.path == "Dockerfile" && !entry.is_directory));
        assert!(!listing
            .entries
            .iter()
            .any(|entry| entry.path.starts_with("node_modules")));

        let file = read_repository_path(&repository, "README.md").unwrap();
        assert_eq!(file.content, "# Test\n");
        assert!(file.documentation);
        assert!(read_repository_path(&repository, "../outside").is_err());
        let _ = fs::remove_dir_all(repository);
    }
}
