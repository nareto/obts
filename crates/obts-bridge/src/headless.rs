use std::collections::VecDeque;
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Instant;

use serde::Deserialize;
use serde_json::{Value, json};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, MutexGuard};
use tokio::task::JoinHandle;
use tokio::time::{Duration, sleep, timeout};
use tracing::{info, warn};

use crate::config::ClientConfig;
use crate::filesystem::FilesystemSource;
use crate::store::HeadlessProcessStatus;

const MAX_HEADLESS_MESSAGE_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
pub struct HeadlessClient {
    inner: Arc<Mutex<HeadlessProcess>>,
    next_id: Arc<AtomicU64>,
    state: Arc<RwLock<Value>>,
    healthy: Arc<AtomicBool>,
    config: Arc<ClientConfig>,
    runtime: Arc<RwLock<HeadlessRuntimeState>>,
}

#[derive(Debug, Default)]
struct HeadlessRuntimeState {
    failures: VecDeque<Instant>,
    restart_count: u64,
    unexpected_exits: u64,
    circuit_open: bool,
    recovery_attempts: u64,
    last_counted_exit_pid: Option<u32>,
    last_exit_code: Option<i32>,
    last_exit_signal: Option<i32>,
}

impl std::fmt::Debug for HeadlessClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HeadlessClient")
            .finish_non_exhaustive()
    }
}

struct HeadlessProcess {
    child: Child,
    pid: Option<u32>,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

struct ActiveRequest<'a> {
    process: &'a mut HeadlessProcess,
    healthy: &'a AtomicBool,
    command: String,
    armed: bool,
}

impl<'a> ActiveRequest<'a> {
    fn new(process: &'a mut HeadlessProcess, healthy: &'a AtomicBool, command: &str) -> Self {
        Self {
            process,
            healthy,
            command: command.to_owned(),
            armed: true,
        }
    }

