mod app;
mod command;
mod init;
mod output;
mod store_error;

use std::process::ExitCode;

fn main() -> ExitCode {
    let response = app::run(std::env::args_os().collect(), app::Environment::system());

    output::write(&response)
}
