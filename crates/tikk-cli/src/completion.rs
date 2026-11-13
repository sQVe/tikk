use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use clap::CommandFactory;
use clap_complete::CompleteEnv;
use clap_complete::engine::{ArgValueCandidates, CompletionCandidate};
use clap_complete::env::{Bash, EnvCompleter, Fish, Zsh};
use serde_json::json;
use tikk_core::{StoredTicket, TicketId};

use crate::command::{Cli, Shell};
use crate::output::Output;

const COMPLETE_VARIABLE: &str = "COMPLETE";

// Flags whose next word is their value, not the subject ID.
const VALUE_FLAGS: &[&str] = &["--parent", "--before", "--after"];

// Answers the shell and exits the process when `COMPLETE` names a shell, and returns otherwise.
pub(crate) fn complete_when_asked() {
    CompleteEnv::with_factory(callback_tree)
        .var(COMPLETE_VARIABLE)
        .complete();
}

pub(crate) fn script_output(shell: Shell, program: &OsStr, working_directory: &Path) -> Output {
    let completer: &dyn EnvCompleter = match shell {
        Shell::Bash => &Bash,
        Shell::Zsh => &Zsh,
        Shell::Fish => &Fish,
    };
    let mut script = Vec::new();

    completer
        .write_registration(
            COMPLETE_VARIABLE,
            "tikk",
            "tikk",
            &callback_program(program, working_directory),
            &mut script,
        )
        .expect("writing to memory cannot fail");

    let script = String::from_utf8(script).expect("the script is built from UTF-8 strings");
    let text = script.strip_suffix('\n').unwrap_or(&script).to_owned();

    Output {
        json: json!({ "script": script }),
        text,
    }
}

// The program is found the way `CompleteEnv` finds it, so the script equals the one that
// `COMPLETE=<shell> tikk` prints.
fn callback_program(program: &OsStr, working_directory: &Path) -> String {
    let mut path = PathBuf::from(program);

    if path.components().count() > 1 {
        path = working_directory.join(path);
    }

    path.to_string_lossy().into_owned()
}

fn callback_tree() -> clap::Command {
    let words = callback_words(std::env::args_os());
    // A shell prompt has no place for an error, so a store without a path offers no ID.
    let store = tikk_core::store_path(std::env::var_os("TIKK_HOME"), std::env::var_os("HOME")).ok();

    completion_tree(&words, store)
}

fn callback_words(arguments: impl Iterator<Item = OsString>) -> Vec<OsString> {
    arguments
        .skip(1)
        .skip_while(|argument| argument != "--")
        .skip(1)
        .collect()
}

#[derive(Clone, Copy)]
enum Offer {
    Every,
    Parents,
    Siblings,
}

struct Lookup {
    store: Option<PathBuf>,
    subject: Option<TicketId>,
}

fn completion_tree(words: &[OsString], store: Option<PathBuf>) -> clap::Command {
    let every = candidates(
        Lookup {
            store: store.clone(),
            subject: None,
        },
        Offer::Every,
    );
    let parents = candidates(
        Lookup {
            store: store.clone(),
            subject: subject(words, "move"),
        },
        Offer::Parents,
    );
    let siblings = candidates(
        Lookup {
            store,
            subject: subject(words, "rank"),
        },
        Offer::Siblings,
    );
    let mut tree = Cli::command();

    for name in [
        "show", "edit", "write", "done", "cancel", "claim", "release", "ask", "answer", "audit",
    ] {
        tree = with_candidates(tree, name, &["id"], &every);
    }

    tree = with_candidates(tree, "block", &["id", "blocker"], &every);
    tree = with_candidates(tree, "unblock", &["id", "blocker"], &every);
    tree = with_candidates(tree, "move", &["id"], &every);
    tree = with_candidates(tree, "move", &["parent"], &parents);
    tree = with_candidates(tree, "rank", &["id"], &every);
    tree = with_candidates(tree, "rank", &["before", "after"], &siblings);

    tree.mut_subcommand("pr", |pr| {
        let pr = with_candidates(pr, "link", &["id"], &every);

        with_candidates(pr, "refresh", &["id"], &every)
    })
}