    fn process(&mut self) -> &mut HeadlessProcess {
        self.process
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ActiveRequest<'_> {
    fn drop(&mut self) {
        if self.armed {
            warn!(
                command = %self.command,
                pid = ?self.process.pid,
                "headless request cancelled while in flight; quarantining supervised child"
            );
            let _ = self.process.child.start_kill();
            self.healthy.store(false, Ordering::Release);
        }
    }
}

pub struct HeadlessFilesystemGuard<'a> {
    process: MutexGuard<'a, HeadlessProcess>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HeadlessIndexDelta {
    pub head: Option<String>,
    pub base: Option<String>,
    pub mode: String,
    pub files: Vec<HeadlessIndexFile>,
    pub changes: Vec<HeadlessIndexChange>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HeadlessIndexFile {
    pub path: String,
    pub oid: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HeadlessIndexChange {
    pub path: String,
    pub kind: String,
    pub oid: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HeadlessIndexDeltaPage {
    head: Option<String>,
    base: Option<String>,
    mode: String,
    files: Vec<HeadlessIndexFile>,
    changes: Vec<HeadlessIndexChange>,
    next_cursor: Option<usize>,
    total_files: usize,
    total_changes: usize,
}

impl HeadlessFilesystemGuard<'_> {
    pub async fn read_index_delta(
        &mut self,
        client: &HeadlessClient,
        from_commit: Option<&str>,
    ) -> Result<HeadlessIndexDelta, HeadlessError> {
        let result = async {
            let mut cursor = 0usize;
            let mut combined: Option<HeadlessIndexDelta> = None;
            let mut expected_totals: Option<(usize, usize)> = None;
            loop {
                let mut arguments = json!({ "cursor": cursor });
                if let Some(commit) = from_commit {
                    arguments["fromCommit"] = json!(commit);
                }
                let value = supervised_request_on_process(
                    &mut self.process,
                    &client.next_id,
                    &client.state,
                    "read-index-delta",
                    arguments,
                    client.inactivity_timeout(),
                    &client.healthy,
                )
                .await?;
                let page: HeadlessIndexDeltaPage = serde_json::from_value(value)?;
                let page_entries = page.files.len() + page.changes.len();
                let totals = (page.total_files, page.total_changes);
                if expected_totals.get_or_insert(totals) != &totals {
                    return Err(HeadlessError::Protocol(
                        "read-index-delta page totals changed".to_owned(),
                    ));
                }
                let delta = combined.get_or_insert_with(|| HeadlessIndexDelta {
                    head: page.head.clone(),
                    base: page.base.clone(),
                    mode: page.mode.clone(),
                    files: Vec::new(),
                    changes: Vec::new(),
                });
                if delta.head != page.head || delta.base != page.base || delta.mode != page.mode {
                    return Err(HeadlessError::Protocol(
                        "read-index-delta page identity changed".to_owned(),
                    ));
                }
                delta.files.extend(page.files);
                delta.changes.extend(page.changes);
                match page.next_cursor {
                    Some(next) if next == cursor + page_entries => cursor = next,
                    Some(_) => {
                        return Err(HeadlessError::Protocol(
                            "read-index-delta cursor did not advance".to_owned(),
                        ));
                    }
                    None if delta.files.len() == page.total_files
                        && delta.changes.len() == page.total_changes =>
                    {
                        break;
                    }
                    None => {
                        return Err(HeadlessError::Protocol(
                            "read-index-delta ended before the declared inventory".to_owned(),
                        ));
                    }
                }
            }
            combined.ok_or_else(|| HeadlessError::Protocol("empty index inventory".to_owned()))
        }
        .await;
        match result {
            Ok(delta) => {
                client.healthy.store(true, Ordering::Release);
                Ok(delta)
            }
            Err(error) => {
                if error.is_process_failure() {
                    quarantine_process(&mut self.process).await;
                    client.healthy.store(false, Ordering::Release);
                }
                Err(error)
            }
        }
    }

    pub async fn notify_local_change(
        &mut self,
        client: &HeadlessClient,
        path: &str,
    ) -> Result<Value, HeadlessError> {
        let inactivity_timeout = client.inactivity_timeout();
        let result = async {
            supervised_request_on_process(
                &mut self.process,
                &client.next_id,
                &client.state,
                "record-local-change",
                json!({ "paths": [path] }),
                inactivity_timeout,
                &client.healthy,
            )
            .await?;
            supervised_request_on_process(
                &mut self.process,
                &client.next_id,
                &client.state,
                "sync-once",
                Value::Null,
                inactivity_timeout,
                &client.healthy,
            )
            .await
        }
        .await;
        match result {
            Ok(value) => {
                client.healthy.store(true, Ordering::Release);
                Ok(value)
            }
            Err(error) => {
                if error.is_process_failure() {
                    quarantine_process(&mut self.process).await;
                    client.healthy.store(false, Ordering::Release);
                }
                Err(error)
            }
        }
    }
}

impl HeadlessClient {
    pub async fn spawn(config: &ClientConfig) -> Result<Self, HeadlessError> {
        let (process, ready) = spawn_process(config).await?;
        info!(state = %redact_state(&ready), "headless client ready");
        Ok(Self {
            inner: Arc::new(Mutex::new(process)),
            next_id: Arc::new(AtomicU64::new(1)),
            state: Arc::new(RwLock::new(ready)),
            healthy: Arc::new(AtomicBool::new(true)),
            config: Arc::new(config.clone()),
            runtime: Arc::new(RwLock::new(HeadlessRuntimeState::default())),
        })
    }

    pub fn is_paired(&self) -> bool {
        if !self.healthy.load(Ordering::Acquire) {
            return false;
        }
        let state = self.state.read().expect("headless state lock");
        state.get("vault_id").is_some_and(|value| !value.is_null())
            && state.get("device_id").is_some_and(|value| !value.is_null())
    }

    pub fn local_head(&self) -> Option<String> {
        self.state
            .read()
            .expect("headless state lock")
            .get("local_head")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    }

    pub fn runtime_status(&self) -> HeadlessProcessStatus {
        let runtime = self.runtime.read().expect("headless runtime lock");
        HeadlessProcessStatus {
            up: self.healthy.load(Ordering::Acquire) && !runtime.circuit_open,
            restart_count: runtime.restart_count,
            unexpected_exits: runtime.unexpected_exits,
            circuit_open: runtime.circuit_open,
            recovery_attempts: runtime.recovery_attempts,
            last_exit_code: runtime.last_exit_code,
            last_exit_signal: runtime.last_exit_signal,
        }
    }

    fn recovery_cooldown_seconds(&self) -> u64 {
        self.config.restart_recovery_cooldown_seconds.max(1)
    }

    /// Attempt a bounded recovery while the restart circuit is open: replace
    /// the child and clear the circuit plus the failure window. Returns `Ok(false)`
    /// when the circuit is already closed.
    pub async fn recover_circuit(&self) -> Result<bool, HeadlessError> {
        if !self
            .runtime
            .read()
            .expect("headless runtime lock")
            .circuit_open
        {
            return Ok(false);
        }
        {
            let mut runtime = self.runtime.write().expect("headless runtime lock");
            runtime.recovery_attempts = runtime.recovery_attempts.saturating_add(1);
        }
        self.restart().await?;
        {
            let mut runtime = self.runtime.write().expect("headless runtime lock");
            if runtime.circuit_open {
                runtime.circuit_open = false;
                runtime.failures.clear();
            }
        }
        info!("headless restart circuit recovered");
        Ok(true)
    }

    fn inactivity_timeout(&self) -> Duration {
        Duration::from_secs(self.config.request_inactivity_timeout_seconds.max(1))
    }

    fn register_process_failure(&self, error: &HeadlessError) -> Option<Duration> {
        let mut runtime = self.runtime.write().expect("headless runtime lock");
        let backoff = register_failure(&mut runtime, &self.config, error, Instant::now());
        if runtime.circuit_open {
            self.healthy.store(false, Ordering::Release);
        }
        backoff
    }

    fn record_restart(&self) {
        let mut runtime = self.runtime.write().expect("headless runtime lock");
        runtime.restart_count = runtime.restart_count.saturating_add(1);
    }

    pub async fn lock_filesystem(&self) -> Result<HeadlessFilesystemGuard<'_>, HeadlessError> {
        if !self.healthy.load(Ordering::Acquire) {
            return Err(HeadlessError::Unavailable);
        }
        let mut process = timeout(self.inactivity_timeout(), self.inner.lock())
            .await
            .map_err(|_| HeadlessError::Busy)?;
        if !self.healthy.load(Ordering::Acquire) {
            return Err(HeadlessError::Unavailable);
        }
        match process.child.try_wait() {
            Ok(None) => Ok(HeadlessFilesystemGuard { process }),
            Ok(Some(status)) => {
                self.healthy.store(false, Ordering::Release);
                Err(exited_error(status, process.pid))
            }
            Err(error) => {
                self.healthy.store(false, Ordering::Release);
                Err(HeadlessError::Io(error))
            }
        }
    }

    pub async fn restart(&self) -> Result<(), HeadlessError> {
        self.healthy.store(false, Ordering::Release);
        let mut process = timeout(self.inactivity_timeout(), self.inner.lock())
            .await
            .map_err(|_| HeadlessError::Timeout)?;
        if process.child.try_wait()?.is_none() {
            process.child.start_kill()?;
            timeout(Duration::from_secs(10), process.child.wait())
                .await
                .map_err(|_| HeadlessError::Timeout)??;
        }
        let (replacement, ready) = spawn_process(&self.config).await?;
        *process = replacement;
        *self.state.write().expect("headless state lock") = ready.clone();
        self.healthy.store(true, Ordering::Release);
        self.record_restart();
        info!(state = %redact_state(&ready), "headless client restarted");
        Ok(())
    }

    pub async fn request(&self, command: &str, arguments: Value) -> Result<Value, HeadlessError> {
        if self
            .runtime
            .read()
            .expect("headless runtime lock")
            .circuit_open
            || !self.healthy.load(Ordering::Acquire)
        {
            return Err(HeadlessError::Unavailable);
        }
        let result = self.request_inner(command, arguments).await;
        match result {
            Ok(value) => {
                self.healthy.store(true, Ordering::Release);
                Ok(value)
            }
            Err(error) => {
                if error.is_process_failure() {
                    self.healthy.store(false, Ordering::Release);
                }
                Err(error)
            }
        }
    }

    async fn request_inner(&self, command: &str, arguments: Value) -> Result<Value, HeadlessError> {
        let inactivity_timeout = self.inactivity_timeout();
        let mut process = timeout(inactivity_timeout, self.inner.lock())
            .await
            .map_err(|_| HeadlessError::Busy)?;
        if !self.healthy.load(Ordering::Acquire) {
            return Err(HeadlessError::Unavailable);
        }
        let result = supervised_request_on_process(
            &mut process,
            &self.next_id,
            &self.state,
            command,
            arguments,
            inactivity_timeout,
            &self.healthy,
        )
        .await;
        if result
            .as_ref()
            .is_err_and(|error| error.is_process_failure())
        {
            warn!(
                command = %command,
                error = %result.as_ref().err().map(ToString::to_string).unwrap_or_default(),
                "headless request failed; quarantining supervised child"
            );
            quarantine_process(&mut process).await;
        }
        result
    }

    pub async fn refresh_state(&self) -> Result<Value, HeadlessError> {
        self.request("read-state", Value::Null).await
    }

    pub async fn notify_local_change(&self, path: &str) -> Result<Value, HeadlessError> {
        self.request("record-local-change", json!({ "paths": [path] }))
            .await?;
        self.request("sync-once", Value::Null).await
    }
}

fn register_failure(
    runtime: &mut HeadlessRuntimeState,
    config: &ClientConfig,
    error: &HeadlessError,
    now: Instant,
) -> Option<Duration> {
    let window = Duration::from_secs(config.restart_failure_window_seconds.max(1));
    while runtime
        .failures
        .front()
        .is_some_and(|failure| now.duration_since(*failure) > window)
    {
        runtime.failures.pop_front();
    }
    runtime.failures.push_back(now);
    if let HeadlessError::Exited {
        pid, code, signal, ..
    } = error
        && runtime.last_counted_exit_pid != *pid
    {
        runtime.unexpected_exits = runtime.unexpected_exits.saturating_add(1);
        runtime.last_counted_exit_pid = *pid;
        runtime.last_exit_code = *code;
        runtime.last_exit_signal = *signal;
    }
    if runtime.failures.len() >= config.restart_max_failures as usize {
        runtime.circuit_open = true;
        return None;
    }
    let exponent = runtime.failures.len().saturating_sub(1).min(10) as u32;
    let delay = config
        .restart_base_backoff_seconds
        .max(1)
        .saturating_mul(2_u64.saturating_pow(exponent))
        .min(config.restart_max_backoff_seconds.max(1));
    Some(Duration::from_secs(delay))
}

async fn quarantine_process(process: &mut HeadlessProcess) {
    if process.child.try_wait().ok().flatten().is_none() {
        let _ = process.child.start_kill();
        let _ = timeout(Duration::from_secs(10), process.child.wait()).await;
    }
}

async fn supervised_request_on_process(
    process: &mut HeadlessProcess,
    next_id: &AtomicU64,
    state: &RwLock<Value>,
    command: &str,
    arguments: Value,
    inactivity_timeout: Duration,
    healthy: &AtomicBool,
) -> Result<Value, HeadlessError> {
    let mut active = ActiveRequest::new(process, healthy, command);
    let result = request_on_process(
        active.process(),
        next_id,
        state,
        command,
        arguments,
        inactivity_timeout,
    )
    .await;
    active.disarm();
    result
}

async fn request_on_process(
    process: &mut HeadlessProcess,
    next_id: &AtomicU64,
    state: &RwLock<Value>,
    command: &str,
    arguments: Value,
    inactivity_timeout: Duration,
) -> Result<Value, HeadlessError> {
    if let Some(status) = process.child.try_wait()? {
        return Err(exited_error(status, process.pid));
    }
    let id = next_id.fetch_add(1, Ordering::Relaxed);
    let mut request = match arguments {
        Value::Object(map) => map,
        Value::Null => serde_json::Map::new(),
        _ => {
            return Err(HeadlessError::Protocol(
                "request arguments must be an object".to_string(),
            ));
        }
    };
    request.insert("id".to_string(), json!(id));
    request.insert("command".to_string(), json!(command));
    let request_line = serde_json::to_string(&request)?;
    timeout(inactivity_timeout, async {
        process.stdin.write_all(request_line.as_bytes()).await?;
        process.stdin.write_all(b"\n").await?;
        process.stdin.flush().await
    })
    .await
    .map_err(|_| HeadlessError::Timeout)??;

    let mut state_event_seen = false;
    loop {
        let line = timeout(inactivity_timeout, next_process_line(process))
            .await
            .map_err(|_| HeadlessError::Timeout)??;
        let message: Value = serde_json::from_str(&line)?;
        match message.get("type").and_then(Value::as_str) {
            Some("event") => match message.get("event").and_then(Value::as_str) {
                Some("progress") if is_valid_progress_event(&message) => continue,
                Some("state")
                    if !state_event_seen
                        && has_exact_keys(&message, &["type", "event", "state"])
                        && message.get("state").is_some_and(is_valid_state) =>
                {
                    state_event_seen = true;
                    *state.write().expect("headless state lock") = message["state"].clone();
                    continue;
                }
                _ => {
                    return Err(HeadlessError::Protocol(
                        "headless client emitted an invalid event".to_string(),
                    ));
                }
            },
            Some("fatal") if is_valid_fatal_message(&message) => {
                return Err(protocol_fatal_error(&message));
            }
            Some("response") => {}
            _ => {
                return Err(HeadlessError::Protocol(
                    "headless client emitted an unknown message".to_string(),
                ));
            }
        }
        if message.get("id").and_then(Value::as_u64) != Some(id) {
            return Err(HeadlessError::Protocol(
                "headless client response id did not match the request".to_string(),
            ));
        }
        match message.get("ok").and_then(Value::as_bool) {
            Some(true) if has_exact_keys(&message, &["type", "id", "ok", "result"]) => {
                let result = message.get("result").cloned().expect("validated result");
                if command == "read-state" {
                    if !is_valid_state(&result) {
                        return Err(HeadlessError::Protocol(
                            "headless client returned an invalid state".to_string(),
                        ));
                    }
                    *state.write().expect("headless state lock") = result.clone();
                } else if command == "maintenance-tick" {
                    let mut cached = state.write().expect("headless state lock");
                    if let Some(local_head) = result.get("local_head") {
                        cached["local_head"] = local_head.clone();
                    }
                    if let Some(status) = result.get("status") {
                        cached["status_label"] = status.clone();
                    }
                }
                return Ok(result);
            }
            Some(false) if is_valid_error_response(&message) => {
                return Err(HeadlessError::Remote {
                    code: message["error"]["code"]
                        .as_str()
                        .expect("validated code")
                        .to_string(),
                    message: message["error"]["message"]
                        .as_str()
                        .expect("validated message")
                        .to_string(),
                });
            }
            Some(true) | Some(false) => {
                return Err(HeadlessError::Protocol(
                    "headless client response is malformed".to_string(),
                ));
            }
            None => {
                return Err(HeadlessError::Protocol(
                    "headless client response is missing its result status".to_string(),
                ));
            }
        }
    }
}

fn has_exact_keys(message: &Value, expected: &[&str]) -> bool {
    let Some(object) = message.as_object() else {
        return false;
    };
    object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
}

fn is_valid_progress_event(message: &Value) -> bool {
    has_exact_keys(message, &["type", "event", "status", "diagnosticPoint"])
        && message
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| !status.is_empty() && status.len() <= 512)
        && message
            .get("diagnosticPoint")
            .and_then(Value::as_str)
            .is_some_and(|point| !point.is_empty() && point.len() <= 128)
}

