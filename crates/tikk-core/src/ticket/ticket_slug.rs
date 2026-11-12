use crate::ticket::TicketId;

const SLUG_LIMIT: usize = 50;

/// The file name of a new ticket, `<id>-<slug>.md`, or `<id>.md` when the title gives no slug.
pub(crate) fn ticket_file_name(id: &TicketId, title: &str) -> String {
    let slug = slug(title);

    if slug.is_empty() {
        return format!("{id}.md");
    }

    format!("{id}-{slug}.md")
}

/// Lowercase ASCII words of the title joined by hyphens, cut at a word end within the limit.
fn slug(title: &str) -> String {
    let mut slug = String::new();
    let words = title
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty());

    for word in words {
        let separator = usize::from(!slug.is_empty());

        if slug.len() + separator + word.len() > SLUG_LIMIT {
            if slug.is_empty() {
                slug.push_str(&word[..SLUG_LIMIT].to_ascii_lowercase());
            }

            break;
        }

        if separator == 1 {
            slug.push('-');
        }

        slug.push_str(&word.to_ascii_lowercase());
    }

    slug
}

#[cfg(test)]
mod tests {
    use super::{slug, ticket_file_name};
    use crate::ticket::TicketId;

    #[test]
    fn slug_joins_lowercase_ascii_words() {
        let long_word = "a".repeat(60);
        let fits_exactly = format!("{} bcde", "a".repeat(45));
        let one_over = format!("{} bcdef", "a".repeat(45));
        let cases = [
            (
                "Decide the lease length",
                "decide-the-lease-length".to_owned(),
            ),
            ("Ask about Windows?!", "ask-about-windows".to_owned()),
            ("Lås upp: v2 API", "l-s-upp-v2-api".to_owned()),
            ("!!!", String::new()),
            (
                "one two three four five six seven eight nine ten eleven",
                "one-two-three-four-five-six-seven-eight-nine-ten".to_owned(),
            ),
            (long_word.as_str(), "a".repeat(50)),
            (fits_exactly.as_str(), format!("{}-bcde", "a".repeat(45))),
            (one_over.as_str(), "a".repeat(45)),
        ];

        for (title, expected) in cases {
            assert_eq!(slug(title), expected, "case {title:?}");
        }
    }

    #[test]
    fn ticket_file_name_leaves_out_an_empty_slug() {
        let id = TicketId::parse("personal-abcd").expect("a valid ID");

        assert_eq!(
            ticket_file_name(&id, "Move to tikk"),
            "personal-abcd-move-to-tikk.md"
        );
        assert_eq!(ticket_file_name(&id, "???"), "personal-abcd.md");
    }
}
