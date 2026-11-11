use tempfile::{Builder, TempDir};

pub(crate) fn temporary_directory() -> TempDir {
    Builder::new()
        .prefix("tikk-xtask-test-")
        .tempdir()
        .expect("create a temporary directory")
}