fn is_valid_state(value: &Value) -> bool {
    let Some(state) = value.as_object() else {
        return false;
    };
    const ALLOWED_KEYS: &[&str] = &[
        "user_id",
        "vault_id",
        "device_id",
        "device_name",
        "device_ref",
        "server_device_ref",
        "local_main",
        "local_head",
        "initial_import_confirmed",
        "status_label",
        "last_error_code",
        "last_error_details",
        "last_event_seq",
        "last_applied_event_seq",
        "unpaired_baseline_vault_id",
        "unpaired_baseline_main",
        "updated_at",
    ];
    if state
        .keys()
        .any(|key| !ALLOWED_KEYS.contains(&key.as_str()))
    {
        return false;
    }
    [
        "user_id",
        "vault_id",
        "device_id",
        "device_ref",
        "server_device_ref",
        "local_main",
        "local_head",
        "last_error_code",
    ]
    .iter()
    .all(|key| {
        state
            .get(*key)
            .is_some_and(|field| field.is_null() || field.is_string())
    }) && [
        "device_name",
        "unpaired_baseline_vault_id",
        "unpaired_baseline_main",
    ]
    .iter()
    .all(|key| {
        state
            .get(*key)
            .is_none_or(|field| field.is_null() || field.is_string())
    }) && state
        .get("last_error_details")
        .is_none_or(|field| field.is_null() || field.is_object())
        && state
            .get("initial_import_confirmed")
            .and_then(Value::as_bool)
            .is_some()
        && state
            .get("status_label")
            .and_then(Value::as_str)
            .is_some_and(|label| !label.is_empty() && label.len() <= 512)
        && state
            .get("last_event_seq")
            .and_then(Value::as_u64)
            .is_some()
        && state
            .get("last_applied_event_seq")
            .and_then(Value::as_u64)
            .is_some()
        && state
            .get("updated_at")
            .and_then(Value::as_str)
            .is_some_and(|timestamp| !timestamp.is_empty() && timestamp.len() <= 128)
}

