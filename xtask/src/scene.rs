use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};

use anyhow::Context as _;
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub(crate) enum SceneError {
    #[error("{}", unknown_scene_message(name, names))]
    Unknown { name: String, names: Vec<String> },
    #[error("{}", unknown_scene_message(name, names))]
    Empty { name: String, names: Vec<String> },
    #[error("The scene binary did not build.")]
    BuildFailed { status: ExitStatus },
    #[error("ruta.toml requires {}, but Cargo reported {}. Remove CARGO_TARGET_DIR or other target directory overrides.", expected.display(), actual.display())]
    UnexpectedExecutable { expected: PathBuf, actual: PathBuf },
    #[error("Cargo did not report a tikk-scene executable.")]
    MissingExecutable,
    #[error("The scene binary did not list its scenes.")]
    ListingFailed { status: ExitStatus },
    #[error("The scene binary listed no scenes.")]
    EmptyListing,
}

const DROPPED_SESSION: &[&str] = &[
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "WAYLAND_SOCKET",
    "LIBEI_SOCKET",
    "XAUTHORITY",
    "SWAYSOCK",
    "DBUS_SESSION_BUS_ADDRESS",
    "AT_SPI_BUS_ADDRESS",
];

pub(crate) fn build(root: &Path) -> anyhow::Result<PathBuf> {
    let output = Command::new("cargo")
        .args([
            "build",
            "--locked",
            "--package",
            "tikk-ui",
            "--bin",
            "tikk-scene",
            "--message-format=json-render-diagnostics",
        ])
        .current_dir(root)
        .env_clear()
        .envs(build_environment(&std::env::vars().collect::<Vec<_>>()))
        .stderr(Stdio::inherit())
        .output()
        .context("Could not start cargo build")?;

    if !output.status.success() {
        return Err(SceneError::BuildFailed {
            status: output.status,
        }
        .into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    let executable = executable_from_messages(&stdout)?;
    validate_executable(root, &executable)?;

    Ok(executable)
}

pub(crate) fn names(
    binary: &Path,
    environment: &[(String, String)],
) -> anyhow::Result<Vec<String>> {
    let mut command = Command::new(binary);
    command
        .arg("--list")
        .env_clear()
        .envs(environment.iter().cloned());
    let output = command.output().context("Could not list the scenes")?;

    if !output.status.success() {
        return Err(SceneError::ListingFailed {
            status: output.status,
        }
        .into());
    }

    let names: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();

    if names.is_empty() {
        return Err(SceneError::EmptyListing.into());
    }

    Ok(names)
}

pub(crate) fn validate_scene(name: &str, names: &[String]) -> Result<String, SceneError> {
    let trimmed = name.trim();
    let requested = trimmed.to_string();

    names
        .iter()
        .find(|scene| scene.as_str() == trimmed)
        .cloned()
        .ok_or_else(|| {
            if trimmed.is_empty() {
                SceneError::Empty {
                    name: requested,
                    names: names.to_vec(),
                }
            } else {
                SceneError::Unknown {
                    name: requested,
                    names: names.to_vec(),
                }
            }
        })
}

pub(crate) fn build_environment(caller: &[(String, String)]) -> Vec<(String, String)> {
    caller
        .iter()
        .filter(|(key, _)| !DROPPED_SESSION.contains(&key.as_str()))
        .cloned()
        .collect()
}

fn validate_executable(root: &Path, executable: &Path) -> Result<(), SceneError> {
    let expected = root.join("target/debug/tikk-scene");

    if executable != expected {
        return Err(SceneError::UnexpectedExecutable {
            expected,
            actual: executable.to_path_buf(),
        });
    }

    Ok(())
}

fn executable_from_messages(output: &str) -> Result<PathBuf, SceneError> {
    for line in output.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };

        if value["reason"] != "compiler-artifact" || value["target"]["name"] != "tikk-scene" {
            continue;
        }

        if let Some(executable) = value["executable"].as_str() {
            return Ok(PathBuf::from(executable));
        }
    }

    Err(SceneError::MissingExecutable)
}

