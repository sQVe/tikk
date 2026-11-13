mod agent_name;
mod attention;
mod audit_state;
mod claim_state;
mod fact_line;
mod pr_state;
mod question_state;
mod repository;
mod timestamp;

use thiserror::Error;

pub use agent_name::AgentName;
pub use attention::{
    Attention, AttentionInput, AttentionItem, AttentionProblem, AttentionReason, AttentionState,
    AttentionTicket, attention,
};
pub(crate) use audit_state::last_audits;
pub use audit_state::{Audit, AuditVerdict, ShownAudit, Verdict};
pub(crate) use claim_state::current_claims;
pub use claim_state::{Claim, ClaimState};
pub(crate) use fact_line::{FactEvent, FactLine, parse_fact_line, write_fact_line};
pub(crate) use pr_state::current_prs;
pub use pr_state::{PrObservation, PrState, PullRequest, ShownPr};
pub(crate) use question_state::current_questions;
pub use question_state::{Answer, Question, QuestionItem};
pub use repository::Repository;
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