fn is_valid_protocol_error(message: &Value) -> bool {
    let Some(error) = message.get("error").and_then(Value::as_object) else {
        return false;
    };
    error.len() == 2
        && error
            .get("code")
            .and_then(Value::as_str)
            .is_some_and(|code| !code.is_empty() && code.len() <= 128)
        && error
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|detail| !detail.is_empty() && detail.len() <= 4096)
}

fn is_valid_error_response(message: &Value) -> bool {
    has_exact_keys(message, &["type", "id", "ok", "error"]) && is_valid_protocol_error(message)
}

fn is_valid_fatal_message(message: &Value) -> bool {
    has_exact_keys(message, &["type", "error"]) && is_valid_protocol_error(message)
}

fn protocol_fatal_error(message: &Value) -> HeadlessError {
    HeadlessError::Protocol(
        message["error"]["message"]
            .as_str()
            .expect("validated fatal message")
            .to_string(),
    )
}

async fn spawn_process(config: &ClientConfig) -> Result<(HeadlessProcess, Value), HeadlessError> {
    let parts = shell_words::split(&config.headless_command)
        .map_err(|error| HeadlessError::Command(error.to_string()))?;
    let (program, arguments) = parts
        .split_first()
        .ok_or_else(|| HeadlessError::Command("headless command is empty".to_string()))?;
    let mut command = Command::new(program);
    command
        .args(arguments)
        .arg("--vault-dir")
        .arg(&config.vault_dir)
        .arg("--server-url")
        .arg(&config.server_url)
        .arg("--device-name")
        .arg(&config.device_name)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let stdin = child
        .stdin
        .take()
        .ok_or(HeadlessError::MissingPipe("stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or(HeadlessError::MissingPipe("stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or(HeadlessError::MissingPipe("stderr"))?;
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            warn!(message = %line, "headless client stderr");
        }
    });

    let mut process = HeadlessProcess {
        pid: child.id(),
        child,
        stdin,
        stdout: BufReader::new(stdout),
    };
    let ready = read_until_event(
        &mut process,
        "ready",
        Duration::from_secs(config.request_inactivity_timeout_seconds.max(1)),
    )
    .await?;
    Ok((process, ready))
}

