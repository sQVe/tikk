use std::fs::File;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

// Writers wait at most five seconds for the store lock, so the network steps run outside it, and
// each gives up after this long.
pub(crate) const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
const NETWORK_POLL: Duration = Duration::from_millis(20);

pub(crate) struct Finished {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RunFailure {
    TimedOut,
    Failed(String),
}

// Runs the command with no standard input. Output goes to files, not pipes, so a full pipe never
// blocks the wait. Only the child is stopped at the timeout; a program it started may outlive it.
pub(crate) fn run_within(command: &mut Command, timeout: Duration) -> Result<Finished, RunFailure> {
    let program = command.get_program().to_string_lossy().into_owned();
    let mut stdout = capture()?;
    let mut stderr = capture()?;

    command
        .stdin(Stdio::null())
        .stdout(clone_capture(&stdout)?)
        .stderr(clone_capture(&stderr)?);

    let child = command
        .spawn()
        .map_err(|error| RunFailure::Failed(format!("could not start {program}: {error}")))?;
    let status = wait_within(child, &program, timeout)?;

    Ok(Finished {
        status,
        stdout: read_capture(&mut stdout)?,
        stderr: read_capture(&mut stderr)?,
    })
}

fn wait_within(
    mut child: Child,
    program: &str,
    timeout: Duration,
) -> Result<ExitStatus, RunFailure> {
    let deadline = Instant::now() + timeout;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(NETWORK_POLL),
            Ok(None) => return Err(stop(&mut child, program, RunFailure::TimedOut)),
            Err(error) => {
                return Err(stop(
                    &mut child,
                    program,
                    RunFailure::Failed(format!("could not wait for {program}: {error}")),
                ));
            }
        }
    }
}

// Kills and reaps the child. A failure to stop it replaces the reason, since the child may still
// run.
fn stop(child: &mut Child, program: &str, reason: RunFailure) -> RunFailure {
    if let Err(error) = child.kill() {
        return RunFailure::Failed(format!("could not stop {program}: {error}"));
    }

    match child.wait() {
        Ok(_) => reason,
        Err(error) => RunFailure::Failed(format!("could not reap {program}: {error}")),
    }
}

fn capture() -> Result<File, RunFailure> {
    tempfile::tempfile()
        .map_err(|error| RunFailure::Failed(format!("could not capture output: {error}")))
}

fn clone_capture(file: &File) -> Result<File, RunFailure> {
    file.try_clone()
        .map_err(|error| RunFailure::Failed(format!("could not capture output: {error}")))
}

fn read_capture(file: &mut File) -> Result<Vec<u8>, RunFailure> {
    let mut bytes = Vec::new();

    file.seek(SeekFrom::Start(0))
        .and_then(|_| file.read_to_end(&mut bytes))
        .map_err(|error| RunFailure::Failed(format!("could not read the output: {error}")))?;

    Ok(bytes)
}
