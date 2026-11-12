mod project;
mod ticket_document;
mod ticket_fields;
mod ticket_id;
mod ticket_kind;
mod ticket_links;
mod ticket_slug;

use thiserror::Error;

pub use project::ProjectName;
pub use ticket_document::TicketDocument;
pub(crate) use ticket_document::write_document;
pub use ticket_fields::{Criterion, TicketFields};
pub use ticket_id::{ID_ALPHABET, TicketId};
pub use ticket_kind::{Kind, Status};
pub(crate) use ticket_slug::ticket_file_name;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TicketError {
    #[error("`{value}` is not a project name: {reason}.")]
    InvalidProject { value: String, reason: &'static str },
    #[error("`{value}` is not a ticket ID: {reason}.")]
    InvalidId { value: String, reason: &'static str },
    #[error("`{value}` is not a kind. Use plan, slice, instruction, or task.")]
    InvalidKind { value: String },
    #[error("`{value}` is not a status. Use draft, open, done, or canceled.")]
    InvalidStatus { value: String },
    #[error("The ticket document does not parse: {message}")]
    Parse { message: String },
    #[error("`{field}` {problem}.")]
    Invalid { field: String, problem: String },
}

impl TicketError {
    pub(crate) fn invalid(field: impl Into<String>, problem: impl Into<String>) -> Self {
        Self::Invalid {
            field: field.into(),
            problem: problem.into(),
        }
    }
}