pub fn spawn_maintenance(
    client: HeadlessClient,
    filesystem: Arc<FilesystemSource>,
    interval: Duration,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let cooldown = Duration::from_secs(client.recovery_cooldown_seconds());
        let mut next_recovery_at: Option<Instant> = None;
        loop {
            if client.runtime_status().circuit_open {
                let now = Instant::now();
                let due = match next_recovery_at {
                    Some(due) => due,
                    None => {
                        let due = now + cooldown;
                        next_recovery_at = Some(due);
                        due
                    }
                };
                if now >= due {
                    match client.recover_circuit().await {
                        Ok(_) => {
                            next_recovery_at = None;
                        }
                        Err(error) => {
                            warn!(error = %error, "headless circuit recovery failed");
                            next_recovery_at = Some(now + cooldown);
                        }
                    }
                }
                sleep(interval).await;
                continue;
            }
            next_recovery_at = None;
            match client.request("maintenance-tick", Value::Null).await {
                Ok(result) => {
                    let applied = result.get("applied").and_then(Value::as_bool) == Some(true);
                    let local_head = result.get("local_head").and_then(Value::as_str);
                    if applied || local_head != filesystem.indexed_commit().as_deref() {
                        filesystem.mark_dirty();
                    }
                }
                Err(error) if error.is_unpaired() => {}
                Err(error) if error.is_process_failure() => {
                    warn!(error = %error, "headless maintenance failed");
                    match client.register_process_failure(&error) {
                        Some(backoff) => {
                            sleep(backoff).await;
                            if let Err(restart_error) = client.restart().await {
                                warn!(error = %restart_error, "headless client restart failed");
                            }
                        }
                        None => {
                            warn!("headless restart circuit opened after repeated failures");
                        }
                    }
                }
                Err(error) => warn!(error = %error, "headless maintenance failed"),
            }
            sleep(interval).await;
        }
    })
}

async fn next_process_line(process: &mut HeadlessProcess) -> Result<String, HeadlessError> {
    let mut bytes = Vec::new();
    loop {
        let available = process.stdout.fill_buf().await?;
        if available.is_empty() {
            if !bytes.is_empty() {
                return Err(HeadlessError::Protocol(
                    "headless client closed an unterminated JSON-line message".to_string(),
                ));
            }
            return Err(process
                .child
                .try_wait()?
                .map(|status| exited_error(status, process.pid))
                .unwrap_or(HeadlessError::Exited {
                    pid: process.pid,
                    code: None,
                    signal: None,
                }));
        }
        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            if bytes.len().saturating_add(newline) > MAX_HEADLESS_MESSAGE_BYTES {
                return Err(HeadlessError::Protocol(
                    "headless client message exceeded the byte limit".to_string(),
                ));
            }
            bytes.extend_from_slice(&available[..newline]);
            process.stdout.consume(newline + 1);
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            return std::str::from_utf8(&bytes)
                .map(ToOwned::to_owned)
                .map_err(|_| {
                    HeadlessError::Protocol("headless client emitted non-UTF-8 output".to_string())
                });
        }
        if bytes.len().saturating_add(available.len()) > MAX_HEADLESS_MESSAGE_BYTES {
            return Err(HeadlessError::Protocol(
                "headless client message exceeded the byte limit".to_string(),
            ));
        }
        let consumed = available.len();
        bytes.extend_from_slice(available);
        process.stdout.consume(consumed);
    }
}

fn exited_error(status: ExitStatus, pid: Option<u32>) -> HeadlessError {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        HeadlessError::Exited {
            pid,
            code: status.code(),
            signal: status.signal(),
        }
    }
    #[cfg(not(unix))]
    {
        HeadlessError::Exited {
            pid,
            code: status.code(),
            signal: None,
        }
    }
}

async fn read_until_event(
    process: &mut HeadlessProcess,
    event: &str,
    inactivity_timeout: Duration,
) -> Result<Value, HeadlessError> {
    loop {
        let line = timeout(inactivity_timeout, next_process_line(process))
            .await
            .map_err(|_| HeadlessError::Timeout)??;
        let message: Value = serde_json::from_str(&line)?;
        match message.get("type").and_then(Value::as_str) {
            Some("fatal") if is_valid_fatal_message(&message) => {
                return Err(protocol_fatal_error(&message));
            }
            Some("event")
                if message.get("event").and_then(Value::as_str) == Some(event)
                    && has_exact_keys(&message, &["type", "event", "state"])
                    && message.get("state").is_some_and(is_valid_state) =>
            {
                return Ok(message["state"].clone());
            }
            Some("event")
                if message.get("event").and_then(Value::as_str) == Some("progress")
                    && is_valid_progress_event(&message) => {}
            _ => {
                return Err(HeadlessError::Protocol(
                    "headless client emitted an invalid startup message".to_string(),
                ));
            }
        }
    }
}

fn redact_state(state: &Value) -> Value {
    json!({
        "vault_id": state.get("vault_id"),
        "device_id": state.get("device_id"),
        "status_label": state.get("status_label"),
        "last_error_code": state.get("last_error_code")
    })
}

