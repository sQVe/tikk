use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};
use tikk_core::{
    Kind, MachineName, ProjectName, PullRequest, RankPlace, Repository, Status, StoreError,
    TicketId,
};

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
        /// Clone the store from this Git remote, or create the store and push it when the remote
        /// is empty. A store that already exists is reported and not attached to the remote.
        #[arg(long, value_name = "URL")]
        remote: Option<String>,
    },
    /// Commit the settled files, merge the remote's changes, and push. Network failures are
    /// reported in `problems`.
    Sync,
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
    /// Make a ticket wait on a blocker until the blocker is done.
    Block {
        #[arg(value_name = "ID", value_parser = TicketId::parse)]
        id: TicketId,
        #[arg(value_name = "BLOCKER", value_parser = TicketId::parse)]
        blocker: TicketId,
    },
    /// Remove a blocker from a ticket.
    Unblock {
        #[arg(value_name = "ID", value_parser = TicketId::parse)]
        id: TicketId,
        #[arg(value_name = "BLOCKER", value_parser = TicketId::parse)]
        blocker: TicketId,
    },
    /// Move a ticket under another parent, or make it loose. A new parent clears its rank.
    Move {
        #[arg(value_name = "ID", value_parser = TicketId::parse)]
        id: TicketId,
        #[command(flatten)]
        new_parent: NewParent,
    },
    /// Order a ticket among the tickets with the same parent.
    Rank {
        #[arg(value_name = "ID", value_parser = TicketId::parse)]
        id: TicketId,
        #[command(flatten)]
        place: RankArguments,
    },
    /// Claim a slice for TIKK_AGENT for 4 hours, or renew the agent's own claim.
    Claim {
        #[arg(value_name = "ID", value_parser = TicketId::parse)]
        id: TicketId,
    },
    /// End the claim on a slice. Without TIKK_AGENT, it ends any claim.
    Release {
        #[arg(value_name = "ID", value_parser = TicketId::parse)]
        id: TicketId,
    },
    /// List the slices that can start, in rank order, and what holds each of the others.
    Ready(ReadyArguments),
    /// Record a verdict for criteria of a slice, seen at a PR head. By the claim holder, it renews
    /// the lease. It runs no `gh`.
    Audit(AuditArguments),
    /// Record the PR of a slice, and read the state of linked PRs. Only these commands run `gh`.
    Pr {
        #[command(subcommand)]
        command: PrCommand,
    },
}

#[derive(Debug, Subcommand)]
pub(crate) enum PrCommand {
    /// Read the PR through `gh` and record it as the slice's PR. By the claim holder, it renews
    /// the lease.
    Link {
        #[arg(value_name = "ID", value_parser = TicketId::parse)]
        id: TicketId,
        /// The PR, as `https://github.com/<owner>/<name>/pull/<number>`.
        #[arg(value_name = "URL", value_parser = parse_pr_url)]
        url: PullRequest,
    },
    /// Read through `gh` every linked PR not yet seen in trunk, or the PR of the given slice, and
    /// record each state.
    Refresh {
        #[arg(value_name = "ID", value_parser = TicketId::parse)]
        id: Option<TicketId>,
    },
}

#[derive(Debug, Args)]
#[group(required = true, multiple = false)]
pub(crate) struct NewParent {
    /// The new parent, in the ticket's project.
    #[arg(long, value_name = "ID", value_parser = TicketId::parse)]
    pub(crate) parent: Option<TicketId>,
    /// Leave the ticket with no parent.
    #[arg(long)]
    pub(crate) no_parent: bool,
}

#[derive(Debug, Args)]
#[group(required = true, multiple = false)]
pub(crate) struct RankArguments {
    /// Put the ticket before all its siblings.
    #[arg(long)]
    first: bool,
    /// Put the ticket after all its siblings.
    #[arg(long)]
    last: bool,
    /// Put the ticket just before this sibling.
    #[arg(long, value_name = "ID", value_parser = TicketId::parse)]
    before: Option<TicketId>,
    /// Put the ticket just after this sibling.
    #[arg(long, value_name = "ID", value_parser = TicketId::parse)]
    after: Option<TicketId>,
}

impl RankArguments {
    pub(crate) fn place(self) -> RankPlace {
        if let Some(anchor) = self.before {
            return RankPlace::Before(anchor);
        }

        if let Some(anchor) = self.after {
            return RankPlace::After(anchor);
        }

        if self.first {
            return RankPlace::First;
        }

        RankPlace::Last
    }
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

#[derive(Debug, Args)]
pub(crate) struct AuditArguments {
    #[arg(value_name = "ID", value_parser = TicketId::parse)]
    pub(crate) id: TicketId,
    /// The `hash` of `tikk show --json`. The audit is refused when the file has another.
    #[arg(long)]
    pub(crate) hash: String,
    /// The PR head commit the audit saw.
    #[arg(long, value_name = "SHA", value_parser = parse_head)]
    pub(crate) head: String,
    /// A JSON list of `{"criterion", "verdict", "evidence"}`, with the verdict `met`, `not-met`,
    /// `not-run`, or `deferred`.
    #[arg(long, value_name = "PATH")]
    pub(crate) file: PathBuf,
    /// The repository as `owner/name`. The default is the GitHub repository of `origin`.
    #[arg(long, value_name = "OWNER/NAME", value_parser = parse_repository)]
    pub(crate) repository: Option<Repository>,
}

#[derive(Debug, Args)]
pub(crate) struct ReadyArguments {
    /// The plan whose slices to list.
    #[arg(long, value_name = "ID", value_parser = TicketId::parse)]
    pub(crate) parent: Option<TicketId>,
    /// The project whose slices to list. The default is the repository name of `origin`, or
    /// `personal` outside a repository.
    #[arg(long, value_parser = ProjectName::parse, conflicts_with = "parent")]
    pub(crate) project: Option<ProjectName>,
}

fn parse_machine(name: &str) -> Result<MachineName, StoreError> {
    MachineName::parse(name)
}

fn parse_head(head: &str) -> Result<String, String> {
    if head.trim().is_empty() {
        return Err("the head must name a commit".to_owned());
    }

    Ok(head.to_owned())
}

fn parse_repository(repository: &str) -> Result<Repository, String> {
    Repository::parse(repository)
        .ok_or_else(|| format!("`{repository}` is not a repository; use <owner>/<name>"))
}

fn parse_pr_url(url: &str) -> Result<PullRequest, String> {
    PullRequest::from_url(url).ok_or_else(|| {
        format!("`{url}` is not a PR URL; use https://github.com/<owner>/<name>/pull/<number>")
    })
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
