use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Context as _;

pub(crate) fn sorted_rust_files(directory: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut files = Vec::new();

    collect_rust_files(directory, &mut files)?;
    files.sort();

    Ok(files)
}

fn collect_rust_files(directory: &Path, files: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    let entries = fs::read_dir(directory)
        .with_context(|| format!("Could not list {}", directory.display()))?;

    for entry in entries {
        let path = entry
            .with_context(|| format!("Could not read an entry of {}", directory.display()))?
            .path();

        if path.is_dir() {
            collect_rust_files(&path, files)?;
        } else if path.extension().and_then(|extension| extension.to_str()) == Some("rs") {
            files.push(path);
        }
    }

    Ok(())
}