fn unknown_scene_message(name: &str, names: &[String]) -> String {
    let known = names.join(", ");

    if name.trim().is_empty() {
        format!("Type a scene name. Known scenes: {known}.")
    } else {
        format!("No scene named \"{}\". Known scenes: {known}.", name.trim())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_scene_names_the_known_scenes() {
        let names = known_names();

        assert_eq!(
            validate_scene(" alpha ", &names).expect("a known scene"),
            "alpha"
        );

        let error = validate_scene("missing", &names).expect_err("an unknown scene fails");
        assert_eq!(
            error,
            SceneError::Unknown {
                name: "missing".to_string(),
                names: known_names(),
            }
        );

        let error = validate_scene("", &names).expect_err("an empty scene fails");
        assert_eq!(
            error,
            SceneError::Empty {
                name: String::new(),
                names: known_names(),
            }
        );
    }

    #[test]
    fn scene_name_errors_name_the_rejected_name_and_the_known_scenes() {
        let names = known_names();

        let unknown = validate_scene(" missing ", &names).expect_err("an unknown scene fails");
        assert_eq!(
            unknown.to_string(),
            "No scene named \"missing\". Known scenes: alpha, beta."
        );

        let empty = validate_scene("  ", &names).expect_err("an empty scene fails");
        assert_eq!(
            empty.to_string(),
            "Type a scene name. Known scenes: alpha, beta."
        );
    }

    #[test]
    fn build_environment_drops_session_variables() {
        let caller = vec![
            ("DISPLAY".to_string(), ":0".to_string()),
            ("WAYLAND_DISPLAY".to_string(), "wayland-0".to_string()),
            ("WAYLAND_SOCKET".to_string(), "3".to_string()),
            ("LIBEI_SOCKET".to_string(), "/run/ei".to_string()),
            (
                "XAUTHORITY".to_string(),
                "/home/user/.Xauthority".to_string(),
            ),
            ("SWAYSOCK".to_string(), "/run/sway".to_string()),
            (
                "DBUS_SESSION_BUS_ADDRESS".to_string(),
                "unix:path=/run/bus".to_string(),
            ),
            (
                "AT_SPI_BUS_ADDRESS".to_string(),
                "unix:path=/run/accessibility".to_string(),
            ),
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("HOME".to_string(), "/home/user".to_string()),
            ("CARGO_HOME".to_string(), "/cargo".to_string()),
            ("RUSTUP_HOME".to_string(), "/rustup".to_string()),
        ];
        let environment = build_environment(&caller);
        let has = |key: &str| environment.iter().any(|(name, _)| name == key);

        assert!(!has("DISPLAY"));
        assert!(!has("WAYLAND_DISPLAY"));
        assert!(!has("WAYLAND_SOCKET"));
        assert!(!has("LIBEI_SOCKET"));
        assert!(!has("XAUTHORITY"));
        assert!(!has("SWAYSOCK"));
        assert!(!has("DBUS_SESSION_BUS_ADDRESS"));
        assert!(!has("AT_SPI_BUS_ADDRESS"));
        assert!(has("PATH"));
        assert!(has("HOME"));
        assert!(has("CARGO_HOME"));
        assert!(has("RUSTUP_HOME"));
    }

    #[test]
    fn names_lists_the_binary_without_a_display() {
        use std::os::unix::fs::PermissionsExt as _;

        let folder = crate::test_support::temporary_directory();
        let binary = folder.path().join("scene");
        std::fs::write(&binary, "#!/bin/sh\n[ \"$1\" = --list ] || exit 1\n[ -z \"$DISPLAY\" ] || exit 1\nprintf ' alpha \\n\\n beta \\n'\n").expect("write a scene list command");
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))
            .expect("make the scene executable");

        assert_eq!(
            names(&binary, &[]).expect("list known scenes"),
            ["alpha", "beta"]
        );
    }

    #[test]
    fn names_rejects_an_unsuccessful_listing_even_with_output() {
        use std::os::unix::fs::PermissionsExt as _;

        let folder = crate::test_support::temporary_directory();
        let binary = folder.path().join("scene");
        std::fs::write(&binary, "#!/bin/sh\nprintf 'placeholder\\n'\nexit 1\n")
            .expect("write a failing scene list command");
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))
            .expect("make the scene executable");

        let error = names(&binary, &[]).expect_err("a failed listing cannot supply scenes");

        assert!(matches!(
            error.downcast_ref::<SceneError>(),
            Some(SceneError::ListingFailed { status }) if status.code() == Some(1)
        ));
    }

    #[test]
    fn names_preserves_the_cause_when_the_binary_is_missing() {
        let folder = crate::test_support::temporary_directory();
        let binary = folder.path().join("missing");

        let error = names(&binary, &[]).expect_err("the binary does not exist");

        assert_eq!(
            error
                .downcast_ref::<std::io::Error>()
                .expect("IO cause")
                .kind(),
            std::io::ErrorKind::NotFound
        );
        assert_eq!(
            std::fs::read_dir(folder.path())
                .expect("read fixture")
                .count(),
            0
        );
    }

    #[test]
    fn names_rejects_a_successful_empty_listing() {
        use std::os::unix::fs::PermissionsExt as _;

        let folder = crate::test_support::temporary_directory();
        let binary = folder.path().join("scene");
        std::fs::write(&binary, "#!/bin/sh\nprintf ' \\n\\t\\n'\n")
            .expect("write an empty scene list command");
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))
            .expect("make the scene executable");

        let error = names(&binary, &[]).expect_err("an empty listing cannot supply scenes");

        assert_eq!(
            error.downcast_ref::<SceneError>(),
            Some(&SceneError::EmptyListing)
        );
    }

    #[test]
    fn executable_must_match_the_ruta_config_path() {
        let root = Path::new("/workspace");
        let expected = root.join("target/debug/tikk-scene");
        validate_executable(root, &expected).expect("the configured executable is accepted");
        let error = validate_executable(root, Path::new("/custom/debug/tikk-scene"))
            .expect_err("a custom target directory is refused");
        assert_eq!(
            error,
            SceneError::UnexpectedExecutable {
                expected,
                actual: PathBuf::from("/custom/debug/tikk-scene"),
            }
        );
    }

    #[test]
    fn executable_from_messages_reads_the_artifact_path() {
        let output = "\
{\"reason\":\"compiler-artifact\",\"target\":{\"name\":\"tikk-scene\"},\"executable\":\"/custom/target/debug/tikk-scene\"}\n\
{\"reason\":\"build-finished\",\"success\":true}\n";

        assert_eq!(
            executable_from_messages(output).expect("a compiler artifact"),
            PathBuf::from("/custom/target/debug/tikk-scene")
        );
        for invalid in [
            "not json",
            "{\"reason\":\"compiler-artifact\",\"target\":{\"name\":\"other\"},\"executable\":\"/x\"}",
            "{\"reason\":\"other\",\"target\":{\"name\":\"tikk-scene\"},\"executable\":\"/x\"}",
            "{\"reason\":\"compiler-artifact\",\"target\":{\"name\":\"tikk-scene\"},\"executable\":null}",
        ] {
            assert_eq!(
                executable_from_messages(invalid),
                Err(SceneError::MissingExecutable),
                "{invalid}"
            );
        }
    }

    fn known_names() -> Vec<String> {
        ["alpha", "beta"]
            .iter()
            .map(|name| name.to_string())
            .collect()
    }
}
