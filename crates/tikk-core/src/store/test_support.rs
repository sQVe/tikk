pub(crate) mod sync_remote;

use std::fs;

use tempfile::TempDir;

use crate::store::Store;

// Keep the `TempDir` alive while the test uses the store.
pub(crate) fn store_with(files: &[(&str, impl AsRef<str>)]) -> (TempDir, Store) {
    let directory = tempfile::tempdir().expect("create a temporary directory");
    let folder = directory.path().join("tickets/personal");
    fs::create_dir_all(directory.path().join(".git")).expect("create the Git folder");
    fs::create_dir_all(&folder).expect("create the project folder");

    for (name, text) in files {
        fs::write(folder.join(name), text.as_ref()).expect("write a ticket");
    }

    let store = Store {
        root: directory.path().to_path_buf(),
    };

    (directory, store)
}
