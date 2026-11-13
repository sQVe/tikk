use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use anyhow::Context as _;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
enum Violation {
    #[error("docs/adr/README.md: unsupported index link form; use inline links: {text}")]
    UnsupportedLink { text: String },
    #[error("{path}: ADR number {number} is also used by {other}")]
    DuplicateNumber {
        path: String,
        number: String,
        other: String,
    },
    #[error("{path}: first heading must be '# ADR {number}: Title'")]
    Heading { path: String, number: String },
    #[error("{path}: ADR number {number} is retired in docs/adr/README.md")]
    Retired { path: String, number: String },
    #[error("docs/adr/README.md: {path} is listed {count} times; expected once")]
    Count { path: String, count: usize },
    #[error("docs/adr/README.md: {path} does not exist")]
    Missing { path: String },
    #[error("docs/adr/README.md: {path} has label '{actual}'; expected '{expected}'")]
    Label {
        path: String,
        actual: String,
        expected: String,
    },
}

#[derive(Debug, Error, PartialEq, Eq)]
#[error("{}", violations.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n"))]
struct IndexViolations {
    violations: Vec<Violation>,
}

pub(crate) fn check(root: &Path) -> anyhow::Result<()> {
    let directory = root.join("docs/adr");
    let readme = directory.join("README.md");
    let source = fs::read_to_string(&readme)
        .with_context(|| format!("Could not read {}", readme.display()))?;
    let mut violations = Vec::new();
    let entries = index_entries(&source, &mut violations);
    let retired = retired_numbers(&source);
    let files = read_adrs(&directory)?;
    let mut numbers = BTreeMap::new();

    for (file, source) in &files {
        let number = adr_number(file).expect("read_adrs selects ADR file names");
        let path = format!("docs/adr/{file}");

        if let Some(other) = numbers.insert(number, path.clone()) {
            violations.push(Violation::DuplicateNumber {
                path: path.clone(),
                number: number.into(),
                other,
            });
        }

        if retired.contains(number) {
            violations.push(Violation::Retired {
                path: path.clone(),
                number: number.into(),
            });
        }

        let labels = entries.get(file.as_str()).map_or(&[][..], Vec::as_slice);
        violations.extend(check_entry(&path, number, source, labels));
    }

    for file in entries.keys() {
        if !files.contains_key(*file) {
            violations.push(Violation::Missing {
                path: format!("docs/adr/{file}"),
            });
        }
    }

    if violations.is_empty() {
        return Ok(());
    }

    Err(IndexViolations { violations }.into())
}

fn read_adrs(directory: &Path) -> anyhow::Result<BTreeMap<String, String>> {
    let entries = fs::read_dir(directory)
        .with_context(|| format!("Could not list {}", directory.display()))?;
    let mut files = BTreeMap::new();

    for entry in entries {
        let entry =
            entry.with_context(|| format!("Could not read an entry of {}", directory.display()))?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };

        if adr_number(name).is_none() || !path.is_file() {
            continue;
        }

        let source = fs::read_to_string(&path)
            .with_context(|| format!("Could not read {}", path.display()))?;
        files.insert(name.to_string(), source);
    }

    Ok(files)
}

fn adr_number(file: &str) -> Option<&str> {
    let (number, name) = file.split_once('-')?;
    let valid_number = number.len() == 4 && number.bytes().all(|byte| byte.is_ascii_digit());

    if valid_number && name.ends_with(".md") {
        return Some(number);
    }

    None
}

fn section<'a>(source: &'a str, heading: &'a str) -> impl Iterator<Item = &'a str> {
    source
        .lines()
        .skip_while(move |line| line.trim() != heading)
        .skip(1)
        .take_while(|line| !line.starts_with("## "))
}

fn index_entries<'a>(
    source: &'a str,
    violations: &mut Vec<Violation>,
) -> BTreeMap<&'a str, Vec<&'a str>> {
    let mut entries: BTreeMap<&str, Vec<&str>> = BTreeMap::new();

    for line in section(source, "## Index") {
        let mut rest = line;

        while let Some((_, link)) = rest.split_once('[') {
            let Some((label, file, remaining)) = inline_link(link) else {
                violations.push(Violation::UnsupportedLink { text: line.into() });
                break;
            };
            let file = file.strip_prefix("./").unwrap_or(file);
            entries.entry(file).or_default().push(label);
            rest = remaining;
        }
    }

    entries
}

