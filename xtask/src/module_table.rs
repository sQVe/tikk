mod use_paths;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Context as _;
use thiserror::Error;

use use_paths::crate_paths;

use crate::source_files::sorted_rust_files;

const CORE_SOURCE: &str = "crates/tikk-core/src";
const CRATE_ROOT_FILE: &str = "lib.rs";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Pure,
    Io,
}

struct Entry {
    name: &'static str,
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "only the table test reads the kind")
    )]
    kind: Kind,
    uses: &'static [&'static str],
}

const MODULE_TABLE: &[Entry] = &[
    Entry {
        name: "ticket",
        kind: Kind::Pure,
        uses: &[],
    },
    Entry {
        name: "fact",
        kind: Kind::Pure,
        uses: &["ticket"],
    },
    Entry {
        name: "store",
        kind: Kind::Io,
        uses: &["ticket", "fact"],
    },
    Entry {
        name: "sync",
        kind: Kind::Io,
        uses: &["ticket", "fact"],
    },
    Entry {
        name: "github",
        kind: Kind::Io,
        uses: &["ticket", "fact"],
    },
];

#[derive(Debug, PartialEq, Eq)]
struct Use {
    module: String,
    used: String,
    path: String,
    line: usize,
}

#[derive(Debug, Error, PartialEq, Eq)]
enum Violation {
    #[error("{} must not use {}: {}:{}", .0.module, .0.used, .0.path, .0.line)]
    ForbiddenUse(Use),
    #[error("{} must use only module paths, not crate::{}: {}:{}", .0.module, .0.used, .0.path, .0.line)]
    NotAModule(Use),
    #[error("{module} is not in the module table: {path}")]
    NotInTable { module: String, path: String },
}

#[derive(Debug, Error, PartialEq, Eq)]
#[error("{}", violations.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n"))]
struct ModuleTableViolations {
    violations: Vec<Violation>,
}

struct Module {
    path: String,
    files: Vec<PathBuf>,
}

pub(crate) fn check(root: &Path) -> anyhow::Result<()> {
    check_with_table(root, MODULE_TABLE)
}

fn check_with_table(root: &Path, table: &[Entry]) -> anyhow::Result<()> {
    let modules = read_modules(root)?;
    let known_names: BTreeSet<&str> = table
        .iter()
        .map(|entry| entry.name)
        .chain(modules.keys().map(String::as_str))
        .collect();
    let mut violations = Vec::new();

    for (name, module) in &modules {
        let Some(entry) = table.iter().find(|entry| entry.name == name) else {
            violations.push(Violation::NotInTable {
                module: name.clone(),
                path: module.path.clone(),
            });
            continue;
        };

        for file in &module.files {
            violations.extend(forbidden_uses(root, file, entry, &known_names)?);
        }
    }

    violations.dedup();

    if violations.is_empty() {
        return Ok(());
    }

    Err(ModuleTableViolations { violations }.into())
}

fn read_modules(root: &Path) -> anyhow::Result<BTreeMap<String, Module>> {
    let directory = root.join(CORE_SOURCE);
    let entries = fs::read_dir(&directory)
        .with_context(|| format!("Could not list {}", directory.display()))?;
    let mut names = BTreeSet::new();

    for entry in entries {
        let path = entry
            .with_context(|| format!("Could not read an entry of {}", directory.display()))?
            .path();

        if let Some(name) = module_name(&path) {
            names.insert(name);
        }
    }

    names
        .into_iter()
        .map(|name| {
            let module = read_module(root, &directory, &name)?;
            Ok((name, module))
        })
        .collect()
}

fn module_name(path: &Path) -> Option<String> {
    let file_name = path.file_name()?.to_str()?;

    if path.is_dir() {
        return Some(file_name.to_string());
    }

    if file_name == CRATE_ROOT_FILE {
        return None;
    }

    file_name.strip_suffix(".rs").map(str::to_string)
}

fn read_module(root: &Path, directory: &Path, name: &str) -> anyhow::Result<Module> {
    let entry_file = directory.join(format!("{name}.rs"));
    let folder = directory.join(name);
    let has_entry_file = entry_file.is_file();
    let mut files = if folder.is_dir() {
        sorted_rust_files(&folder)?
    } else {
        Vec::new()
    };

    let path = if has_entry_file {
        files.insert(0, entry_file.clone());
        entry_file
    } else {
        folder
    };

    Ok(Module {
        path: relative_path(root, &path),
        files,
    })
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .display()
        .to_string()
}

