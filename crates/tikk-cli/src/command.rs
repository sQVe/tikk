use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};
use tikk_core::{Kind, MachineName, ProjectName, Status, StoreError, TicketId};

#[derive(Debug, Parser)]
#[command(
    name = "tikk",
    about = "A local ticket tracker for AI agents",
    disable_version_flag = true,
    disable_help_subcommand = true
)]
pub(crate) struct Cli {
    /// Print the result as JSON on standard output, and errors as JSON on standard error.
    #[arg(long, global = true)]
    pub(crate) json: bool,

    /// Print the version.
    #[arg(long, short = 'V')]
    pub(crate) version: bool,

    #[command(subcommand)]
    pub(crate) command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub(crate) enum Command {
    /// Create the store, or report that it exists.
    Init {
        /// The name of this machine. The default is the host name.
        #[arg(long, value_parser = parse_machine)]
        machine: Option<MachineName>,
    },
    /// Create a ticket and print its ID. It writes the file and makes no commit.
    New(NewArguments),
    /// Show a ticket with its body, children, and folder files.
    Show {
        #[arg(value_name = "ID", value_parser = TicketId::parse)]
        id: TicketId,
    },
    /// List tickets, and the files that fail to parse.
    Ls(LsArguments),
    /// Replace a ticket with a ticket document, if its file still has the given hash.
    Write {
        #[arg(value_name = "ID", value_parser = TicketId::parse)]
        id: TicketId,
        /// The ticket document, such as the `document` of `tikk show --json` with changes.
        #[arg(long, value_name = "PATH")]
        file: PathBuf,
        /// The `hash` of `tikk show --json`. The write is refused when the file has another.
        #[arg(long)]
        hash: String,
    },
    /// Start $EDITOR on the ticket file. tikk changes nothing itself.
    Edit {
        #[arg(value_name = "ID", value_parser = TicketId::parse)]
        id: TicketId,
    },
    /// Mark a task or an instruction done.
    Done {
        #[arg(value_name = "ID", value_parser = TicketId::parse)]
        id: TicketId,
    },
    /// Cancel a ticket, and keep the reason in its file.
    Cancel {
        #[arg(value_name = "ID", value_parser = TicketId::parse)]
        id: TicketId,
        /// Why the ticket is canceled.
        #[arg(long, value_name = "TEXT")]
        reason: String,
    },
}

#[derive(Debug, Args)]
pub(crate) struct NewArguments {
    /// plan, slice, instruction, or task.
    #[arg(
        value_parser = Kind::parse,
        required_unless_present = "file",
        conflicts_with = "file",
        requires = "title"
    )]
    pub(crate) kind: Option<Kind>,
    /// The ticket's title.
    #[arg(required_unless_present = "file", conflicts_with = "file")]
    pub(crate) title: Option<String>,
    /// Create the ticket from a ticket document, in the form of a ticket file.
    #[arg(long, value_name = "PATH")]
    pub(crate) file: Option<PathBuf>,
    /// The parent ticket. The new ticket takes its project.
    #[arg(long, value_name = "ID", value_parser = TicketId::parse, conflicts_with = "file")]
    pub(crate) parent: Option<TicketId>,
    /// The project. The default is the parent's project, or the repository name of `origin`,
    /// or `personal` outside a repository.
    #[arg(long, value_parser = ProjectName::parse)]
    pub(crate) project: Option<ProjectName>,
}

#[derive(Debug, Args)]
pub(crate) struct LsArguments {
    #[arg(long, value_parser = ProjectName::parse)]
    pub(crate) project: Option<ProjectName>,
    /// plan, slice, instruction, or task.
    #[arg(long, value_parser = Kind::parse)]
    pub(crate) kind: Option<Kind>,
    #[arg(long, value_name = "ID", value_parser = TicketId::parse)]
    pub(crate) parent: Option<TicketId>,
    /// draft, open, done, or canceled.
    #[arg(long, value_parser = Status::parse)]
    pub(crate) status: Option<Status>,
    /// Keep tickets whose title or body holds the text, without regard to case.
    #[arg(long, value_name = "TEXT")]
    pub(crate) search: Option<String>,
}

fn parse_machine(name: &str) -> Result<MachineName, StoreError> {
    MachineName::parse(name)
}

#[cfg(test)]
mod tests {
    use clap::{Arg, CommandFactory};

    use super::Cli;

    fn commands_without_json(command: &clap::Command) -> Vec<String> {
        let mut missing = Vec::new();
        let has_json = command
            .get_arguments()
            .any(|argument| argument.get_id() == "json");

        if !has_json {
            missing.push(command.get_name().to_owned());
        }

        for subcommand in command.get_subcommands() {
            missing.extend(commands_without_json(subcommand));
        }

        missing
    }

    fn built_tree() -> clap::Command {
        let mut command = Cli::command();

        command.build();

        command
    }

    #[test]
    fn help_shows_the_about_text() {
        let about = Cli::command().get_about().map(|about| about.to_string());

        assert_eq!(
            about.as_deref(),
            Some("A local ticket tracker for AI agents")
        );
    }

    #[test]
    fn every_command_has_json() {
        assert_eq!(commands_without_json(&built_tree()), Vec::<String>::new());
    }

    #[test]
    fn the_json_walk_names_a_command_without_json() {
        let tree = clap::Command::new("tikk")
            .arg(Arg::new("json").long("json"))
            .subcommand(clap::Command::new("bare"));

        assert_eq!(commands_without_json(&tree), vec!["bare".to_owned()]);
    }
}
