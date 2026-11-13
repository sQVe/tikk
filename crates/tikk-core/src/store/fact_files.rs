use std::fs::{self, File, OpenOptions};
use std::io::{self, Read as _, Seek as _, SeekFrom, Write as _};
use std::path::{Path, PathBuf};

use crate::fact::{FactLine, Timestamp, parse_fact_line, write_fact_line};
use crate::store::StoreError;
use crate::store::machine::read_machine;
use crate::store::ticket_files::{exists, io_error, is_folder, sorted_entries};

const FACTS_FOLDER: &str = "facts";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnreadableFact {
    pub path: PathBuf,
    pub line: usize,
    pub message: String,
}

#[derive(Debug, Default)]
pub(crate) struct FactScan {
    pub(crate) facts: Vec<FactLine>,
    pub(crate) errors: Vec<UnreadableFact>,
}

pub(crate) fn fact_file(root: &Path, at: Timestamp) -> Result<PathBuf, StoreError> {
    let machine = read_machine(root)?;

    Ok(root
        .join(FACTS_FOLDER)
        .join(machine.to_string())
        .join(format!("{}.jsonl", at.month())))
}

pub(crate) fn append_line(path: &Path, line: &str) -> Result<(), StoreError> {
    if let Some(folder) = path.parent() {
        fs::create_dir_all(folder).map_err(|source| io_error("create", folder, source))?;
    }

    let mut file = OpenOptions::new()
        .read(true)
        .append(true)
        .create(true)
        .open(path)
        .map_err(|source| io_error("open", path, source))?;
    // A crash can leave a line without its newline. The new line must not join that fragment.
    let text = if ends_in_fragment(&mut file).map_err(|source| io_error("read", path, source))? {
        format!("\n{line}")
    } else {
        line.to_owned()
    };

    file.write_all(text.as_bytes())
        .map_err(|source| io_error("append to", path, source))
}

fn ends_in_fragment(file: &mut File) -> io::Result<bool> {
    if file.metadata()?.len() == 0 {
        return Ok(false);
    }

    let mut last = [0];

    file.seek(SeekFrom::End(-1))?;
    file.read_exact(&mut last)?;

    Ok(last[0] != b'\n')
}

pub(crate) fn append_fact(
    root: &Path,
    fact: &FactLine,
    append_line: fn(&Path, &str) -> Result<(), StoreError>,
) -> Result<(), StoreError> {
    let path = fact_file(root, fact.at)?;

    append_line(&path, &write_fact_line(fact))
}

pub(crate) fn read_facts(root: &Path) -> Result<FactScan, StoreError> {
    let mut scan = FactScan::default();

    for path in fact_paths(&root.join(FACTS_FOLDER))? {
        read_fact_file(&path, &mut scan)?;
    }

    scan.facts.sort_by_key(|fact| fact.at);

    Ok(scan)
}

fn fact_paths(folder: &Path) -> Result<Vec<PathBuf>, StoreError> {
    let mut paths = Vec::new();

    if !exists(folder)? {
        return Ok(paths);
    }

    for machine in sorted_entries(folder)? {
        if !is_folder(&machine)? {
            continue;
        }

        for path in sorted_entries(&machine)? {
            let is_fact_file = path
                .extension()
                .is_some_and(|extension| extension == "jsonl");

            if is_fact_file && !is_folder(&path)? {
                paths.push(path);
            }
        }
    }

    paths.sort_by(|left, right| left.as_os_str().cmp(right.as_os_str()));

    Ok(paths)
}

fn read_fact_file(path: &Path, scan: &mut FactScan) -> Result<(), StoreError> {
    let bytes = fs::read(path).map_err(|source| io_error("read", path, source))?;

    for (index, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }

        let parsed = std::str::from_utf8(line)
            .map_err(|_| "the line is not UTF-8".to_owned())
            .and_then(|text| parse_fact_line(text).map_err(|error| error.to_string()));

        match parsed {
            Ok(fact) => scan.facts.push(fact),
            Err(message) => scan.errors.push(UnreadableFact {
                path: path.to_path_buf(),
                line: index + 1,
                message,
            }),
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use super::{append_line, fact_file, read_facts};
    use crate::fact::{FactEvent, Timestamp};

    fn release(ticket: &str, at: &str) -> String {
        format!(
            "{{\"v\":1,\"kind\":\"release\",\"ticket\":\"{ticket}\",\"at\":\"{at}\",\"agent\":null}}\n"
        )
    }

    fn write(root: &Path, relative: &str, text: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().expect("a fact file has a folder"))
            .expect("create the machine folder");
        fs::write(path, text).expect("write a fact file");
    }

    #[test]
    fn read_facts_orders_by_time_then_path_then_line() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let root = directory.path();
        let early = "2026-11-13T01:00:00Z";
        let late = "2026-11-13T02:00:00Z";
        write(
            root,
            "facts/desk/2026-11.jsonl",
            &format!(
                "{}{}",
                release("tikk-dddd", late),
                release("tikk-cccc", early)
            ),
        );
        write(
            root,
            "facts/desk-2/2026-11.jsonl",
            &format!(
                "{}{}",
                release("tikk-bbbb", early),
                release("tikk-eeee", late)
            ),
        );
        write(
            root,
            "facts/desk/2026-10.jsonl",
            &release("tikk-aaaa", late),
        );

        let scan = read_facts(root).expect("the facts are read");

        let tickets: Vec<String> = scan
            .facts
            .iter()
            .map(|fact| fact.ticket.to_string())
            .collect();
        assert_eq!(
            tickets,
            [
                "tikk-bbbb",
                "tikk-cccc",
                "tikk-eeee",
                "tikk-aaaa",
                "tikk-dddd"
            ]
        );
        assert!(scan.errors.is_empty(), "{:?}", scan.errors);
    }

    #[test]
    fn read_facts_reports_a_broken_line_and_reads_the_rest() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let root = directory.path();
        let text = format!(
            "{}{{\"v\":1,\n\n{}",
            release("tikk-aaaa", "2026-11-13T01:00:00Z"),
            release("tikk-bbbb", "2026-11-13T02:00:00Z")
        );
        write(root, "facts/desk/2026-11.jsonl", &text);
        write(root, "facts/desk/notes.txt", "not facts");

        let scan = read_facts(root).expect("the facts are read");

        assert_eq!(scan.facts.len(), 2);
        assert!(matches!(scan.facts[1].event, FactEvent::Release { .. }));
        assert_eq!(scan.errors.len(), 1);
        assert_eq!(scan.errors[0].path, root.join("facts/desk/2026-11.jsonl"));
        assert_eq!(scan.errors[0].line, 2);
    }

    #[test]
    fn a_store_without_facts_has_none() {
        let directory = tempfile::tempdir().expect("create a temporary directory");

        let scan = read_facts(directory.path()).expect("the facts are read");

        assert!(scan.facts.is_empty());
        assert!(scan.errors.is_empty());
    }

    #[test]
    fn append_line_adds_to_the_month_file_of_the_saved_machine() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let root = directory.path();
        write(root, ".git/tikk-machine", "laptop\n");
        let at = Timestamp::parse("2026-11-13T01:00:00Z").expect("a valid time");
        let path = fact_file(root, at).expect("the machine is saved");

        append_line(&path, "first\n").expect("the first line is appended");
        append_line(&path, "second\n").expect("the second line is appended");

        assert_eq!(path, root.join("facts/laptop/2026-11.jsonl"));
        assert_eq!(
            fs::read_to_string(&path).expect("read the fact file"),
            "first\nsecond\n"
        );
    }
}
