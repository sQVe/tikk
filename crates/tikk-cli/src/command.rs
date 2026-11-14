use clap::{Parser, Subcommand};
use tikk_core::{MachineName, StoreError};

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
