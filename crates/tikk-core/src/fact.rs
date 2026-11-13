mod agent_name;
mod claim_state;
mod fact_line;
mod timestamp;

use thiserror::Error;

pub use agent_name::AgentName;
pub(crate) use claim_state::current_claims;
pub use claim_state::{Claim, ClaimState};
pub(crate) use fact_line::{FactEvent, FactLine, parse_fact_line, write_fact_line};
pub use timestamp::Timestamp;

#[derive(Debug, Error, PartialEq, Eq)]
#[error("{message}")]
pub(crate) struct FactError {
    message: String,
}

impl FactError {
    fn new(message: String) -> Self {
        Self { message }
    }
}
