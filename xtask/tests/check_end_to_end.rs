#![cfg(target_os = "linux")]

use std::ffi::OsString;
use std::fs;
use std::os::unix::ffi::OsStringExt as _;
use std::os::unix::fs::PermissionsExt as _;
use std::process::Command;

#[path = "../src/test_support.rs"]
mod test_support;

#[test]
fn check_fails_on_a_non_utf8_stomme_base_before_any_step_runs() {
    let folder = test_support::temporary_directory();
    let marker = folder.path().join("ran");
    let cargo = folder.path().join("cargo");
    fs::write(&cargo, format!("#!/bin/sh\ntouch '{}'\n", marker.display()))
        .expect("write a fake cargo");
    fs::set_permissions(&cargo, fs::Permissions::from_mode(0o700)).expect("make cargo executable");

    let output = Command::new(env!("CARGO_BIN_EXE_xtask"))
        .args(["check", "tidy"])
        .env("PATH", folder.path())
        .env("STOMME_BASE", OsString::from_vec(vec![0xff, 0xfe]))
        .output()
        .expect("run the check command");

    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("STOMME_BASE"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!marker.exists());
}
