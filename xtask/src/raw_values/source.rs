use ra_ap_rustc_lexer::{FrontmatterAllowed, LiteralKind, TokenKind, strip_shebang, tokenize};

use super::value::raw_value_offsets;

pub(super) fn scan_source(path: &str, source: &str) -> Vec<String> {
    let masked = mask_source(source);
    let mut failures = Vec::new();
    let mut reported_line = None;

    for offset in raw_value_offsets(&masked) {
        let line = line_number(&masked, offset);

        if reported_line == Some(line) {
            continue;
        }

        let text = source.lines().nth(line - 1).unwrap_or("");

        failures.push(format!("{path}:{line}: {}", text.trim()));
        reported_line = Some(line);
    }

    failures
}

fn line_number(masked: &str, offset: usize) -> usize {
    masked[..offset]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count()
        + 1
}

fn mask_source(source: &str) -> String {
    let mut masked = String::with_capacity(source.len());
    let shebang_end = strip_shebang(source).unwrap_or(0);
    let mut start = shebang_end;

    push_blanks(&mut masked, &source[..shebang_end]);

    for token in tokenize(&source[shebang_end..], FrontmatterAllowed::Yes) {
        let end = start + token.len as usize;
        let text = &source[start..end];
        let hides_text = matches!(
            token.kind,
            TokenKind::LineComment { .. }
                | TokenKind::BlockComment { .. }
                | TokenKind::Frontmatter { .. }
                | TokenKind::Literal {
                    kind: LiteralKind::Char { .. }
                        | LiteralKind::Byte { .. }
                        | LiteralKind::Str { .. }
                        | LiteralKind::ByteStr { .. }
                        | LiteralKind::CStr { .. }
                        | LiteralKind::RawStr { .. }
                        | LiteralKind::RawByteStr { .. }
                        | LiteralKind::RawCStr { .. },
                    ..
                }
        );

        if hides_text {
            push_blanks(&mut masked, text);
        } else {
            masked.push_str(text);
        }

        start = end;
    }

    masked
}

