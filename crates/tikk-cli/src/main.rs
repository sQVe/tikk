mod app;
mod command;
mod edit;
mod init;
mod ls;
mod new;
mod output;
mod show;
mod store_error;
mod ticket_row;

use std::process::ExitCode;

fn main() -> ExitCode {
    let response = app::run(std::env::args_os().collect(), app::Environment::system());

    output::write(&response)
}
