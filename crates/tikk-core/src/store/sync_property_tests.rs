use std::collections::BTreeSet;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use proptest::prelude::*;
use proptest::test_runner::RngSeed;

use super::{CLOCK, Machines, effects, later, sync, write};
use crate::store::StoreError;
use crate::store::sync::SyncOutcome;
use crate::store::test_support::sync_remote::{git_text, store_files};

const TICKETS: [&str; 4] = [
    "personal-abcd-renew",
    "personal-abcd-mail",
    "personal-efgh-mail",
    "personal-ijkm-plan",
];

const FACT_TICKETS: [&str; 4] = [
    "personal-abcd",
    "personal-abcd",
    "personal-efgh",
    "personal-ijkm",
];

#[derive(Debug, Clone, Copy)]
enum Machine {
    Laptop,
    Desktop,
}

impl Machine {
    fn root(self, machines: &Machines) -> PathBuf {
        match self {
            Self::Laptop => machines.laptop(),
            Self::Desktop => machines.desktop(),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Laptop => "laptop",
            Self::Desktop => "desktop",
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum Step {
    Create {
        machine: Machine,
        ticket: usize,
        title: usize,
    },
    Edit {
        machine: Machine,
        ticket: usize,
        title: usize,
    },
    AppendFact {
        machine: Machine,
        line: usize,
    },
    Sync {
        machine: Machine,
    },
}

fn machine_strategy() -> impl Strategy<Value = Machine> {
    prop_oneof![Just(Machine::Laptop), Just(Machine::Desktop)]
}

fn step_strategy() -> impl Strategy<Value = Step> {
    prop_oneof![
        (machine_strategy(), 0..TICKETS.len(), 0..4usize).prop_map(|(machine, ticket, title)| {
            Step::Create {
                machine,
                ticket,
                title,
            }
        }),
        (machine_strategy(), 0..TICKETS.len(), 0..4usize).prop_map(|(machine, ticket, title)| {
            Step::Edit {
                machine,
                ticket,
                title,
            }
        }),
        (machine_strategy(), 0..TICKETS.len())
            .prop_map(|(machine, line)| Step::AppendFact { machine, line }),
        machine_strategy().prop_map(|machine| Step::Sync { machine }),
    ]
}

fn ticket_path(ticket: usize) -> String {
    format!("tickets/personal/{}.md", TICKETS[ticket])
}

fn ticket_text(title: usize) -> String {
    format!("---\nkind: task\ntitle: Title {title}\n---\n")
}

fn fact_line(line: usize, appended: usize) -> String {
    let ticket = FACT_TICKETS[line % FACT_TICKETS.len()];
    let at = format!("2026-11-13T01:{:02}:{:02}Z", line % 60, appended % 60);

    format!(
        "{{\"v\":1,\"kind\":\"release\",\"ticket\":\"{ticket}\",\"at\":\"{at}\",\"agent\":null}}"
    )
}

fn append(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    let folder = path.parent().expect("a fact file has a folder");

    fs::create_dir_all(folder).expect("create the fact folder");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("open the fact file");
    file.write_all(text.as_bytes())
        .expect("append the fact line");
}

fn run_generated_run(steps: &[Step]) {
    let mut run = Run::new();

    for step in steps {
        run.apply(*step);
    }

    run.finish();
}

struct Run {
    machines: Machines,
    created: BTreeSet<PathBuf>,
    appended: Vec<(PathBuf, String)>,
    append_count: usize,
    conflict_seen: bool,
}

impl Run {
    fn new() -> Self {
        CLOCK.set(later());

        Self {
            machines: Machines::new(),
            created: BTreeSet::new(),
            appended: Vec::new(),
            append_count: 0,
            conflict_seen: false,
        }
    }

    fn apply(&mut self, step: Step) {
        match step {
            Step::Create {
                machine,
                ticket,
                title,
            } => self.create(machine, ticket, title),
            Step::Edit {
                machine,
                ticket,
                title,
            } => self.edit(machine, ticket, title),
            Step::AppendFact { machine, line } => self.append_fact(machine, line),
            Step::Sync { machine } => self.sync(machine),
        }
    }

    fn create(&mut self, machine: Machine, ticket: usize, title: usize) {
        let root = machine.root(&self.machines);
        let path = ticket_path(ticket);

        if root.join(&path).exists() {
            return;
        }

        write(&root, &path, &ticket_text(title));
        self.created.insert(PathBuf::from(path));
    }

    fn edit(&mut self, machine: Machine, ticket: usize, title: usize) {
        let root = machine.root(&self.machines);
        let path = ticket_path(ticket);

        if root.join(&path).exists() {
            write(&root, &path, &ticket_text(title));
        }
    }

    fn append_fact(&mut self, machine: Machine, line: usize) {
        let root = machine.root(&self.machines);
        let path = format!("facts/{}/2026-11.jsonl", machine.name());
        let text = fact_line(line, self.append_count);

        append(&root, &path, &format!("{text}\n"));
        self.appended.push((PathBuf::from(path), text));
        self.append_count += 1;
    }

    fn sync(&mut self, machine: Machine) {
        self.conflict_seen |= sync_and_check(&machine.root(&self.machines));
    }

    fn finish(&mut self) {
        if self.conflict_seen {
            return;
        }

        for machine in [Machine::Laptop, Machine::Desktop, Machine::Laptop] {
            self.sync(machine);
        }

        if self.conflict_seen {
            return;
        }

        self.assert_converged();
    }

    fn assert_converged(&self) {
        let laptop_files = store_files(&self.machines.laptop());
        let desktop_files = store_files(&self.machines.desktop());

        assert_eq!(
            laptop_files, desktop_files,
            "the two stores differ after their final syncs"
        );

        for path in &self.created {
            assert!(
                laptop_files.iter().any(|(stored, _)| stored == path),
                "{path:?} is missing from the laptop store"
            );
            assert!(
                desktop_files.iter().any(|(stored, _)| stored == path),
                "{path:?} is missing from the desktop store"
            );
        }

        for (path, line) in &self.appended {
            assert_fact_present(&laptop_files, path, line, "laptop");
            assert_fact_present(&desktop_files, path, line, "desktop");
        }
    }
}

fn sync_and_check(root: &Path) -> bool {
    let before_files = store_files(root);
    let before_facts = committed_fact_lines(root);
    let result = sync(root, &effects());
    let conflict = conflict_files(&result);

    if let Some(named_files) = &conflict {
        let named: BTreeSet<String> = named_files.iter().cloned().collect();
        let expected = conflict_oracle(root);

        assert_eq!(
            named, expected,
            "the conflict named files that the merge rules do not predict"
        );
        assert!(
            !root.join(".git/MERGE_HEAD").exists(),
            "a merge is left in progress at {}",
            root.display()
        );
        assert_files_kept(root, &before_files, named_files);
    } else if let Err(error) = result {
        panic!("a generated sync failed: {error:?}");
    }

    assert_committed_facts_stay(&before_facts, &committed_fact_lines(root));

    conflict.is_some()
}

fn conflict_files(result: &Result<SyncOutcome, StoreError>) -> Option<Vec<String>> {
    match result {
        Err(StoreError::Conflict { files, .. }) => Some(
            files
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
        ),
        _ => None,
    }
}

fn conflict_oracle(root: &Path) -> BTreeSet<String> {
    let base = git_text(root, &["merge-base", "HEAD", "refs/remotes/origin/main"]);
    let base = base.trim();
    let mut expected = BTreeSet::new();

    for ticket in 0..TICKETS.len() {
        let path = ticket_path(ticket);
        let at_base = blob_at(root, base, &path);
        let at_head = blob_at(root, "HEAD", &path);
        let at_remote = blob_at(root, "refs/remotes/origin/main", &path);

        if at_base != at_head && at_base != at_remote && at_head != at_remote {
            expected.insert(path);
        }
    }

    expected
}

fn blob_at(root: &Path, revision: &str, path: &str) -> Option<String> {
    let listed = git_text(root, &["ls-tree", "--name-only", revision, "--", path]);

    if listed.trim().is_empty() {
        return None;
    }

    Some(git_text(root, &["show", &format!("{revision}:{path}")]))
}

fn assert_files_kept(root: &Path, before: &[(PathBuf, Vec<u8>)], named_files: &[String]) {
    for file in named_files {
        let path = PathBuf::from(file);
        let before_bytes = before
            .iter()
            .find(|(stored, _)| stored == &path)
            .map(|(_, bytes)| bytes)
            .unwrap_or_else(|| panic!("{file} was missing before the conflict"));
        let after_bytes = fs::read(root.join(&path)).expect("read a conflicted file");

        assert_eq!(
            after_bytes, *before_bytes,
            "{file} did not keep its bytes through the conflict"
        );
    }
}

fn committed_fact_lines(root: &Path) -> Vec<(PathBuf, String)> {
    let listing = git_text(
        root,
        &["ls-tree", "-r", "--name-only", "HEAD", "--", "facts"],
    );
    let mut lines = Vec::new();

    for path in listing.lines().filter(|path| !path.is_empty()) {
        let text = git_text(root, &["show", &format!("HEAD:{path}")]);
        let path = PathBuf::from(path);

        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            lines.push((path.clone(), line.to_owned()));
        }
    }

    lines
}

fn assert_committed_facts_stay(before: &[(PathBuf, String)], after: &[(PathBuf, String)]) {
    for (path, line) in before {
        assert!(
            after
                .iter()
                .any(|(after_path, after_line)| after_path == path && after_line == line),
            "the committed fact line {line} was dropped from {}",
            path.display()
        );
    }
}

fn assert_fact_present(files: &[(PathBuf, Vec<u8>)], path: &Path, line: &str, store: &str) {
    let present = files
        .iter()
        .find(|(stored, _)| stored == path)
        .is_some_and(|(_, bytes)| {
            String::from_utf8_lossy(bytes)
                .lines()
                .any(|stored| stored == line)
        });

    assert!(
        present,
        "the fact line {line} is missing from {} in the {store} store",
        path.display()
    );
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 32,
        rng_seed: RngSeed::Fixed(0x5eed),
        ..ProptestConfig::default()
    })]

    #[test]
    fn generated_two_machine_runs_keep_the_merge_rules(
        steps in prop::collection::vec(step_strategy(), 1..=12)
    ) {
        run_generated_run(&steps);
    }
}

