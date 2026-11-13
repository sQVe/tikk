use std::path::Path;

use crate::store::machine::MACHINE_FILE;
use crate::store::store_init::{
    create_staging, ensure_empty, fill_new_store, publish, resolve_store_link, write_file,
};
use crate::store::ticket_files::exists;
use crate::store::{InitOutcome, MachineName, StoreEffects, StoreError, has_config, init, system};

const FACTS_FOLDER: &str = "facts";

#[derive(Clone, Copy)]
pub struct RemoteInitEffects {
    pub run_git: fn(&Path, &[&str]) -> Result<Vec<u8>, StoreError>,
    pub run_network_git: fn(&Path, &[&str]) -> Result<Vec<u8>, StoreError>,
    pub read_host_name: fn() -> Result<String, StoreError>,
}

impl RemoteInitEffects {
    pub fn system() -> Self {
        Self {
            run_git: system::run_store_git,
            run_network_git: system::run_network_git,
            read_host_name: system::read_host_name,
        }
    }
}

enum RemoteState {
    Empty,
    HasMain,
    WithoutMain,
}

pub fn init_from_remote(
    root: &Path,
    url: &str,
    machine: Option<MachineName>,
    effects: &RemoteInitEffects,
) -> Result<InitOutcome, StoreError> {
    let root = &resolve_store_link(root);
    let local = StoreEffects {
        run_git: effects.run_git,
        read_host_name: effects.read_host_name,
    };

    if has_config(root)? || ensure_empty(root).is_err() {
        return init(root, machine, &local);
    }

    let staging = create_staging(root)?;

    match read_remote(staging.path(), url, effects)? {
        RemoteState::WithoutMain => {
            return Err(StoreError::RemoteWithoutMain {
                url: url.to_owned(),
            });
        }
        RemoteState::Empty => create_and_push(staging.path(), url, machine.as_ref(), effects)?,
        RemoteState::HasMain => clone_main(staging.path(), url, machine.as_ref(), effects)?,
    }

    if publish(staging, root)? {
        return Ok(InitOutcome {
            store: root.clone(),
            created: true,
        });
    }

    init(root, machine, &local)
}

fn read_remote(
    staging: &Path,
    url: &str,
    effects: &RemoteInitEffects,
) -> Result<RemoteState, StoreError> {
    let output = (effects.run_network_git)(staging, &["ls-remote", "--heads", url])?;
    let text = String::from_utf8_lossy(&output);
    let branches: Vec<&str> = text
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .map(|(_, reference)| reference)
        .collect();

    if branches.contains(&"refs/heads/main") {
        return Ok(RemoteState::HasMain);
    }

    if branches.is_empty() {
        return Ok(RemoteState::Empty);
    }

    Ok(RemoteState::WithoutMain)
}

fn create_and_push(
    staging: &Path,
    url: &str,
    machine: Option<&MachineName>,
    effects: &RemoteInitEffects,
) -> Result<(), StoreError> {
    let machine = choose_machine(machine, effects)?;

    fill_new_store(staging, effects.run_git)?;
    (effects.run_git)(staging, &["remote", "add", "origin", url])?;
    write_machine(staging, &machine)?;
    (effects.run_network_git)(
        staging,
        &[
            "push",
            "--quiet",
            "--no-verify",
            "origin",
            "refs/heads/main:refs/heads/main",
        ],
    )?;

    Ok(())
}

fn clone_main(
    staging: &Path,
    url: &str,
    machine: Option<&MachineName>,
    effects: &RemoteInitEffects,
) -> Result<(), StoreError> {
    (effects.run_network_git)(
        staging,
        &[
            "clone",
            "--quiet",
            "--no-tags",
            "--branch",
            "main",
            "--",
            url,
            ".",
        ],
    )?;

    let is_store = match has_config(staging) {
        Ok(found) => found,
        Err(StoreError::InvalidConfig { .. }) => false,
        Err(error) => return Err(error),
    };

    if !is_store {
        return Err(StoreError::RemoteNotAStore {
            url: url.to_owned(),
        });
    }

    let chosen = choose_machine(machine, effects)?;
    let taken = exists(&staging.join(FACTS_FOLDER).join(chosen.to_string()))?;

    if machine.is_none() && taken {
        return Err(StoreError::MachineInUse {
            machine: chosen.to_string(),
        });
    }

    write_machine(staging, &chosen)
}

fn choose_machine(
    machine: Option<&MachineName>,
    effects: &RemoteInitEffects,
) -> Result<MachineName, StoreError> {
    if let Some(machine) = machine {
        return Ok(machine.clone());
    }

    MachineName::from_host_name(&(effects.read_host_name)()?)
}

fn write_machine(staging: &Path, machine: &MachineName) -> Result<(), StoreError> {
    write_file(&staging.join(MACHINE_FILE), &format!("{machine}\n"))
}

#[cfg(test)]
#[path = "store_init_remote_tests.rs"]
mod tests;
