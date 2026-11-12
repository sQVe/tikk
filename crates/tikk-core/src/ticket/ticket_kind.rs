use std::fmt;

use crate::ticket::TicketError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Plan,
    Slice,
    Instruction,
    Task,
}

impl Kind {
    pub fn parse(text: &str) -> Result<Self, TicketError> {
        match text {
            "plan" => Ok(Self::Plan),
            "slice" => Ok(Self::Slice),
            "instruction" => Ok(Self::Instruction),
            "task" => Ok(Self::Task),
            _ => Err(TicketError::InvalidKind {
                value: text.to_owned(),
            }),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Slice => "slice",
            Self::Instruction => "instruction",
            Self::Task => "task",
        }
    }

    pub(crate) fn allows(self, status: Status) -> bool {
        match self {
            Self::Plan | Self::Slice => {
                matches!(status, Status::Draft | Status::Open | Status::Canceled)
            }
            Self::Instruction | Self::Task => {
                matches!(status, Status::Open | Status::Done | Status::Canceled)
            }
        }
    }

    pub(crate) fn has_criteria(self) -> bool {
        matches!(self, Self::Plan | Self::Slice)
    }
}

impl fmt::Display for Kind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// The status stored in a ticket file. Derived states such as ready or active are not here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Status {
    Draft,
    Open,
    Done,
    Canceled,
}

impl Status {
    pub fn parse(text: &str) -> Result<Self, TicketError> {
        match text {
            "draft" => Ok(Self::Draft),
            "open" => Ok(Self::Open),
            "done" => Ok(Self::Done),
            "canceled" => Ok(Self::Canceled),
            _ => Err(TicketError::InvalidStatus {
                value: text.to_owned(),
            }),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Open => "open",
            Self::Done => "done",
            Self::Canceled => "canceled",
        }
    }
}

impl fmt::Display for Status {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::{Kind, Status};
    use crate::ticket::TicketError;

    #[test]
    fn kind_and_status_names_round_trip() {
        for kind in [Kind::Plan, Kind::Slice, Kind::Instruction, Kind::Task] {
            assert_eq!(Kind::parse(kind.as_str()), Ok(kind), "case {kind}");
        }

        for status in [Status::Draft, Status::Open, Status::Done, Status::Canceled] {
            assert_eq!(Status::parse(status.as_str()), Ok(status), "case {status}");
        }
    }

    #[test]
    fn unknown_names_are_refused() {
        assert_eq!(
            Kind::parse("epic"),
            Err(TicketError::InvalidKind {
                value: "epic".to_owned()
            })
        );
        assert_eq!(
            Status::parse("Open"),
            Err(TicketError::InvalidStatus {
                value: "Open".to_owned()
            })
        );
    }

    #[test]
    fn each_kind_allows_its_stored_statuses() {
        let cases = [
            (Kind::Plan, [true, true, false, true]),
            (Kind::Slice, [true, true, false, true]),
            (Kind::Instruction, [false, true, true, true]),
            (Kind::Task, [false, true, true, true]),
        ];
        let statuses = [Status::Draft, Status::Open, Status::Done, Status::Canceled];

        for (kind, expected) in cases {
            let allowed = statuses.map(|status| kind.allows(status));

            assert_eq!(allowed, expected, "case {kind}");
        }
    }
}
