use std::any::TypeId;
use std::borrow::Cow;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use clap::CommandFactory;
use clap_complete::CompleteEnv;
use clap_complete::engine::{ArgValueCandidates, CompletionCandidate};
use clap_complete::env::{Bash, EnvCompleter, Fish, Zsh};
use serde_json::json;
use tikk_core::{Kind, StoreError, StoredTicket, TicketId};

use crate::command::{Cli, Shell};
use crate::output::Output;

const COMPLETE_VARIABLE: &str = "COMPLETE";

pub(crate) fn complete_when_asked() {
    CompleteEnv::with_factory(callback_tree)
        .var(COMPLETE_VARIABLE)
        .complete();
}

pub(crate) fn script_output(
    shell: Shell,
    program: &OsStr,
    working_directory: &Path,
) -> Result<Output, StoreError> {
    let completer: &dyn EnvCompleter = match shell {
        Shell::Bash => &Bash,
        Shell::Zsh => &Zsh,
        Shell::Fish => &Fish,
    };
    let callback = callback_program(program, working_directory)?;
    let mut script = Vec::new();

    completer
        .write_registration(COMPLETE_VARIABLE, "tikk", "tikk", &callback, &mut script)
        .expect("writing to memory cannot fail");

    let mut script = String::from_utf8(script).expect("the script is built from UTF-8 strings");

    if matches!(shell, Shell::Bash) {
        script = unquote_bash_callback(&script, &callback);
    }

    let text = script.strip_suffix('\n').unwrap_or(&script).to_owned();

    Ok(Output {
        json: json!({ "script": script }),
        text,
    })
}

// clap_complete puts the shell-quoted path inside double quotes, so bash would look for a program
// whose name holds the single quotes. A path that needs no quotes is left as clap_complete prints it.
fn unquote_bash_callback(script: &str, callback: &str) -> String {
    let Ok(Cow::Owned(quoted)) = shlex::try_quote(callback) else {
        return script.to_owned();
    };

    script.replace(&format!("\"{quoted}\" --"), &format!("{quoted} --"))
}