#[test]
fn a_created_ticket_reaches_both_stores_after_the_final_syncs() {
    run_generated_run(&[Step::Create {
        machine: Machine::Laptop,
        ticket: 3,
        title: 0,
    }]);
}

#[test]
fn a_create_writes_the_literal_ticket_text_to_both_stores() {
    let mut run = Run::new();

    run.apply(Step::Create {
        machine: Machine::Laptop,
        ticket: 0,
        title: 0,
    });
    run.finish();

    let path = "tickets/personal/personal-abcd-renew.md";
    let text = "---\nkind: task\ntitle: Title 0\n---\n";

    assert_eq!(
        fs::read_to_string(run.machines.laptop().join(path)).expect("read the laptop ticket"),
        text
    );
    assert_eq!(
        fs::read_to_string(run.machines.desktop().join(path)).expect("read the desktop ticket"),
        text
    );
}

#[test]
fn an_edit_of_a_missing_ticket_writes_nothing() {
    let mut run = Run::new();

    run.apply(Step::Edit {
        machine: Machine::Laptop,
        ticket: 0,
        title: 1,
    });

    let path = "tickets/personal/personal-abcd-renew.md";

    assert!(
        !run.machines.laptop().join(path).exists(),
        "an edit created a missing ticket"
    );
}

#[test]
fn an_edit_of_an_existing_ticket_writes_the_literal_new_text() {
    let mut run = Run::new();
    let path = "tickets/personal/personal-abcd-renew.md";

    write(
        &run.machines.laptop(),
        path,
        "---\nkind: task\ntitle: Title 0\n---\n",
    );
    run.apply(Step::Edit {
        machine: Machine::Laptop,
        ticket: 0,
        title: 1,
    });

    let text = "---\nkind: task\ntitle: Title 1\n---\n";

    assert_eq!(
        fs::read_to_string(run.machines.laptop().join(path)).expect("read the edited ticket"),
        text
    );
}
