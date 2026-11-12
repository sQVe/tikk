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
    let mut line = 1 + source[..shebang_end].matches('\n').count();
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

// Reads the first segment after each `crate::`, and each first-level item of a
// `crate::{...}` group. String literals are single tokens, so their text never matches.
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

        match tokens.get(index + 3) {
            Some(next) if next.kind == TokenKind::Ident => paths.push(CratePath {
                name: next.text,
                line: next.line,
            }),
            Some(next) if next.kind == TokenKind::OpenBrace => {
                paths.extend(group_items(&tokens[index + 4..]));
            }
            _ => {}
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

        if expects_item && token.kind == TokenKind::Ident {
            items.push(CratePath {
                name: token.text,
                line: token.line,
            });
        }

        expects_item = token.kind == TokenKind::Comma;
    }

    items
}