fn callback_program(program: &OsStr, working_directory: &Path) -> Result<String, StoreError> {
    let mut path = PathBuf::from(program);

    if path.components().count() > 1 {
        path = working_directory.join(path);
    }

    path.into_os_string()
        .into_string()
        .map_err(|path| StoreError::ProgramNotUnicode {
            path: PathBuf::from(path),
        })
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

impl Offer {
    fn for_argument(argument: &str) -> Self {
        match argument {
            "parent" => Self::Parents,
            "before" | "after" => Self::Siblings,
            _ => Self::Every,
        }
    }
}

// The first positional argument of the command being completed.
#[derive(Debug, PartialEq, Eq)]
enum Subject {
    Ticket(TicketId),
    Kind(Kind),
    // The command takes no subject, such as `tikk ls`.
    Absent,
    // The command takes a subject, but the line holds none that parses.
    Unknown,
}

struct Lookup {
    store: Option<PathBuf>,
    subject: Subject,
}

fn completion_tree(words: &[OsString], store: Option<PathBuf>) -> clap::Command {
    let lookup = Arc::new(Lookup {
        store,
        subject: subject(words),
    });

    with_candidates(Cli::command(), &lookup)
}

fn with_candidates(command: clap::Command, lookup: &Arc<Lookup>) -> clap::Command {
    let command = command.mut_args(|arg| {
        if !takes_ticket_id(&arg) {
            return arg;
        }

        let offer = Offer::for_argument(arg.get_id().as_str());

        arg.add(candidates(Arc::clone(lookup), offer))
    });
    let names: Vec<String> = command
        .get_subcommands()
        .map(|subcommand| subcommand.get_name().to_owned())
        .collect();

    names.iter().fold(command, |command, name| {
        command.mut_subcommand(name, |subcommand| with_candidates(subcommand, lookup))
    })
}

fn takes_ticket_id(arg: &clap::Arg) -> bool {
    arg.get_value_parser().type_id() == TypeId::of::<TicketId>()
}

fn candidates(lookup: Arc<Lookup>, offer: Offer) -> ArgValueCandidates {
    ArgValueCandidates::new(move || offered_tickets(&lookup, offer))
}

fn offered_tickets(lookup: &Lookup, offer: Offer) -> Vec<CompletionCandidate> {
    let tickets = readable_tickets(lookup.store.as_deref());
    let filter = Filter::new(offer, &lookup.subject, &tickets);

    tickets
        .iter()
        .filter(|ticket| filter.keeps(ticket))
        .map(|ticket| {
            CompletionCandidate::new(ticket.id.to_string())
                .help(Some(ticket.document.fields.title().to_owned().into()))
        })
        .collect()
}

// Without a known subject, every ticket is offered, because the command checks the kind itself.
enum Filter<'a> {
    Every,
    ParentsOf(Kind),
    AnyParent,
    SiblingsOf(&'a StoredTicket),
}

impl<'a> Filter<'a> {
    fn new(offer: Offer, subject: &Subject, tickets: &'a [StoredTicket]) -> Self {
        let stored = match subject {
            Subject::Ticket(id) => tickets.iter().find(|ticket| ticket.id == *id),
            _ => None,
        };

        match (offer, subject, stored) {
            (Offer::Parents, Subject::Kind(kind), _) => Self::ParentsOf(*kind),
            (Offer::Parents, Subject::Absent, _) => Self::AnyParent,
            (Offer::Parents, _, Some(stored)) => Self::ParentsOf(stored.document.fields.kind()),
            (Offer::Siblings, _, Some(stored)) => Self::SiblingsOf(stored),
            _ => Self::Every,
        }
    }

    fn keeps(&self, ticket: &StoredTicket) -> bool {
        let kind = ticket.document.fields.kind();

        match self {
            Self::Every => true,
            Self::ParentsOf(child) => child.can_sit_under(kind),
            Self::AnyParent => kind.can_hold_children(),
            Self::SiblingsOf(subject) => {
                ticket.id != subject.id && tikk_core::are_siblings(subject, ticket)
            }
        }
    }
}

fn readable_tickets(store: Option<&Path>) -> Vec<StoredTicket> {
    let Some(store) = store else {
        return Vec::new();
    };
    let read = tikk_core::open(store).and_then(|store| tikk_core::read_tickets_unlocked(&store));

    read.unwrap_or_default()
}

fn subject(words: &[OsString]) -> Subject {
    let tree = Cli::command();
    let Ok(matches) = tree.clone().ignore_errors(true).try_get_matches_from(words) else {
        return Subject::Unknown;
    };
    let (mut command, mut arguments) = (&tree, &matches);

    while let Some((name, subcommand_arguments)) = arguments.subcommand() {
        let Some(subcommand) = command.find_subcommand(name) else {
            return Subject::Unknown;
        };

        (command, arguments) = (subcommand, subcommand_arguments);
    }

    let Some(first) = command.get_positionals().next() else {
        return Subject::Absent;
    };
    let id = first.get_id().as_str();

    if let Ok(Some(ticket)) = arguments.try_get_one::<TicketId>(id) {
        return Subject::Ticket(ticket.clone());
    }

    if let Ok(Some(kind)) = arguments.try_get_one::<Kind>(id) {
        return Subject::Kind(*kind);
    }

    Subject::Unknown
}

#[cfg(test)]
mod tests {
    use std::ffi::{OsStr, OsString};
    use std::path::Path;

    use tikk_core::{Kind, TicketId};

    use super::{Subject, callback_program, callback_words, subject};

    fn words(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn the_subject_is_the_first_positional_of_the_command_on_the_line() {
        let id = || Subject::Ticket(TicketId::parse("personal-kkkk").expect("a valid ID"));
        let cases = [
            (&["tikk", "move", "personal-kkkk", "--parent", ""][..], id()),
            (
                &["tikk", "--json", "move", "personal-kkkk", "--parent", ""][..],
                id(),
            ),
            (
                &["tikk", "move", "--parent", "personal-pppp", "personal-kkkk"][..],
                id(),
            ),
            (&["tikk", "move", "--parent", ""][..], Subject::Unknown),
            (&["tikk", "move", "personal"][..], Subject::Unknown),
            (&["tikk", "rank", "personal-kkkk", "--before", ""][..], id()),
            (&["tikk", "rank", "personal-kkkk", "--after"][..], id()),
            (
                &["tikk", "move", "personal-kkkk", "--bogus", "--parent", ""][..],
                id(),
            ),
            (&["tikk", "pr", "refresh", "personal-kkkk"][..], id()),
            (&["tikk", "ls", "--search", "move"][..], Subject::Absent),
            (
                &["tikk", "ls", "--search", "move", "personal-kkkk"][..],
                Subject::Absent,
            ),
            (
                &["tikk", "ls", "--kind", "task", "--parent", ""][..],
                Subject::Absent,
            ),
            (&["tikk", "mo"][..], Subject::Absent),
            (
                &["tikk", "new", "slice", "Add", "--parent", ""][..],
                Subject::Kind(Kind::Slice),
            ),
            (&["tikk", "new", "--parent", ""][..], Subject::Unknown),
        ];

        for (values, expected) in cases {
            assert_eq!(subject(&words(values)), expected, "case {values:?}");
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

    #[test]
    fn a_bare_program_name_stays_bare_and_a_path_joins_the_working_directory() {
        let working_directory = Path::new("/work");
        let cases = [
            ("tikk", "tikk"),
            ("bin/tikk", "/work/bin/tikk"),
            ("./tikk", "/work/./tikk"),
            ("/usr/bin/tikk", "/usr/bin/tikk"),
        ];

        for (program, expected) in cases {
            assert_eq!(
                callback_program(OsStr::new(program), working_directory).expect("a Unicode path"),
                expected,
                "case {program}"
            );
        }
    }
}