fn inline_link(source: &str) -> Option<(&str, &str, &str)> {
    let (label, rest) = source.split_once(']')?;

    if label.contains('[') {
        return None;
    }

    let target = rest.strip_prefix('(')?;
    let (file, remaining) = target.split_once(')')?;

    Some((label, file, remaining))
}

fn retired_numbers(source: &str) -> BTreeSet<&str> {
    section(source, "## Retired")
        .filter_map(|line| line.strip_prefix('|')?.split('|').next())
        .map(str::trim)
        .filter(|number| number.len() == 4 && number.bytes().all(|byte| byte.is_ascii_digit()))
        .collect()
}

fn check_entry(path: &str, number: &str, source: &str, labels: &[&str]) -> Vec<Violation> {
    let mut violations = Vec::new();

    if labels.len() != 1 {
        violations.push(Violation::Count {
            path: path.into(),
            count: labels.len(),
        });
    }

    let heading = source.lines().find(|line| line.starts_with('#'));
    let prefix = format!("# ADR {number}: ");
    let title = heading.and_then(|heading| heading.strip_prefix(&prefix));
    let Some(title) = title.filter(|title| !title.trim().is_empty()) else {
        violations.push(Violation::Heading {
            path: path.into(),
            number: number.into(),
        });
        return violations;
    };
    let expected = format!("{number}: {title}");

    for label in labels {
        if *label != expected {
            violations.push(Violation::Label {
                path: path.into(),
                actual: (*label).into(),
                expected: expected.clone(),
            });
        }
    }

    violations
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    const FILE: &str = "0001-choice.md";
    const LINK: &str = "- [0001: A choice](./0001-choice.md)\n";

    fn fixture(index: &str, heading: &str) -> tempfile::TempDir {
        let root = crate::test_support::temporary_directory();
        let directory = root.path().join("docs/adr");
        fs::create_dir_all(&directory).expect("create ADR directory");
        fs::write(directory.join("README.md"), index).expect("write index");
        fs::write(directory.join(FILE), heading).expect("write ADR");
        root
    }

    fn snapshot(root: &Path) -> BTreeMap<std::path::PathBuf, Vec<u8>> {
        fs::read_dir(root.join("docs/adr"))
            .expect("read fixture directory")
            .map(|entry| {
                let path = entry.expect("read fixture entry").path();
                let contents = fs::read(&path).expect("read fixture file");
                (path, contents)
            })
            .collect()
    }

    fn violations(root: &Path) -> Vec<Violation> {
        let before = snapshot(root);
        let error = check(root).expect_err("invalid ADR index must fail");
        assert_eq!(snapshot(root), before, "the check changes no files");

        error
            .downcast::<IndexViolations>()
            .expect("index violations")
            .violations
    }

    fn path() -> String {
        format!("docs/adr/{FILE}")
    }

    #[test]
    fn check_accepts_current_index_and_ignores_earlier_numbering_and_metadata() {
        let index = format!(
            "## Index\n{LINK}\n## Earlier numbering\n| 0001 | [old](./9999-missing.md) |\n\n## Retired\n| ADR | Title | Replaced by | Last commit |\n| --- | --- | --- | --- |\n| 0002 | Old | 0001 | abc |\n"
        );
        let root = fixture(&index, "# ADR 0001: A choice\n\nNo metadata.\n");
        fs::write(root.path().join("docs/adr/TEMPLATE.md"), "# Template").expect("write template");

        check(root.path()).expect("valid current index");
    }

    #[test]
    fn check_rejects_reference_entry_beside_inline_entry() {
        let line = "- [0001: A choice][choice]";
        let root = fixture(
            &format!("## Index\n{LINK}{line}\n"),
            "# ADR 0001: A choice\n",
        );

        assert_eq!(
            violations(root.path()),
            [Violation::UnsupportedLink { text: line.into() }]
        );
    }

    #[test]
    fn check_rejects_reference_entry_to_missing_file() {
        let line = "- [0002: Missing][missing]";
        let root = fixture(
            &format!("## Index\n{LINK}{line}\n"),
            "# ADR 0001: A choice\n",
        );

        assert_eq!(
            violations(root.path()),
            [Violation::UnsupportedLink { text: line.into() }]
        );
    }

    #[test]
    fn check_rejects_reference_definition() {
        let line = "[choice]: ./0001-choice.md";
        let root = fixture(
            &format!("## Index\n{LINK}{line}\n"),
            "# ADR 0001: A choice\n",
        );

        assert_eq!(
            violations(root.path()),
            [Violation::UnsupportedLink { text: line.into() }]
        );
    }

    #[test]
    fn check_rejects_shortcut_reference() {
        let line = "- [choice]";
        let root = fixture(
            &format!("## Index\n{LINK}{line}\n"),
            "# ADR 0001: A choice\n",
        );

        assert_eq!(
            violations(root.path()),
            [Violation::UnsupportedLink { text: line.into() }]
        );
    }

    #[test]
    fn check_rejects_text_between_bracketed_labels() {
        let line = "- [a] text [0001: A choice](./0001-choice.md)";
        let root = fixture(
            &format!("## Index\n{LINK}{line}\n"),
            "# ADR 0001: A choice\n",
        );

        assert_eq!(
            violations(root.path()),
            [Violation::UnsupportedLink { text: line.into() }]
        );
    }

    #[test]
    fn check_rejects_duplicate_numbers() {
        let index = format!("## Index\n{LINK}- [0001: Other](./0001-other.md)\n");
        let root = fixture(&index, "# ADR 0001: A choice\n");
        fs::write(
            root.path().join("docs/adr/0001-other.md"),
            "# ADR 0001: Other\n",
        )
        .expect("write duplicate ADR");

        assert_eq!(
            violations(root.path()),
            [Violation::DuplicateNumber {
                path: "docs/adr/0001-other.md".into(),
                number: "0001".into(),
                other: path(),
            }]
        );
    }

    #[test]
    fn check_rejects_invalid_first_heading() {
        for heading in [
            "# ADR 0002: A choice\n",
            "## ADR 0001: A choice\n",
            "# Wrong\n# ADR 0001: A choice\n",
            "# ADR 0001: \n",
            "No heading\n",
        ] {
            let root = fixture(&format!("## Index\n{LINK}"), heading);

            assert_eq!(
                violations(root.path()),
                [Violation::Heading {
                    path: path(),
                    number: "0001".into()
                }],
                "{heading}"
            );
        }
    }

    #[test]
    fn check_rejects_retired_number_reuse() {
        let root = fixture(
            &format!(
                "## Index\n{LINK}\n## Retired\n| ADR | Title | Replaced by | Last commit |\n| --- | --- | --- | --- |\n| 0001 | Old | 0002 | abc |\n"
            ),
            "# ADR 0001: A choice\n",
        );

        assert_eq!(
            violations(root.path()),
            [Violation::Retired {
                path: path(),
                number: "0001".into()
            }]
        );
    }

    #[test]
    fn check_rejects_missing_index_entry() {
        let root = fixture("## Index\n", "# ADR 0001: A choice\n");

        assert_eq!(
            violations(root.path()),
            [Violation::Count {
                path: path(),
                count: 0
            }]
        );
    }

    #[test]
    fn check_rejects_repeated_index_entry() {
        let root = fixture(&format!("## Index\n{LINK}{LINK}"), "# ADR 0001: A choice\n");

        assert_eq!(
            violations(root.path()),
            [Violation::Count {
                path: path(),
                count: 2
            }]
        );
    }

    #[test]
    fn check_rejects_nonexistent_index_target() {
        let root = fixture(
            &format!("## Index\n{LINK}- [0002: Missing](./0002-missing.md)\n"),
            "# ADR 0001: A choice\n",
        );

        assert_eq!(
            violations(root.path()),
            [Violation::Missing {
                path: "docs/adr/0002-missing.md".into()
            }]
        );
    }

    #[test]
    fn check_rejects_label_different_from_heading() {
        let root = fixture(
            "## Index\n- [Wrong](./0001-choice.md)\n",
            "# ADR 0001: A choice\n",
        );

        assert_eq!(
            violations(root.path()),
            [Violation::Label {
                path: path(),
                actual: "Wrong".into(),
                expected: "0001: A choice".into()
            }]
        );
    }
}