fn with_candidates(
    tree: clap::Command,
    subcommand: &str,
    arguments: &[&str],
    candidates: &ArgValueCandidates,
) -> clap::Command {
    // `mut_arg` would move the argument to the end, and so change the order of the positionals.
    tree.mut_subcommand(subcommand, |command| {
        command.mut_args(|arg| {
            if arguments.contains(&arg.get_id().as_str()) {
                arg.add(candidates.clone())
            } else {
                arg
            }
        })
    })
}

fn candidates(lookup: Lookup, offer: Offer) -> ArgValueCandidates {
    ArgValueCandidates::new(move || offered_tickets(&lookup, offer))
}

fn offered_tickets(lookup: &Lookup, offer: Offer) -> Vec<CompletionCandidate> {
    let tickets = readable_tickets(lookup.store.as_deref());
    let subject = lookup
        .subject
        .as_ref()
        .and_then(|id| tickets.iter().find(|ticket| ticket.id == *id));

    tickets
        .iter()
        .filter(|ticket| offers(offer, subject, ticket))
        .map(|ticket| {
            CompletionCandidate::new(ticket.id.to_string())
                .help(Some(ticket.document.fields.title().to_owned().into()))
        })
        .collect()
}

// Without a known subject, every ticket is offered, because the command checks the kind itself.
fn offers(offer: Offer, subject: Option<&StoredTicket>, ticket: &StoredTicket) -> bool {
    let Some(subject) = subject else {
        return true;
    };

    match offer {
        Offer::Every => true,
        Offer::Parents => subject
            .document
            .fields
            .kind()
            .can_sit_under(ticket.document.fields.kind()),
        Offer::Siblings => ticket.id != subject.id && tikk_core::are_siblings(subject, ticket),
    }
}

// Reads without the store lock and without a sync, so completion never waits and never writes.
fn readable_tickets(store: Option<&Path>) -> Vec<StoredTicket> {
    let Some(store) = store else {
        return Vec::new();
    };
    let read = tikk_core::open(store).and_then(|store| tikk_core::read_tickets_unlocked(&store));

    // A shell prompt has no place for an error, so a store that cannot be read offers no ID.
    read.unwrap_or_default()
}

fn subject(words: &[OsString], command: &str) -> Option<TicketId> {
    let mut positionals = Vec::new();
    let mut skips_value = false;

    for word in words.iter().skip(1) {
        let word = word.to_str()?;

        if skips_value {
            skips_value = false;
            continue;
        }

        if VALUE_FLAGS.contains(&word) {
            skips_value = true;
            continue;
        }

        if !word.starts_with('-') {
            positionals.push(word);
        }
    }

    match positionals.as_slice() {
        [name, id, ..] if *name == command => TicketId::parse(id).ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use tikk_core::TicketId;

    use super::{callback_words, subject};

    fn words(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn the_subject_is_the_first_word_after_the_command_that_no_flag_takes() {
        let moved = TicketId::parse("personal-kkkk").expect("a valid ID");
        let cases = [
            (
                &["tikk", "move", "personal-kkkk", "--parent", ""][..],
                Some(&moved),
            ),
            (
                &["tikk", "--json", "move", "personal-kkkk", "--parent", ""][..],
                Some(&moved),
            ),
            (
                &["tikk", "move", "--parent", "personal-pppp", "personal-kkkk"][..],
                Some(&moved),
            ),
            (&["tikk", "move", "--parent", ""][..], None),
            (&["tikk", "rank", "personal-kkkk", "--before", ""][..], None),
            (&["tikk", "move", "personal"][..], None),
        ];

        for (values, expected) in cases {
            assert_eq!(
                subject(&words(values), "move").as_ref(),
                expected,
                "case {values:?}"
            );
        }
    }

    #[test]
    fn the_callback_words_follow_the_double_dash() {
        let arguments = words(&["/bin/tikk", "--", "tikk", "show", ""]);

        assert_eq!(
            callback_words(arguments.into_iter()),
            words(&["tikk", "show", ""])
        );
    }
}
