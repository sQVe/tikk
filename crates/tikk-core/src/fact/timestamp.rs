use std::fmt;
use std::sync::LazyLock;
use std::time::{Duration, SystemTime};

use time::format_description::BorrowedFormatItem;
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, UtcOffset};

use crate::fact::FactError;

static TEXT_FORMAT: LazyLock<Vec<BorrowedFormatItem<'static>>> = LazyLock::new(|| {
    time::format_description::parse_borrowed::<2>(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z",
    )
    .expect("the timestamp format is valid")
});
static MONTH_FORMAT: LazyLock<Vec<BorrowedFormatItem<'static>>> = LazyLock::new(|| {
    time::format_description::parse_borrowed::<2>("[year]-[month]")
        .expect("the month format is valid")
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(OffsetDateTime);

impl Timestamp {
    pub(crate) fn from_system_time(time: SystemTime) -> Self {
        Self::new(OffsetDateTime::from(time))
    }

    pub(crate) fn parse(text: &str) -> Result<Self, FactError> {
        OffsetDateTime::parse(text, &Rfc3339)
            .map(Self::new)
            .map_err(|error| FactError::new(format!("`{text}` is not an RFC 3339 time: {error}")))
    }

    pub(crate) fn after(self, duration: Duration) -> Self {
        Self::new(self.0 + duration)
    }

    pub(crate) fn month(self) -> String {
        self.0
            .format(&MONTH_FORMAT)
            .expect("a UTC date formats as a month")
    }

    fn new(moment: OffsetDateTime) -> Self {
        let utc = moment.to_offset(UtcOffset::UTC);
        let milliseconds = utc.millisecond();

        Self(
            utc.replace_millisecond(milliseconds)
                .expect("a millisecond of a valid time is valid"),
        )
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = self
            .0
            .format(&TEXT_FORMAT)
            .expect("a UTC time formats as RFC 3339");

        formatter.write_str(&text)
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use super::Timestamp;

    #[test]
    fn parse_reads_any_offset_and_prints_utc_to_the_millisecond() {
        let cases = [
            ("2026-11-13T01:02:03Z", "2026-11-13T01:02:03.000Z"),
            ("2026-11-13T01:02:03.456789Z", "2026-11-13T01:02:03.456Z"),
            ("2026-11-13T03:02:03+02:00", "2026-11-13T01:02:03.000Z"),
        ];

        for (text, expected) in cases {
            let parsed = Timestamp::parse(text).expect("an RFC 3339 time parses");

            assert_eq!(parsed.to_string(), expected, "case {text}");
        }
    }

    #[test]
    fn parse_refuses_text_that_is_not_rfc_3339() {
        for text in ["", "2026-11-13", "yesterday", "2026-11-13 01:02:03"] {
            let error = Timestamp::parse(text).expect_err("not an RFC 3339 time");

            assert!(error.to_string().contains("RFC 3339"), "case {text:?}");
        }
    }

    #[test]
    fn after_adds_the_duration_and_month_names_the_utc_month() {
        let start = Timestamp::parse("2026-11-30T22:00:00Z").expect("a valid time");

        let later = start.after(Duration::from_secs(4 * 60 * 60));

        assert_eq!(later.to_string(), "2026-12-01T02:00:00.000Z");
        assert_eq!(start.month(), "2026-11");
        assert_eq!(later.month(), "2026-12");
        assert!(start < later);
    }

    #[test]
    fn from_system_time_drops_the_part_below_a_millisecond() {
        let time = SystemTime::UNIX_EPOCH + Duration::from_nanos(1_500_999);

        assert_eq!(
            Timestamp::from_system_time(time).to_string(),
            "1970-01-01T00:00:00.001Z"
        );
    }
}
