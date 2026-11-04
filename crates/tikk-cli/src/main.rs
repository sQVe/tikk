use clap::Parser;

#[derive(Parser)]
#[command(about = "A local ticket tracker for AI agents")]
struct Cli {}

fn main() {
    Cli::parse();
}

#[cfg(test)]
mod tests {
    use super::Cli;
    use clap::CommandFactory;

    #[test]
    fn help_shows_the_about_text() {
        let about = Cli::command().get_about().map(|about| about.to_string());

        assert_eq!(
            about.as_deref(),
            Some("A local ticket tracker for AI agents")
        );
    }
}
