use std::collections::BTreeSet;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use proptest::prelude::*;
use proptest::test_runner::RngSeed;

use super::{CLOCK, Machines, effects, later, sync, write};
use crate::store::StoreError;
use crate::store::sync::{SyncOutcome, SyncStep};
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
    appended: Vec<String>,
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
        let text = fact_line(line, self.append_count);

        append(
            &root,
            &format!("facts/{}/2026-11.jsonl", machine.name()),
            &format!("{text}\n"),
        );
        self.appended.push(text);
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

        for line in &self.appended {
            assert_fact_present(&laptop_files, line, "laptop");
            assert_fact_present(&desktop_files, line, "desktop");
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
        Ok(outcome) => outcome
            .problems
            .iter()
            .find(|problem| problem.step == SyncStep::Merge && !problem.files.is_empty())
            .map(|problem| problem.files.clone()),
        Err(StoreError::Conflict { files, .. }) => Some(
            files
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
        ),
        Err(_) => None,
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

fn committed_fact_lines(root: &Path) -> Vec<String> {
    let listing = git_text(
        root,
        &["ls-tree", "-r", "--name-only", "HEAD", "--", "facts"],
    );
    let mut lines = Vec::new();

    for path in listing.lines().filter(|path| !path.is_empty()) {
        let text = git_text(root, &["show", &format!("HEAD:{path}")]);

        lines.extend(
            text.lines()
                .filter(|line| !line.trim().is_empty())
                .map(str::to_owned),
        );
    }

    lines
}

fn assert_committed_facts_stay(before: &[String], after: &[String]) {
    for line in before {
        assert!(
            after.contains(line),
            "a committed fact line was dropped: {line}"
        );
    }
}

fn assert_fact_present(files: &[(PathBuf, Vec<u8>)], line: &str, store: &str) {
    let present = files
        .iter()
        .filter(|(path, _)| path.starts_with("facts"))
        .any(|(_, bytes)| {
            String::from_utf8_lossy(bytes)
                .lines()
                .any(|stored| stored == line)
        });

    assert!(
        present,
        "the fact line {line} is missing from the {store} store"
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