fn forbidden_uses(
    root: &Path,
    file: &Path,
    entry: &Entry,
    known_names: &BTreeSet<&str>,
) -> anyhow::Result<Vec<Violation>> {
    let source =
        fs::read_to_string(file).with_context(|| format!("Could not read {}", file.display()))?;
    let path = relative_path(root, file);

    Ok(crate_paths(&source)
        .into_iter()
        .filter(|used| used.name != entry.name && !entry.uses.contains(&used.name))
        .map(|used| {
            let found = Use {
                module: entry.name.to_string(),
                used: used.name.to_string(),
                path: path.clone(),
                line: used.line,
            };

            if known_names.contains(used.name) {
                Violation::ForbiddenUse(found)
            } else {
                Violation::NotAModule(found)
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_source(root: &Path, relative: &str, source: &str) {
        let path = root.join(CORE_SOURCE).join(relative);
        let parent = path.parent().expect("a source file has a parent folder");

        fs::create_dir_all(parent).expect("create source folder");
        fs::write(path, source).expect("write source");
    }

    fn violations(result: anyhow::Result<()>) -> Vec<Violation> {
        let error = result.expect_err("the check fails");

        error
            .downcast::<ModuleTableViolations>()
            .expect("module table violations")
            .violations
    }

    fn forbidden_use(module: &str, used: &str, path: &str, line: usize) -> Violation {
        Violation::ForbiddenUse(Use {
            module: module.to_string(),
            used: used.to_string(),
            path: format!("{CORE_SOURCE}/{path}"),
            line,
        })
    }

    #[test]
    fn pure_module_that_uses_an_io_module_is_a_violation() {
        let root = crate::test_support::temporary_directory();
        write_source(root.path(), "ticket.rs", "\nuse crate::store::read;\n");
        write_source(root.path(), "store.rs", "");

        assert_eq!(
            violations(check(root.path())),
            [forbidden_use("ticket", "store", "ticket.rs", 2)]
        );
    }

    #[test]
    fn module_missing_from_the_table_is_a_violation() {
        let root = crate::test_support::temporary_directory();
        write_source(root.path(), "cache.rs", "");
        write_source(root.path(), "search/index.rs", "");

        assert_eq!(
            violations(check(root.path())),
            [
                Violation::NotInTable {
                    module: "cache".to_string(),
                    path: "crates/tikk-core/src/cache.rs".to_string(),
                },
                Violation::NotInTable {
                    module: "search".to_string(),
                    path: "crates/tikk-core/src/search".to_string(),
                },
            ]
        );
    }

    #[test]
    fn io_module_that_uses_another_io_module_is_a_violation() {
        let root = crate::test_support::temporary_directory();
        write_source(
            root.path(),
            "store.rs",
            "fn save() {\n    crate::sync::push();\n}\n",
        );

        assert_eq!(
            violations(check(root.path())),
            [forbidden_use("store", "sync", "store.rs", 2)]
        );
    }

    #[test]
    fn allowed_use_is_not_a_violation() {
        let root = crate::test_support::temporary_directory();
        write_source(root.path(), "ticket.rs", "use crate::ticket::Id;\n");
        write_source(root.path(), "fact.rs", "use crate::ticket::Ticket;\n");
        write_source(
            root.path(),
            "store.rs",
            "use crate::{fact, ticket::{Ticket, sync}};\n",
        );

        check(root.path()).expect("allowed uses pass");
    }

    #[test]
    fn crate_root_path_that_names_no_module_is_a_violation() {
        let root = crate::test_support::temporary_directory();
        write_source(
            root.path(),
            "ticket.rs",
            "use crate::Error;\nuse crate::*;\nuse crate::fact::Fact;\n",
        );

        let error = check(root.path()).expect_err("root paths fail");

        assert_eq!(
            error.to_string(),
            "ticket must use only module paths, not crate::Error: crates/tikk-core/src/ticket.rs:1\n\
             ticket must use only module paths, not crate::*: crates/tikk-core/src/ticket.rs:2\n\
             ticket must not use fact: crates/tikk-core/src/ticket.rs:3"
        );
    }

    #[test]
    fn use_in_a_comment_is_not_a_violation() {
        let root = crate::test_support::temporary_directory();
        write_source(
            root.path(),
            "ticket.rs",
            "// use crate::store::read;\n/* crate::store */\n/// crate::sync::push\n",
        );

        check(root.path()).expect("uses in comments pass");
    }

    #[test]
    fn use_in_a_string_literal_is_not_a_violation() {
        let root = crate::test_support::temporary_directory();
        write_source(
            root.path(),
            "ticket.rs",
            "const A: &str = \"crate::store::read\";\nconst B: &str = r#\"crate::{sync}\"#;\n",
        );

        check(root.path()).expect("uses in strings pass");
    }

    #[test]
    fn group_use_in_a_pure_module_reports_the_io_module() {
        let root = crate::test_support::temporary_directory();
        write_source(
            root.path(),
            "fact.rs",
            "use crate::{store, ticket::Ticket};\n",
        );

        assert_eq!(
            violations(check(root.path())),
            [forbidden_use("fact", "store", "fact.rs", 1)]
        );
    }

    #[test]
    fn file_in_a_module_folder_is_checked_as_part_of_the_module() {
        let root = crate::test_support::temporary_directory();
        write_source(root.path(), "ticket.rs", "mod ticket_parse;\n");
        write_source(
            root.path(),
            "ticket/ticket_parse.rs",
            "use crate::store::read;\n",
        );

        assert_eq!(
            violations(check(root.path())),
            [forbidden_use(
                "ticket",
                "store",
                "ticket/ticket_parse.rs",
                1
            )]
        );
    }

    #[test]
    fn lib_rs_is_not_checked() {
        let root = crate::test_support::temporary_directory();
        write_source(
            root.path(),
            "lib.rs",
            "mod store;\nmod ticket;\nuse crate::store::read;\n",
        );
        write_source(root.path(), "store.rs", "");
        write_source(root.path(), "ticket.rs", "");

        check(root.path()).expect("the crate root is not a module");
    }

    #[test]
    fn missing_core_source_folder_is_an_error() {
        let root = crate::test_support::temporary_directory();

        let error = check(root.path()).expect_err("a missing source folder fails");

        assert!(error.downcast_ref::<ModuleTableViolations>().is_none());
        assert_eq!(
            error.to_string(),
            format!("Could not list {}", root.path().join(CORE_SOURCE).display())
        );
    }

    #[test]
    fn check_reads_the_given_table() {
        let root = crate::test_support::temporary_directory();
        let table = [
            Entry {
                name: "cache",
                kind: Kind::Io,
                uses: &["ticket"],
            },
            Entry {
                name: "ticket",
                kind: Kind::Pure,
                uses: &[],
            },
        ];
        write_source(root.path(), "cache.rs", "use crate::ticket::Ticket;\n");
        write_source(root.path(), "ticket.rs", "");

        check_with_table(root.path(), &table).expect("the given table allows the use");
    }

    #[test]
    fn violations_follow_module_file_and_line_order_one_per_line() {
        let root = crate::test_support::temporary_directory();
        write_source(
            root.path(),
            "ticket/b_parse.rs",
            "use crate::github::Client;\n",
        );
        write_source(root.path(), "ticket/a_parse.rs", "use crate::sync::push;\n");
        write_source(
            root.path(),
            "ticket.rs",
            "fn a() {\n    crate::sync::a(crate::sync::b);\n}\nuse crate::store::read;\n",
        );
        write_source(root.path(), "cache.rs", "");

        let error = check(root.path()).expect_err("violations fail");

        assert_eq!(
            error.to_string(),
            "cache is not in the module table: crates/tikk-core/src/cache.rs\n\
             ticket must not use sync: crates/tikk-core/src/ticket.rs:2\n\
             ticket must not use store: crates/tikk-core/src/ticket.rs:4\n\
             ticket must not use sync: crates/tikk-core/src/ticket/a_parse.rs:1\n\
             ticket must not use github: crates/tikk-core/src/ticket/b_parse.rs:1"
        );
    }

    #[test]
    fn real_table_keeps_pure_and_io_directions() {
        for entry in MODULE_TABLE {
            for used in entry.uses {
                let used_entry = MODULE_TABLE
                    .iter()
                    .find(|candidate| candidate.name == *used);

                assert!(
                    used_entry.is_some(),
                    "{} uses {used}, which is not an entry",
                    entry.name
                );
                assert!(
                    used_entry.is_some_and(|used_entry| used_entry.kind == Kind::Pure),
                    "{} uses the I/O module {used}",
                    entry.name
                );
            }
        }
    }
}
