use std::collections::VecDeque;
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Instant;

use serde::Deserialize;
use serde_json::{Value, json};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, MutexGuard};
use tokio::task::JoinHandle;
use tokio::time::{Duration, sleep, timeout};
use tracing::{info, warn};

use crate::config::ClientConfig;
use crate::filesystem::FilesystemSource;
use crate::store::HeadlessProcessStatus;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

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
    stdout: Lines<BufReader<ChildStdout>>,
}

pub struct HeadlessFilesystemGuard<'a> {
    process: MutexGuard<'a, HeadlessProcess>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct HeadlessIndexDelta {
    pub head: Option<String>,
    pub base: Option<String>,
    pub mode: String,
    pub files: Vec<HeadlessIndexFile>,
    pub changes: Vec<HeadlessIndexChange>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct HeadlessIndexFile {
    pub path: String,
    pub oid: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct HeadlessIndexChange {
    pub path: String,
    pub kind: String,
    pub oid: Option<String>,
}

impl HeadlessFilesystemGuard<'_> {
    pub async fn read_index_delta(
        &mut self,
        client: &HeadlessClient,
        from_commit: Option<&str>,
    ) -> Result<HeadlessIndexDelta, HeadlessError> {
        let arguments = from_commit
            .map(|commit| json!({ "fromCommit": commit }))
            .unwrap_or(Value::Null);
        let result = timeout(
            REQUEST_TIMEOUT,
            request_on_process(
                &mut self.process,
                &client.next_id,
                &client.state,
                "read-index-delta",
                arguments,
            ),
        )
        .await;
        match result {
            Ok(Ok(value)) => {
                client.healthy.store(true, Ordering::Release);
                serde_json::from_value(value).map_err(HeadlessError::Json)
            }
            Ok(Err(error)) => {
                if error.is_process_failure() {
                    client.healthy.store(false, Ordering::Release);
                }
                Err(error)
            }
            Err(_) => {
                quarantine_process(&mut self.process).await;
                client.healthy.store(false, Ordering::Release);
                Err(HeadlessError::Timeout)
            }
        }
    }

    pub async fn notify_local_change(
        &mut self,
        client: &HeadlessClient,
        path: &str,
    ) -> Result<Value, HeadlessError> {
        let result = timeout(REQUEST_TIMEOUT, async {
            request_on_process(
                &mut self.process,
                &client.next_id,
                &client.state,
                "record-local-change",
                json!({ "paths": [path] }),
            )
            .await?;
            request_on_process(
                &mut self.process,
                &client.next_id,
                &client.state,
                "sync-once",
                Value::Null,
            )
            .await
        })
        .await;
        match result {
            Ok(Ok(value)) => {
                client.healthy.store(true, Ordering::Release);
                Ok(value)
            }
            Ok(Err(error)) => {
                if error.is_process_failure() {
                    client.healthy.store(false, Ordering::Release);
                }
                Err(error)
            }
            Err(_) => {
                quarantine_process(&mut self.process).await;
                client.healthy.store(false, Ordering::Release);
                Err(HeadlessError::Timeout)
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
            last_exit_code: runtime.last_exit_code,
            last_exit_signal: runtime.last_exit_signal,
        }
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
        let mut process = timeout(REQUEST_TIMEOUT, self.inner.lock())
            .await
            .map_err(|_| HeadlessError::Busy)?;
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
        let mut process = timeout(REQUEST_TIMEOUT, self.inner.lock())
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
        let mut process = timeout(REQUEST_TIMEOUT, self.inner.lock())
            .await
            .map_err(|_| HeadlessError::Busy)?;
        let result = timeout(
            REQUEST_TIMEOUT,
            request_on_process(&mut process, &self.next_id, &self.state, command, arguments),
        )
        .await;
        match result {
            Ok(result) => result,
            Err(_) => {
                quarantine_process(&mut process).await;
                Err(HeadlessError::Timeout)
            }
        }
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

async fn request_on_process(
    process: &mut HeadlessProcess,
    next_id: &AtomicU64,
    state: &RwLock<Value>,
    command: &str,
    arguments: Value,
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
    process
        .stdin
        .write_all(serde_json::to_string(&request)?.as_bytes())
        .await?;
    process.stdin.write_all(b"\n").await?;
    process.stdin.flush().await?;

    loop {
        let line = next_process_line(process).await?;
        let message: Value = serde_json::from_str(&line)?;
        if message.get("type").and_then(Value::as_str) == Some("event") {
            if let Some(next_state) = message.get("state") {
                *state.write().expect("headless state lock") = next_state.clone();
            }
            continue;
        }
        if message.get("type").and_then(Value::as_str) != Some("response")
            || message.get("id").and_then(Value::as_u64) != Some(id)
        {
            continue;
        }
        if message.get("ok").and_then(Value::as_bool) == Some(true) {
            let result = message.get("result").cloned().unwrap_or(Value::Null);
            if command == "read-state" {
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
        let code = message
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or("headless_error");
        let detail = message
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("Headless client command failed.");
        return Err(HeadlessError::Remote {
            code: code.to_string(),
            message: detail.to_string(),
        });
    }
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
        stdout: BufReader::new(stdout).lines(),
    };
    let ready = timeout(STARTUP_TIMEOUT, read_until_event(&mut process, "ready"))
        .await
        .map_err(|_| HeadlessError::Timeout)??;
    Ok((process, ready))
}

pub fn spawn_maintenance(
    client: HeadlessClient,
    filesystem: Arc<FilesystemSource>,
    interval: Duration,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            if client.runtime_status().circuit_open {
                sleep(interval).await;
                continue;
            }
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
    match process.stdout.next_line().await? {
        Some(line) => Ok(line),
        None => Err(process
            .child
            .try_wait()?
            .map(|status| exited_error(status, process.pid))
            .unwrap_or(HeadlessError::Exited {
                pid: process.pid,
                code: None,
                signal: None,
            })),
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
) -> Result<Value, HeadlessError> {
    loop {
        let line = next_process_line(process).await?;
        let message: Value = serde_json::from_str(&line)?;
        if message.get("type").and_then(Value::as_str) == Some("fatal") {
            let detail = message
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Headless client failed.");
            return Err(HeadlessError::Protocol(detail.to_string()));
        }
        if message.get("type").and_then(Value::as_str) == Some("event")
            && message.get("event").and_then(Value::as_str) == Some(event)
        {
            return Ok(message.get("state").cloned().unwrap_or(Value::Null));
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
    use std::time::{Duration, Instant};

    use crate::config::ClientConfig;

    use super::{HeadlessError, HeadlessRuntimeState, register_failure};

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
}
