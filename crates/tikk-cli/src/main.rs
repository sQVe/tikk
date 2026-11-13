mod app;
mod audit;
mod claim;
mod command;
mod edit;
mod init;
mod ls;
mod needs;
mod new;
mod output;
mod pr;
mod question;
mod ready;
mod show;
mod store_error;
mod sync;
mod ticket_row;

use std::process::ExitCode;

fn main() -> ExitCode {
    let response = app::run(std::env::args_os().collect(), app::Environment::system());

    output::write(&response)
}
