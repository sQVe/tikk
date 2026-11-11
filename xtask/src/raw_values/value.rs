use ra_ap_rustc_lexer::{FrontmatterAllowed, tokenize};

const RAW_CALLS: &[&str] = &["px", "rems", "rems_from_px", "rgb", "rgba", "hsla", "hsl"];

const NAMED_COLORS: &[&str] = &[
    "white",
    "black",
    "red",
    "green",
    "blue",
    "yellow",
    "transparent_black",
    "transparent_white",
    "opaque_grey",
];

const CONSTRUCTORS: &[&str] = &["Pixels", "Rgba", "Hsla"];

// The style helpers that encode a fixed scale. `full` and `auto` are left out: they are relative
// layout values with no raw length, such as `size_full`.
const BOX_PREFIXES: &[&str] = &[
    "w", "h", "size", "min_size", "min_w", "min_h", "max_size", "max_w", "max_h", "gap", "gap_x",
    "gap_y", "p", "pt", "pb", "px", "py", "pl", "pr", "m", "mt", "mb", "my", "mx", "ml", "mr",
    "inset", "top", "bottom", "left", "right",
];

const BORDER_PREFIXES: &[&str] = &[
    "border", "border_t", "border_b", "border_r", "border_l", "border_x", "border_y",
];

const CORNER_PREFIXES: &[&str] = &[
    "rounded",
    "rounded_t",
    "rounded_b",
    "rounded_r",
    "rounded_l",
    "rounded_tl",
    "rounded_tr",
    "rounded_bl",
    "rounded_br",
];

const BOX_SUFFIXES: &[&str] = &[
    "0", "0p5", "1", "1p5", "2", "2p5", "3", "3p5", "4", "5", "6", "7", "8", "9", "10", "11", "12",
    "16", "20", "24", "32", "40", "48", "56", "64", "72", "80", "96", "112", "128", "px", "1_2",
    "1_3", "2_3", "1_4", "2_4", "3_4", "1_5", "2_5", "3_5", "4_5", "1_6", "5_6", "1_12",
];

const BORDER_SUFFIXES: &[&str] = &[
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "16", "20", "24", "32",
];

const CORNER_SUFFIXES: &[&str] = &["none", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "full"];

const TEXT_SUFFIXES: &[&str] = &["xs", "sm", "base", "lg", "xl", "2xl", "3xl"];

pub(super) fn raw_value_offsets(text: &str) -> Vec<usize> {
    let mut offsets = Vec::new();

    for name in RAW_CALLS.iter().chain(NAMED_COLORS) {
        offsets.extend(offsets_where(text, name, |index| {
            is_bare_call(text, index, name, &["("])
        }));
    }

    for name in CONSTRUCTORS {
        offsets.extend(offsets_where(text, name, |index| {
            is_bare_call(text, index, name, &[":", ":", "from", "("])
        }));
        offsets.extend(offsets_where(text, name, |index| {
            is_bare_call(text, index, name, &["("])
        }));
        offsets.extend(offsets_where(text, name, |index| {
            is_bare_struct_literal(text, index, name)
        }));
    }

    offsets.extend(offsets_where(text, "0x", |index| is_hex_color(text, index)));
    offsets.extend(offsets_where(text, ".", |dot| {
        is_preset_helper_call(text, dot)
    }));
    offsets.sort_unstable();

    offsets
}

fn offsets_where<'a>(
    text: &'a str,
    pattern: &'a str,
    accepts: impl Fn(usize) -> bool + 'a,
) -> impl Iterator<Item = usize> + 'a {
    text.match_indices(pattern)
        .map(|(index, _)| index)
        .filter(move |index| accepts(*index))
}

fn is_bare_struct_literal(text: &str, index: usize, name: &str) -> bool {
    let before = text[..index].chars().next_back();
    let is_member = before == Some('.') || before.is_some_and(is_identifier_char);

    if is_member || preceded_by_arrow(text, index) || preceded_by_let(text, index) {
        return false;
    }

    let rest = text[index + name.len()..].trim_start();

    rest.strip_prefix('{')
        .is_some_and(|fields| starts_with_struct_fields(fields.trim_start(), name))
}

fn preceded_by_arrow(text: &str, index: usize) -> bool {
    text[..index].trim_end().ends_with("->")
}

fn preceded_by_let(text: &str, index: usize) -> bool {
    let before = text[..index].trim_end();
    let Some(token) = tokenize(before, FrontmatterAllowed::No).last() else {
        return false;
    };

    &before[before.len() - token.len as usize..] == "let"
}

fn starts_with_struct_fields(fields: &str, name: &str) -> bool {
    if fields.starts_with("..") {
        return true;
    }

    let field_names: &[&str] = match name {
        "Rgba" => &["r", "g", "b", "a"],
        "Hsla" => &["h", "s", "l", "a"],
        "Pixels" => &["0"],
        _ => return false,
    };

    field_names.iter().any(|field| {
        [":", ",", "}"]
            .into_iter()
            .any(|separator| starts_with_tokens(fields, &[field, separator]))
    })
}

fn is_bare_call(text: &str, index: usize, name: &str, suffix: &[&str]) -> bool {
    let before = text[..index].chars().next_back();
    let called_as_method = text[..index].trim_end().ends_with('.');
    let inside_identifier = before.is_some_and(is_identifier_char);

    if called_as_method || inside_identifier {
        return false;
    }

    starts_with_tokens(&text[index + name.len()..], suffix)
}

