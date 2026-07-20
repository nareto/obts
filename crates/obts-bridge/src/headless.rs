use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

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

const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone)]
pub struct HeadlessClient {
    inner: Arc<Mutex<HeadlessProcess>>,
    next_id: Arc<AtomicU64>,
    state: Arc<RwLock<Value>>,
    healthy: Arc<AtomicBool>,
    config: Arc<ClientConfig>,
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
    pub content_sha256: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct HeadlessIndexChange {
    pub path: String,
    pub kind: String,
    pub oid: Option<String>,
    pub content_sha256: Option<String>,
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
        mut self,
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

    pub async fn lock_filesystem(&self) -> Result<HeadlessFilesystemGuard<'_>, HeadlessError> {
        if !self.healthy.load(Ordering::Acquire) {
            return Err(HeadlessError::Unavailable);
        }
        let mut process = match timeout(REQUEST_TIMEOUT, self.inner.lock()).await {
            Ok(process) => process,
            Err(_) => {
                self.healthy.store(false, Ordering::Release);
                return Err(HeadlessError::Timeout);
            }
        };
        match process.child.try_wait() {
            Ok(None) => Ok(HeadlessFilesystemGuard { process }),
            Ok(Some(_)) => {
                self.healthy.store(false, Ordering::Release);
                Err(HeadlessError::Exited)
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
        info!(state = %redact_state(&ready), "headless client restarted");
        Ok(())
    }

    pub async fn request(&self, command: &str, arguments: Value) -> Result<Value, HeadlessError> {
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
            .map_err(|_| HeadlessError::Timeout)?;
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
    if process.child.try_wait()?.is_some() {
        return Err(HeadlessError::Exited);
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
        let line = process
            .stdout
            .next_line()
            .await?
            .ok_or(HeadlessError::Exited)?;
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
            let mut restart = false;
            match client.request("poll-remote-events", Value::Null).await {
                Ok(result) => {
                    if result.get("applied").and_then(Value::as_bool) == Some(true) {
                        filesystem.mark_dirty();
                    }
                }
                Err(error) if !error.is_unpaired() => {
                    restart = error.is_process_failure();
                    warn!(error = %error, "headless remote event poll failed");
                }
                Err(_) => {}
            }
            if !restart {
                match client.request("sync-once", Value::Null).await {
                    Ok(_) => {
                        if client.local_head() != filesystem.indexed_commit() {
                            filesystem.mark_dirty();
                        }
                    }
                    Err(error) if !error.is_unpaired() => {
                        restart = error.is_process_failure();
                        warn!(error = %error, "headless local sync failed");
                    }
                    Err(_) => {}
                }
            }
            if restart && let Err(error) = client.restart().await {
                warn!(error = %error, "headless client restart failed");
            }
            sleep(interval).await;
        }
    })
}

async fn read_until_event(
    process: &mut HeadlessProcess,
    event: &str,
) -> Result<Value, HeadlessError> {
    loop {
        let line = process
            .stdout
            .next_line()
            .await?
            .ok_or(HeadlessError::Exited)?;
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
    #[error("headless process exited")]
    Exited,
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
            Self::Exited
                | Self::Io(_)
                | Self::Json(_)
                | Self::Protocol(_)
                | Self::Timeout
                | Self::Unavailable
        )
    }
}