fn push_blanks(masked: &mut String, text: &str) {
    let blanks = text
        .bytes()
        .map(|byte| if byte == b'\n' { '\n' } else { ' ' });

    masked.extend(blanks);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_preserves_token_boundaries_with_whitespace() {
        for source in [
            "let value = Pixels :: fromage(24.0);",
            "let value = Rgba { red : value };",
            "let value = Hsla { hue : value };",
            "div(). px (theme.spacing.small);",
            "div().\npx\n(theme.spacing.small);",
        ] {
            assert!(scan_source("src/scene.rs", source).is_empty(), "{source}");
        }
    }

    #[test]
    fn scan_reports_a_literal_with_its_path_and_line() {
        let source = "fn scene() {\n    let width = px(3.0);\n}\n";

        assert_eq!(
            scan_source("src/scenes/a.rs", source),
            ["src/scenes/a.rs:2: let width = px(3.0);"]
        );
    }

    #[test]
    fn scan_ignores_comment_lines() {
        let source = "// let width = px(3.0);\n";

        assert_eq!(scan_source("src/a.rs", source), Vec::<String>::new());
    }

    #[test]
    fn scan_ignores_raw_text_in_strings_and_comments() {
        let source = "\
    let label = String::from(\"rgb(0x112233)\");\n\
    let detail = r\"px(3.0) Pixels(3.0)\";\n\
    let row = theme.text.row; // instead of px(3.0)\n\
    /* px(3.0)\n   rgb(0x112233) */\n\
    let other = \"white()\";\n";

        assert_eq!(scan_source("src/a.rs", source), Vec::<String>::new());
    }

    #[test]
    fn scan_reports_a_multiline_struct_literal_at_its_start_line() {
        let source = "\
    let color = Rgba {\n\
        r: 0.1,\n\
        g: 0.2,\n\
        b: 0.3,\n\
        a: 1.0,\n\
    };\n\
    let other = Hsla {\n\
        h: 0.1,\n\
        s: 0.2,\n\
        l: 0.3,\n\
        a: 1.0,\n\
    };\n";

        assert_eq!(
            scan_source("src/a.rs", source),
            [
                "src/a.rs:1: let color = Rgba {",
                "src/a.rs:7: let other = Hsla {",
            ]
        );
    }

    #[test]
    fn scan_reports_spaced_and_multiline_calls_at_their_start_line() {
        let source = "\
    let a = hsla (0.1, 0.2, 0.3, 1.0);\n\
    let b = px\n\
        (3.0);\n\
    let c = rgb\n\
        (1, 2, 3);\n";

        assert_eq!(
            scan_source("src/a.rs", source),
            [
                "src/a.rs:1: let a = hsla (0.1, 0.2, 0.3, 1.0);",
                "src/a.rs:2: let b = px",
                "src/a.rs:4: let c = rgb",
            ]
        );
    }

    #[test]
    fn scan_ignores_a_return_type_and_reports_the_body_literal() {
        let source = "fn color() -> Rgba {\n    Rgba { r: 0.1, g: 0.2, b: 0.3, a: 1.0 }\n}\n";

        assert_eq!(
            scan_source("src/a.rs", source),
            ["src/a.rs:2: Rgba { r: 0.1, g: 0.2, b: 0.3, a: 1.0 }"]
        );
    }

    #[test]
    fn scan_ignores_raw_values_in_nested_block_comments() {
        let source = "/* px(1); /* rgb(2); */ px(3); */\npx(4);\n";

        assert_eq!(scan_source("src/a.rs", source), ["src/a.rs:2: px(4);"]);
    }

    #[test]
    fn scan_ignores_raw_values_after_an_escaped_quote_in_a_string() {
        let source = "let s = \"a\\\" px(1)\";\nrgb(2);\n";

        assert_eq!(scan_source("src/a.rs", source), ["src/a.rs:2: rgb(2);"]);
    }

    #[test]
    fn scan_ignores_raw_values_in_hashed_raw_strings() {
        let source = r####"let s = r#"a" px(1)"#; let b = br##"a"# px(1)"##;
    rgb(2);
    "####;

        assert_eq!(scan_source("src/a.rs", source), ["src/a.rs:2: rgb(2);"]);
    }

    #[test]
    fn scan_reports_raw_values_after_char_literals_and_lifetimes() {
        let source = r#"let a = ['"', '\'', '\\', '\n'];
    fn f<'a>(x: &'a str) {}
    px(1);
    "#;

        assert_eq!(scan_source("src/a.rs", source), ["src/a.rs:3: px(1);"]);
    }

    #[test]
    fn scan_reports_raw_values_after_adjacent_char_literals() {
        let source = r#"let a = ['\'','"'];
    px(1);
    "#;

        assert_eq!(scan_source("src/a.rs", source), ["src/a.rs:2: px(1);"]);
    }

    #[test]
    fn scan_ignores_a_final_line_comment_without_a_newline() {
        assert_eq!(scan_source("src/a.rs", "// px(1);"), Vec::<String>::new());
    }

    #[test]
    fn scan_reports_raw_values_inside_macro_bodies() {
        let source = "format!(\"{}\", px(1));\ndiv![rgb(2)];\n";

        assert_eq!(
            scan_source("src/a.rs", source),
            [
                "src/a.rs:1: format!(\"{}\", px(1));",
                "src/a.rs:2: div![rgb(2)];"
            ]
        );
    }

    #[test]
    fn scan_keeps_line_numbers_after_a_multiline_raw_string() {
        let source = "let s = r#\"é\npx(1)\n\"#;\nrgb(2);\n";

        assert_eq!(scan_source("src/a.rs", source), ["src/a.rs:4: rgb(2);"]);
    }

    #[test]
    fn scan_reports_raw_values_after_a_raw_string_with_an_extra_closing_hash() {
        let source = "m!(r#\"text\"##);\npx(1);\n";

        assert_eq!(scan_source("src/a.rs", source), ["src/a.rs:2: px(1);"]);
    }

    #[test]
    fn scan_allows_an_impl_block_for_a_color_type() {
        let source =
            "impl Default for Rgba {\n    fn default() -> Self {\n        todo()\n    }\n}\n";

        assert_eq!(scan_source("src/a.rs", source), Vec::<String>::new());
    }

    #[test]
    fn scan_reports_raw_values_of_different_kinds_in_source_order() {
        let source = "\
    let a = 0x112233;\n\
    div().p_2();\n\
    let b = Rgba { r: 0.1, g: 0.2, b: 0.3, a: 1.0 };\n\
    let c = px(1.0);\n\
    let d = Pixels::from(2.0);\n\
    let e = white();\n";

        assert_eq!(
            scan_source("src/a.rs", source),
            [
                "src/a.rs:1: let a = 0x112233;",
                "src/a.rs:2: div().p_2();",
                "src/a.rs:3: let b = Rgba { r: 0.1, g: 0.2, b: 0.3, a: 1.0 };",
                "src/a.rs:4: let c = px(1.0);",
                "src/a.rs:5: let d = Pixels::from(2.0);",
                "src/a.rs:6: let e = white();",
            ]
        );
    }

    #[test]
    fn scan_reports_a_line_with_several_raw_values_once() {
        let source = "let a = px(1.0); let b = rgb(0x112233); div().p_2();\nlet c = Pixels(3.0);\n";

        assert_eq!(
            scan_source("src/a.rs", source),
            [
                "src/a.rs:1: let a = px(1.0); let b = rgb(0x112233); div().p_2();",
                "src/a.rs:2: let c = Pixels(3.0);",
            ]
        );
    }

    #[test]
    fn scan_allows_names_that_only_contain_a_raw_constructor() {
        let source = "\
    let a = MyRgba { r: 0.0, g: 0.0, b: 0.0, a: 1.0 };\n\
    let b = palette.Rgba { r: 0.0, g: 0.0, b: 0.0, a: 1.0 };\n\
    let c = my_px(3.0);\n\
    let d = layout.px(3.0);\n\
    let e = 0x11223344u32;\n";

        assert_eq!(scan_source("src/a.rs", source), Vec::<String>::new());
    }

    #[test]
    fn scan_ignores_a_shebang_and_keeps_later_lines() {
        let source = "#!/usr/bin/env run-cargo-script px(1) \"\nlet width = px(3.0);\n";

        assert_eq!(
            scan_source("src/a.rs", source),
            ["src/a.rs:2: let width = px(3.0);"]
        );
    }

    #[test]
    fn scan_ignores_frontmatter_and_keeps_later_lines() {
        let source = "---\nlabel = \"px(1)\n---\nlet width = px(3.0);\n";

        assert_eq!(
            scan_source("src/a.rs", source),
            ["src/a.rs:4: let width = px(3.0);"]
        );
    }
}