fn starts_with_tokens(mut text: &str, expected: &[&str]) -> bool {
    for expected_token in expected {
        text = text.trim_start();
        let Some(token) = tokenize(text, FrontmatterAllowed::No).next() else {
            return false;
        };
        let (actual, remaining) = text.split_at(token.len as usize);

        if actual != *expected_token {
            return false;
        }

        text = remaining;
    }

    true
}

fn is_hex_color(text: &str, index: usize) -> bool {
    let digits: String = text[index + 2..]
        .chars()
        .take_while(|character| character.is_ascii_hexdigit())
        .collect();
    let after = text[index + 2 + digits.len()..].chars().next();
    let is_color_length = digits.len() == 6 || digits.len() == 8;

    is_color_length && !after.is_some_and(is_identifier_char)
}

fn is_preset_helper_call(text: &str, dot: usize) -> bool {
    let after_dot = &text[dot + 1..];
    let name_start = text.len() - after_dot.trim_start().len();
    let name_end = identifier_end(text, name_start);
    let name = &text[name_start..name_end];

    text[name_end..].trim_start().starts_with('(') && is_preset_helper(name)
}

fn identifier_end(text: &str, start: usize) -> usize {
    let mut end = start;

    for (offset, character) in text[start..].char_indices() {
        if character.is_ascii_alphanumeric() || character == '_' {
            end = start + offset + character.len_utf8();
        } else {
            break;
        }
    }

    end
}

fn is_preset_helper(name: &str) -> bool {
    [
        (BOX_PREFIXES, BOX_SUFFIXES),
        (BORDER_PREFIXES, BORDER_SUFFIXES),
        (CORNER_PREFIXES, CORNER_SUFFIXES),
        (&["text"][..], TEXT_SUFFIXES),
    ]
    .into_iter()
    .any(|(prefixes, suffixes)| has_prefix_and_suffix(name, prefixes, suffixes))
}

fn has_prefix_and_suffix(name: &str, prefixes: &[&str], suffixes: &[&str]) -> bool {
    prefixes.iter().any(|prefix| {
        let Some(rest) = name.strip_prefix(prefix) else {
            return false;
        };
        let Some(suffix) = rest.strip_prefix('_') else {
            return false;
        };

        suffixes.contains(&suffix)
    })
}

fn is_identifier_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_reports_constructor_literals() {
        let cases = [
            "let x = Pixels::from(3.0);",
            "let x = Pixels(3.0);",
            "let x = Rgba { r: 0.0, g: 0.0, b: 0.0, a: 1.0 };",
            "let x = Hsla { h: 0.0, s: 0.0, l: 0.0, a: 1.0 };",
            "let x = Rgba::from(0.0);",
            "let x = Hsla::from(0.0);",
        ];

        for case in cases {
            assert!(line_has_raw_value(case), "not reported: {case}");
        }
    }

    #[test]
    fn scan_reports_struct_expressions_after_keyword_lookalikes() {
        for source in [
            "paint!(outlet Rgba { r, g, b, a });",
            "paint!(r#let Rgba { r, g, b, a });",
            "paint!(violet Hsla { h, s, l, a });",
        ] {
            assert!(line_has_raw_value(source), "not reported: {source}");
        }
    }

    #[test]
    fn scan_allows_length_and_color_types() {
        let allowed = [
            "fn f(size: Pixels) -> Pixels { size }",
            "let color: Rgba = theme.colors.surface;",
            "fn color() -> Rgba { theme.colors.surface }",
            "let weight: FontWeight = theme.text.selected_weight;",
        ];

        for case in allowed {
            assert!(!line_has_raw_value(case), "wrongly reported: {case}");
        }
    }

    #[test]
    fn scan_reports_each_kind_of_raw_value() {
        let cases = [
            "let x = px(3.0);",
            "let x = rems(0.5);",
            "let x = rems_from_px(3.0);",
            "let x = rgb(0x112233);",
            "let x = rgba(0x11223344);",
            "let x = hsla(0.5, 0.5, 0.5, 1.0);",
            "let x = hsl(0.5, 0.5, 0.5);",
            "let x = 0x112233;",
            "let x = white();",
            "let x = black();",
            "let x = transparent_black();",
            "div().p_2();",
            "div().gap_1();",
            "div().text_sm();",
            "div().rounded_md();",
            "div().w_64();",
            "div().border_l_2();",
        ];

        for case in cases {
            assert!(line_has_raw_value(case), "not reported: {case}");
        }
    }

    #[test]
    fn scan_allows_theme_tokens_and_relative_layout() {
        let allowed = [
            "div().px(theme.spacing.small);",
            "div().bg(theme.colors.surface);",
            "div().size_full();",
            "div().w_full();",
            "div().text_color(theme.colors.foreground);",
            "div().text_size(theme.text.row);",
        ];

        for case in allowed {
            assert!(!line_has_raw_value(case), "wrongly reported: {case}");
        }
    }

    #[test]
    fn scan_allows_names_that_end_with_a_constructor_name() {
        assert!(!line_has_raw_value("let x = MyRgba { r: 0.0 };"));
    }

    #[test]
    fn scan_allows_a_return_type_before_a_body_that_starts_with_a_path() {
        assert!(!line_has_raw_value("fn color() -> Rgba { a::color() }"));
    }

    #[test]
    fn scan_allows_hex_numbers_that_are_not_color_length() {
        let allowed = ["let mask = 0xff;", "let id = 0x1122334455;"];

        for case in allowed {
            assert!(!line_has_raw_value(case), "wrongly reported: {case}");
        }
    }

    fn line_has_raw_value(text: &str) -> bool {
        !raw_value_offsets(text).is_empty()
    }
}
