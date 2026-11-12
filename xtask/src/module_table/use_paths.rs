use ra_ap_rustc_lexer::{FrontmatterAllowed, TokenKind, strip_shebang, tokenize};

struct Token<'a> {
    kind: TokenKind,
    text: &'a str,
    line: usize,
}

pub(super) struct CratePath<'a> {
    pub(super) name: &'a str,
    pub(super) line: usize,
}

fn code_tokens(source: &str) -> Vec<Token<'_>> {
    let shebang_end = strip_shebang(source).unwrap_or(0);
    let mut line = 1;
    let mut start = shebang_end;
    let mut tokens = Vec::new();

    for token in tokenize(&source[shebang_end..], FrontmatterAllowed::Yes) {
        let end = start + token.len as usize;
        let text = &source[start..end];
        let is_trivia = matches!(
            token.kind,
            TokenKind::Whitespace
                | TokenKind::LineComment { .. }
                | TokenKind::BlockComment { .. }
                | TokenKind::Frontmatter { .. }
        );

        if !is_trivia {
            tokens.push(Token {
                kind: token.kind,
                text,
                line,
            });
        }

        line += text.matches('\n').count();
        start = end;
    }

    tokens
}

pub(super) fn crate_paths(source: &str) -> Vec<CratePath<'_>> {
    let tokens = code_tokens(source);
    let mut paths = Vec::new();

    for (index, token) in tokens.iter().enumerate() {
        let starts_path = token.kind == TokenKind::Ident && token.text == "crate";
        let has_separator = tokens
            .get(index + 1..index + 3)
            .is_some_and(|separator| separator.iter().all(|colon| colon.kind == TokenKind::Colon));

        if !starts_path || !has_separator {
            continue;
        }

        let Some(next) = tokens.get(index + 3) else {
            continue;
        };

        if next.kind == TokenKind::OpenBrace {
            paths.extend(group_items(&tokens[index + 4..]));
        } else if let Some(name) = identifier_name(next) {
            paths.push(CratePath {
                name,
                line: next.line,
            });
        }
    }

    paths
}

fn group_items<'a>(tokens: &[Token<'a>]) -> Vec<CratePath<'a>> {
    let mut items = Vec::new();
    let mut depth = 1;
    let mut expects_item = true;

    for token in tokens {
        match token.kind {
            TokenKind::OpenBrace => depth += 1,
            TokenKind::CloseBrace => depth -= 1,
            _ => {}
        }

        if depth == 0 {
            break;
        }

        if depth > 1 {
            continue;
        }

        if expects_item && let Some(name) = identifier_name(token) {
            items.push(CratePath {
                name,
                line: token.line,
            });
        }

        expects_item = token.kind == TokenKind::Comma;
    }

    items
}

fn identifier_name<'a>(token: &Token<'a>) -> Option<&'a str> {
    match token.kind {
        TokenKind::Ident => Some(token.text),
        TokenKind::RawIdent => token.text.strip_prefix("r#"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(source: &str) -> Vec<&str> {
        crate_paths(source).iter().map(|path| path.name).collect()
    }

    #[test]
    fn nested_group_yields_only_first_level_items() {
        assert_eq!(
            names("use crate::{ticket::{Ticket, store}, github};"),
            ["ticket", "github"]
        );
    }

    #[test]
    fn identifier_after_a_group_closes_is_not_yielded() {
        assert_eq!(names("use crate::{ticket}; fn store() {}"), ["ticket"]);
    }

    #[test]
    fn later_path_segment_in_a_group_is_not_yielded() {
        assert_eq!(names("use crate::{ticket::store};"), ["ticket"]);
    }

    #[test]
    fn raw_identifier_yields_its_name_without_the_prefix() {
        assert_eq!(
            names("use crate::r#store::read;\nuse crate::{r#sync, ticket};\n"),
            ["store", "sync", "ticket"]
        );
    }

    #[test]
    fn glob_use_is_not_read_as_a_group() {
        assert_eq!(
            names("use crate::*;\ntype Pair = (u8, store::Id);\n"),
            Vec::<&str>::new()
        );
    }

    #[test]
    fn line_after_a_shebang_counts_the_shebang_line() {
        let lines: Vec<usize> = crate_paths("#!/usr/bin/env tikk\n\nuse crate::store::read;\n")
            .iter()
            .map(|path| path.line)
            .collect();

        assert_eq!(lines, [3]);
    }
}