impl Drop for HeadlessProcess {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

#[derive(Debug, Error)]
pub enum HeadlessError {
    #[error("invalid headless command: {0}")]
    Command(String),
    #[error("headless process is missing {0}")]
    MissingPipe(&'static str),
    #[error("headless process exited (pid={pid:?}, code={code:?}, signal={signal:?})")]
    Exited {
        pid: Option<u32>,
        code: Option<i32>,
        signal: Option<i32>,
    },
    #[error("headless process is busy with another bounded operation")]
    Busy,
    #[error("headless protocol failed: {0}")]
    Protocol(String),
    #[error("headless command timed out")]
    Timeout,
    #[error("headless process is unavailable pending restart")]
    Unavailable,
    #[error("headless command failed ({code}): {message}")]
    Remote { code: String, message: String },
    #[error("headless I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("headless JSON failed: {0}")]
    Json(#[from] serde_json::Error),
}

impl HeadlessError {
    fn is_unpaired(&self) -> bool {
        matches!(self, Self::Remote { code, .. } if code == "not_paired" || code == "onboarding_incomplete")
    }

    fn is_process_failure(&self) -> bool {
        matches!(
            self,
            Self::Exited { .. }
                | Self::Io(_)
                | Self::Json(_)
                | Self::Protocol(_)
                | Self::Timeout
                | Self::Unavailable
        )
    }
}

#[cfg(test)]
mod tests {
    use std::fs::write;
    use std::process::Stdio;
    use std::sync::atomic::AtomicU64;
    use std::sync::{Arc, RwLock};
    use std::time::{Duration, Instant};

    use serde_json::{Value, json};
    use tempfile::tempdir;
    use tokio::io::BufReader;
    use tokio::process::Command;

    use crate::config::ClientConfig;
    use crate::filesystem::FilesystemSource;

    use super::{
        HeadlessClient, HeadlessError, HeadlessProcess, HeadlessRuntimeState, register_failure,
        request_on_process, spawn_maintenance,
    };

    fn valid_state() -> Value {
        json!({
            "user_id": null,
            "vault_id": null,
            "device_id": null,
            "device_ref": null,
            "server_device_ref": null,
            "local_main": null,
            "local_head": null,
            "initial_import_confirmed": false,
            "status_label": "Checking",
            "last_error_code": null,
            "last_event_seq": 0,
            "last_applied_event_seq": 0,
            "updated_at": "2026-09-22T00:00:00.000Z"
        })
    }

    fn ready_line() -> String {
        json!({ "type": "event", "event": "ready", "state": valid_state() }).to_string()
    }

    async fn scripted_process(script: &str) -> HeadlessProcess {
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command.spawn().expect("spawn scripted headless process");
        let pid = child.id();
        let stdin = child.stdin.take().expect("script stdin");
        let stdout = child.stdout.take().expect("script stdout");
        HeadlessProcess {
            child,
            pid,
            stdin,
            stdout: BufReader::new(stdout),
        }
    }

    #[test]
    fn repeated_process_failures_back_off_and_open_the_circuit() {
        let config = ClientConfig {
            restart_max_failures: 3,
            restart_base_backoff_seconds: 2,
            restart_max_backoff_seconds: 30,
            ..ClientConfig::default()
        };
        let mut runtime = HeadlessRuntimeState::default();
        let start = Instant::now();
        let error = HeadlessError::Exited {
            pid: Some(42),
            code: None,
            signal: Some(9),
        };

        assert_eq!(
            register_failure(&mut runtime, &config, &error, start),
            Some(Duration::from_secs(2))
        );
        assert_eq!(
            register_failure(
                &mut runtime,
                &config,
                &error,
                start + Duration::from_secs(1),
            ),
            Some(Duration::from_secs(4))
        );
        assert_eq!(
            register_failure(
                &mut runtime,
                &config,
                &error,
                start + Duration::from_secs(2),
            ),
            None
        );
        assert!(runtime.circuit_open);
        assert_eq!(runtime.unexpected_exits, 1);
        assert_eq!(runtime.last_exit_signal, Some(9));
    }

    #[test]
    fn business_errors_do_not_qualify_as_process_failures() {
        let error = HeadlessError::Remote {
            code: "not_paired".to_string(),
            message: "not paired".to_string(),
        };
        assert!(error.is_unpaired());
        assert!(!error.is_process_failure());
        assert!(!HeadlessError::Busy.is_process_failure());
    }

    #[tokio::test]
    async fn progress_events_reset_request_inactivity_timeout() {
        let mut process = scripted_process(
            r#"read -r _
            sleep 0.03
            printf '%s\n' '{"type":"event","event":"progress","status":"one","diagnosticPoint":"sync_download"}'
            sleep 0.03
            printf '%s\n' '{"type":"event","event":"progress","status":"two","diagnosticPoint":"sync_download"}'
            sleep 0.03
            printf '%s\n' '{"type":"response","id":1,"ok":true,"result":{"status":"done"}}'"#,
        )
        .await;
        let started = Instant::now();
        let result = request_on_process(
            &mut process,
            &AtomicU64::new(1),
            &RwLock::new(Value::Null),
            "long-command",
            Value::Null,
            Duration::from_millis(50),
        )
        .await
        .expect("progress should keep the request alive");

        assert!(started.elapsed() >= Duration::from_millis(75));
        assert_eq!(result, json!({ "status": "done" }));
    }

    #[tokio::test]
    async fn silent_request_exceeds_inactivity_timeout() {
        let mut process = scripted_process(
            r#"read -r _
            sleep 0.10
            printf '%s\n' '{"type":"response","id":1,"ok":true,"result":null}'"#,
        )
        .await;
        let error = request_on_process(
            &mut process,
            &AtomicU64::new(1),
            &RwLock::new(Value::Null),
            "silent-command",
            Value::Null,
            Duration::from_millis(25),
        )
        .await
        .expect_err("silence should time out");

        assert!(matches!(error, HeadlessError::Timeout));
    }

    #[tokio::test]
    async fn invalid_protocol_traffic_fails_instead_of_renewing_activity() {
        let mut process = scripted_process(
            r#"read -r _
            printf '%s\n' '{}'
            sleep 0.10"#,
        )
        .await;
        let error = request_on_process(
            &mut process,
            &AtomicU64::new(1),
            &RwLock::new(Value::Null),
            "invalid-command",
            Value::Null,
            Duration::from_millis(50),
        )
        .await
        .expect_err("unknown messages must fail the protocol");

        assert!(matches!(error, HeadlessError::Protocol(_)));
    }

    #[tokio::test]
    async fn malformed_recognized_messages_fail_the_protocol() {
        for message in [
            r#"{"type":"event","event":"state","state":{}}"#,
            r#"{"type":"event","event":"state","state":{"user_id":null,"vault_id":null,"device_id":null,"device_ref":null,"server_device_ref":null,"local_main":null,"local_head":null,"initial_import_confirmed":false,"status_label":"Checking","last_error_code":null,"last_event_seq":0,"last_applied_event_seq":0,"updated_at":"2026-01-01T00:00:00.000Z","extra":"payload"}}"#,
            r#"{"type":"event","event":"progress","status":"active","diagnosticPoint":"sync","extra":"payload"}"#,
            r#"{"type":"response","id":1,"ok":true}"#,
        ] {
            let mut process =
                scripted_process(&format!("read -r _\nprintf '%s\\n' '{message}'")).await;
            let error = request_on_process(
                &mut process,
                &AtomicU64::new(1),
                &RwLock::new(Value::Null),
                "invalid-command",
                Value::Null,
                Duration::from_millis(250),
            )
            .await
            .expect_err("malformed recognized traffic must fail");
            assert!(matches!(error, HeadlessError::Protocol(_)));
        }
    }

    #[tokio::test]
    async fn unterminated_response_at_eof_fails_closed() {
        let mut process = scripted_process(
            r#"read -r _
printf '%s' '{"type":"response","id":1,"ok":true,"result":null}'"#,
        )
        .await;
        let error = request_on_process(
            &mut process,
            &AtomicU64::new(1),
            &RwLock::new(Value::Null),
            "unterminated-command",
            Value::Null,
            Duration::from_secs(1),
        )
        .await
        .expect_err("unterminated output must not complete a request");
        assert!(matches!(error, HeadlessError::Protocol(_)));
    }

    #[tokio::test]
    async fn oversized_stdout_frame_fails_before_unbounded_accumulation() {
        let mut process = scripted_process(
            r#"read -r _
dd if=/dev/zero bs=1048577 count=1 2>/dev/null | tr '\000' x
sleep 1"#,
        )
        .await;
        let error = request_on_process(
            &mut process,
            &AtomicU64::new(1),
            &RwLock::new(Value::Null),
            "oversized-command",
            Value::Null,
            Duration::from_secs(2),
        )
        .await
        .expect_err("oversized child frames must fail");
        assert!(matches!(error, HeadlessError::Protocol(_)));
    }

    #[tokio::test]
    async fn startup_progress_resets_the_inactivity_timeout() {
        let directory = tempdir().expect("temporary script directory");
        let script_path = directory.path().join("startup-progress.sh");
        write(
            &script_path,
            format!(
                r#"sleep 0.60
printf '%s\n' '{{"type":"event","event":"progress","status":"recovering one","diagnosticPoint":"startup_recovery"}}'
sleep 0.60
printf '%s\n' '{{"type":"event","event":"progress","status":"recovering two","diagnosticPoint":"startup_recovery"}}'
sleep 0.60
printf '%s\n' '{ready}'
"#,
                ready = ready_line()
            ),
        )
        .expect("write startup script");
        let config = ClientConfig {
            headless_command: format!("sh {}", script_path.display()),
            vault_dir: directory.path().join("vault").display().to_string(),
            request_inactivity_timeout_seconds: 1,
            ..ClientConfig::default()
        };
        let started = Instant::now();
        let client = HeadlessClient::spawn(&config)
            .await
            .expect("startup progress should keep the child alive");

        assert!(started.elapsed() >= Duration::from_millis(1_500));
        assert!(client.runtime_status().up);
    }

    #[tokio::test]
    async fn supervised_timeout_quarantines_and_restart_recovers() {
        let directory = tempdir().expect("temporary script directory");
        let script_path = directory.path().join("restart.sh");
        let counter_path = directory.path().join("started");
        write(
            &script_path,
            format!(
                r#"if [ ! -f '{counter}' ]; then
  : > '{counter}'
  printf '%s\n' '{ready}'
  read -r _
  sleep 5
else
  printf '%s\n' '{ready}'
  read -r _
  printf '%s\n' '{{"type":"response","id":2,"ok":true,"result":{{"status":"recovered"}}}}'
fi
"#,
                counter = counter_path.display(),
                ready = ready_line()
            ),
        )
        .expect("write restart script");
        let config = ClientConfig {
            headless_command: format!("sh {}", script_path.display()),
            vault_dir: directory.path().join("vault").display().to_string(),
            request_inactivity_timeout_seconds: 1,
            ..ClientConfig::default()
        };
        let client = HeadlessClient::spawn(&config).await.expect("spawn client");

        let error = client
            .request("long-command", Value::Null)
            .await
            .expect_err("silent child should time out");
        assert!(matches!(error, HeadlessError::Timeout));
        assert!(!client.runtime_status().up);

        client.restart().await.expect("restart quarantined child");
        let result = client
            .request("long-command", Value::Null)
            .await
            .expect("replacement child should answer");
        assert_eq!(result, json!({ "status": "recovered" }));
        assert_eq!(client.runtime_status().restart_count, 1);
    }

    #[tokio::test]
    async fn read_index_delta_reassembles_bounded_pages() {
        let directory = tempdir().expect("temporary script directory");
        let script_path = directory.path().join("paged-index.sh");
        write(
            &script_path,
            format!(
                r#"printf '%s\n' '{ready}'
read -r _
printf '%s\n' '{{"type":"response","id":1,"ok":true,"result":{{"head":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","base":null,"mode":"rebuild","files":[{{"path":"one.md","oid":"1111111111111111111111111111111111111111"}}],"changes":[],"next_cursor":1,"total_files":2,"total_changes":0}}}}'
read -r _
printf '%s\n' '{{"type":"response","id":2,"ok":true,"result":{{"head":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","base":null,"mode":"rebuild","files":[{{"path":"two.md","oid":"2222222222222222222222222222222222222222"}}],"changes":[],"next_cursor":null,"total_files":2,"total_changes":0}}}}'
sleep 5
"#,
                ready = ready_line()
            ),
        )
        .expect("write paged index script");
        let config = ClientConfig {
            headless_command: format!("sh {}", script_path.display()),
            vault_dir: directory.path().join("vault").display().to_string(),
            ..ClientConfig::default()
        };
        let client = HeadlessClient::spawn(&config).await.expect("spawn client");
        let mut guard = client.lock_filesystem().await.expect("filesystem lock");

        let delta = guard
            .read_index_delta(&client, None)
            .await
            .expect("reassemble pages");

        assert_eq!(delta.files.len(), 2);
        assert_eq!(delta.files[0].path, "one.md");
        assert_eq!(delta.files[1].path, "two.md");
    }

    #[tokio::test]
    async fn circuit_recovers_automatically_after_cooldown() {
        let directory = tempdir().expect("temporary script directory");
        let script_path = directory.path().join("circuit-recovery.sh");
        let counter_path = directory.path().join("starts");
        write(
            &script_path,
            format!(
                r#"if [ ! -f '{counter}' ]; then
  : > '{counter}'
  echo 0 > '{counter}'
fi
N=$(( $(cat '{counter}') + 1 ))
echo "$N" > '{counter}'
printf '%s\n' '{ready}'
read -r request
ID=$(printf '%s' "$request" | sed 's/.*"id":\([0-9]*\).*/\1/')
printf '%s\n' "{{\"type\":\"response\",\"id\":$ID,\"ok\":true,\"result\":{{\"applied\":false,\"local_head\":null}}}}"
if [ "$N" -lt 4 ]; then
  exit 0
fi
sleep 5
"#,
                counter = counter_path.display(),
                ready = ready_line()
            ),
        )
        .expect("write circuit recovery script");
        let vault_dir = directory.path().join("vault");
        std::fs::create_dir_all(&vault_dir).expect("create vault directory");
        let config = ClientConfig {
            headless_command: format!("sh {}", script_path.display()),
            vault_dir: vault_dir.display().to_string(),
            request_inactivity_timeout_seconds: 1,
            restart_failure_window_seconds: 900,
            restart_max_failures: 3,
            restart_base_backoff_seconds: 1,
            restart_max_backoff_seconds: 1,
            restart_recovery_cooldown_seconds: 1,
            ..ClientConfig::default()
        };
        let client = HeadlessClient::spawn(&config).await.expect("spawn client");
        let filesystem = Arc::new(FilesystemSource::new(&vault_dir).expect("filesystem source"));
        let maintenance = spawn_maintenance(client.clone(), filesystem, Duration::from_millis(25));
        let recovered = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                if client.runtime_status().up && client.runtime_status().recovery_attempts >= 1 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        maintenance.abort();

        assert!(recovered.is_ok(), "circuit did not recover automatically");
        let status = client.runtime_status();
        assert!(status.up);
        assert!(!status.circuit_open);
        assert!(status.recovery_attempts >= 1);
    }

    #[tokio::test]
    async fn maintenance_supervisor_restarts_a_quarantined_child() {
        let directory = tempdir().expect("temporary script directory");
        let script_path = directory.path().join("automatic-restart.sh");
        let counter_path = directory.path().join("started");
        write(
            &script_path,
            format!(
                r#"if [ ! -f '{counter}' ]; then
  : > '{counter}'
  printf '%s\n' '{ready}'
  read -r _
  sleep 5
else
  printf '%s\n' '{ready}'
  read -r _
  printf '%s\n' '{{"type":"response","id":2,"ok":true,"result":{{"applied":false,"local_head":null}}}}'
  sleep 5
fi
"#,
                counter = counter_path.display(),
                ready = ready_line()
            ),
        )
        .expect("write automatic restart script");
        let vault_dir = directory.path().join("vault");
        std::fs::create_dir_all(&vault_dir).expect("create vault directory");
        let config = ClientConfig {
            headless_command: format!("sh {}", script_path.display()),
            vault_dir: vault_dir.display().to_string(),
            request_inactivity_timeout_seconds: 1,
            restart_base_backoff_seconds: 1,
            restart_max_backoff_seconds: 1,
            ..ClientConfig::default()
        };
        let client = HeadlessClient::spawn(&config).await.expect("spawn client");
        let filesystem = Arc::new(FilesystemSource::new(&vault_dir).expect("filesystem source"));
        let maintenance = spawn_maintenance(client.clone(), filesystem, Duration::from_millis(10));
        let observed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if client.runtime_status().restart_count >= 1 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await;
        maintenance.abort();

        assert!(
            observed.is_ok(),
            "maintenance supervisor did not restart the child"
        );
        assert!(client.runtime_status().up);
    }

    #[tokio::test]
    async fn cancelled_request_quarantines_and_restart_recovers() {
        let directory = tempdir().expect("temporary script directory");
        let script_path = directory.path().join("cancel-restart.sh");
        let counter_path = directory.path().join("started");
        write(
            &script_path,
            format!(
                r#"if [ ! -f '{counter}' ]; then
  : > '{counter}'
  printf '%s\n' '{ready}'
  read -r _
  sleep 5
else
  printf '%s\n' '{ready}'
  read -r _
  printf '%s\n' '{{"type":"response","id":2,"ok":true,"result":{{"status":"recovered"}}}}'
fi
"#,
                counter = counter_path.display(),
                ready = ready_line()
            ),
        )
        .expect("write cancellation script");
        let config = ClientConfig {
            headless_command: format!("sh {}", script_path.display()),
            vault_dir: directory.path().join("vault").display().to_string(),
            request_inactivity_timeout_seconds: 5,
            ..ClientConfig::default()
        };
        let client = HeadlessClient::spawn(&config).await.expect("spawn client");
        let request_client = client.clone();
        let request =
            tokio::spawn(async move { request_client.request("long-command", Value::Null).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        request.abort();
        let _ = request.await;

        assert!(!client.runtime_status().up);
        let quarantined = client
            .request("long-command", Value::Null)
            .await
            .expect_err("quarantined child must reject requests before restart");
        assert!(matches!(quarantined, HeadlessError::Unavailable));
        client.restart().await.expect("restart cancelled child");
        let result = client
            .request("long-command", Value::Null)
            .await
            .expect("replacement child should answer");
        assert_eq!(result, json!({ "status": "recovered" }));
    }
}
