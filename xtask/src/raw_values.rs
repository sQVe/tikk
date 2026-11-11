mod source;
mod value;

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Context as _;
use thiserror::Error;

use source::scan_source;

const UI_SOURCE: &str = "crates/tikk-ui/src";
const THEME_FILE: &str = "theme.rs";

#[derive(Debug, Error, PartialEq, Eq)]
#[error("{}", failures.join("\n"))]
struct RawValues {
    failures: Vec<String>,
}

pub(crate) fn check(root: &Path) -> anyhow::Result<()> {
    let directory = root.join(UI_SOURCE);
    let failures = scan_directory(root, &directory)?;

    if failures.is_empty() {
        return Ok(());
    }

    Err(RawValues { failures }.into())
}

fn scan_directory(root: &Path, directory: &Path) -> anyhow::Result<Vec<String>> {
    let mut files = Vec::new();
    collect_files(directory, &mut files)?;
    files.sort();

    let theme_file = directory.join(THEME_FILE);
    let mut failures = Vec::new();

    for file in files {
        if file == theme_file {
            continue;
        }

        let source = fs::read_to_string(&file)
            .with_context(|| format!("Could not read {}", file.display()))?;
        let path = file
            .strip_prefix(root)
            .unwrap_or(&file)
            .display()
            .to_string();

        failures.extend(scan_source(&path, &source));
    }

    Ok(failures)
}

fn collect_files(directory: &Path, files: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    let entries = fs::read_dir(directory)
        .with_context(|| format!("Could not list {}", directory.display()))?;

    for entry in entries {
        let entry = entry.with_context(|| "Could not read an entry")?;
        let path = entry.path();

        if path.is_dir() {
            collect_files(&path, files)?;
        } else if path.extension().and_then(|extension| extension.to_str()) == Some("rs") {
            files.push(path);
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_rejects_raw_color_and_size_outside_the_theme() {
        let root = crate::test_support::temporary_directory();
        let source = root.path().join("crates/tikk-ui/src");
        fs::create_dir_all(&source).expect("create UI source");
        fs::write(
            source.join("scene.rs"),
            "let color = rgb(0x112233);\nlet size = px(3.0);\n",
        )
        .expect("write scene");

        let error = check(root.path()).expect_err("raw values must fail");

        assert_eq!(
            error
                .downcast_ref::<RawValues>()
                .expect("raw-value violations")
                .failures,
            [
                "crates/tikk-ui/src/scene.rs:1: let color = rgb(0x112233);",
                "crates/tikk-ui/src/scene.rs:2: let size = px(3.0);",
            ]
        );
    }

    #[test]
    fn check_allows_direct_let_struct_patterns() {
        let root = crate::test_support::temporary_directory();
        let directory = root.path().join(UI_SOURCE);
        fs::create_dir_all(&directory).expect("create UI source");
        let path = directory.join("scene.rs");

        for source in [
            "let Rgba { r, g, b, a } = theme.colors.surface;",
            "let Hsla { h, s, l, a } = theme.colors.surface;",
            "let Pixels { 0: width } = theme.sizing.row_height;",
            "if let Rgba { r, g, b, a } = color { use_channels(r, g, b, a); }",
            "while let Hsla { h, s, l, a } = color { use_channels(h, s, l, a); }",
            "if ready && let Rgba { r, .. } = color { use_channel(r); }",
            "fn read() {let Rgba { r, g, b, a } = theme.colors.surface;}",
            "let /* channels */ Hsla { h, s, l, a } = theme.colors.surface;",
            "let\nRgba { r, g, b, a } = theme.colors.surface;",
        ] {
            fs::write(&path, source).expect("write struct pattern");

            check(root.path()).expect(source);

            assert_eq!(
                fs::read_to_string(&path).expect("read unchanged source"),
                source
            );
        }
    }

    #[test]
    fn check_rejects_struct_expressions_after_patterns() {
        let root = crate::test_support::temporary_directory();
        let directory = root.path().join(UI_SOURCE);
        fs::create_dir_all(&directory).expect("create UI source");
        let path = directory.join("scene.rs");

        for (source, line) in [
            ("let color = Rgba { r, g, b, a };", 1),
            ("div().bg(Hsla { h, s, l, a });", 1),
            ("let Rgba { r, g, b, a } = Rgba { r, g, b, a };", 1),
            ("let Hsla { h, s, l, a } = Hsla { h, s, l, a };", 1),
            ("let Pixels { 0: width } = Pixels { 0: width };", 1),
            (
                "let Rgba { r, g, b, a } = theme.colors.surface; div().bg(Rgba { r, g, b, a });",
                1,
            ),
            (
                "if let Rgba { r, g, b, a } = color { div().bg(Rgba { r, g, b, a }); }",
                1,
            ),
            ("let Rgba { r, g, b, a } =\n    Rgba { r, g, b, a };", 2),
        ] {
            fs::write(&path, source).expect("write struct expression");

            let error = check(root.path()).expect_err(source);
            let expression = source
                .lines()
                .nth(line - 1)
                .expect("the case names its expression line")
                .trim();
            let expected = format!("crates/tikk-ui/src/scene.rs:{line}: {expression}");

            assert_eq!(
                error
                    .downcast_ref::<RawValues>()
                    .expect("raw-value violations")
                    .failures,
                [expected]
            );
            assert_eq!(
                fs::read_to_string(&path).expect("read unchanged source"),
                source
            );
        }
    }

    #[test]
    fn check_rejects_shorthand_colors_and_named_size_fields() {
        let root = crate::test_support::temporary_directory();
        let directory = root.path().join(UI_SOURCE);
        fs::create_dir_all(&directory).expect("create UI source");
        let path = directory.join("scene.rs");

        for source in [
            "let (r,g,b,a) = (1.0,0.0,0.0,1.0); div().bg(Rgba { r, g, b, a });",
            "let (h,s,l,a) = (1.0,0.0,0.0,1.0); div().bg(Hsla { h, s, l, a });",
            "let width = 24.0; div().w(Pixels { 0: width });",
            "div().bg(Rgba { a /* opacity */, r, g, b });",
            "div().bg(Hsla { s\n, h, l, a });",
        ] {
            fs::write(&path, source).expect("write struct literal");

            let error = check(root.path()).expect_err(source);
            let violations = error
                .downcast_ref::<RawValues>()
                .expect("raw-value violations");

            assert_eq!(violations.failures.len(), 1, "{source}");
            assert!(
                violations.failures[0].starts_with("crates/tikk-ui/src/scene.rs:1:"),
                "{source}"
            );
            assert_eq!(
                fs::read_to_string(&path).expect("read unchanged source"),
                source
            );
        }
    }

    #[test]
    fn check_keeps_rejecting_theme_struct_updates() {
        let root = crate::test_support::temporary_directory();
        let directory = root.path().join(UI_SOURCE);
        fs::create_dir_all(&directory).expect("create UI source");
        let path = directory.join("scene.rs");

        for source in [
            "Rgba { ..theme.colors.surface }",
            "Hsla { ..theme.colors.surface }",
            "Pixels { ..theme.sizing.none }",
        ] {
            fs::write(&path, source).expect("write struct update");

            let error = check(root.path()).expect_err(source);

            assert_eq!(
                error
                    .downcast_ref::<RawValues>()
                    .expect("raw-value violations")
                    .failures,
                [format!("crates/tikk-ui/src/scene.rs:1: {source}")],
                "{source}"
            );
            assert_eq!(
                fs::read_to_string(&path).expect("read unchanged source"),
                source
            );
        }
    }

    #[test]
    fn check_displays_each_violation_with_its_file_line_and_source() {
        let root = crate::test_support::temporary_directory();
        let directory = root.path().join(UI_SOURCE);
        fs::create_dir_all(&directory).expect("create UI source");
        let path = directory.join("scene.rs");
        let source = "fn scene() {\n    let color = rgb(0x112233);\n    let size = px(3.0);\n}\n";
        fs::write(&path, source).expect("write raw values");

        let error = check(root.path()).expect_err("raw values must fail");

        assert_eq!(
            format!("{error:#}"),
            "crates/tikk-ui/src/scene.rs:2: let color = rgb(0x112233);\ncrates/tikk-ui/src/scene.rs:3: let size = px(3.0);"
        );
        assert_eq!(
            fs::read_to_string(path).expect("read unchanged source"),
            source
        );
    }

    #[test]
    fn check_rejects_raw_token_sequences_with_whitespace() {
        let root = crate::test_support::temporary_directory();
        let directory = root.path().join(UI_SOURCE);
        fs::create_dir_all(&directory).expect("create UI source");
        let path = directory.join("scene.rs");

        for source in [
            "div().w(Pixels :: from (24.0));",
            "div().w(Pixels\n::\nfrom\n(24.0));",
            "div().bg(Rgba { r : 1.0, g : 0.0, b : 0.0, a : 1.0 });",
            "div().bg(Hsla { h\n: 1.0, s : 0.0, l : 0.0, a : 1.0 });",
            "div().bg(Rgba /* color */ :: from (value));",
            "div().bg(Hsla\n:: from (value));",
            "div().w(px (24.0));",
            "div().bg(rgb\n(1));",
            "div().bg(hsla (0.0, 0.0, 0.0, 1.0));",
            "div().\np_2 ();",
            "div(). rounded_md ();",
            "div().\ntext_sm ();",
        ] {
            fs::write(&path, source).expect("write raw values");

            let error = check(root.path()).expect_err(source);

            assert!(
                error
                    .downcast_ref::<RawValues>()
                    .expect("raw-value violations")
                    .failures[0]
                    .starts_with("crates/tikk-ui/src/scene.rs:1:"),
                "{source}: {error}"
            );
            assert_eq!(
                fs::read_to_string(&path).expect("read unchanged source"),
                source
            );
        }
    }

    #[test]
    fn check_passes_with_only_theme_tokens_and_preserves_the_source() {
        let root = crate::test_support::temporary_directory();
        let directory = root.path().join(UI_SOURCE);
        fs::create_dir_all(&directory).expect("create UI source");
        let path = directory.join("scene.rs");
        let source = "div().w(theme.sizing.row_height);";
        fs::write(&path, source).expect("write theme tokens");

        check(root.path()).expect("theme tokens pass");

        assert_eq!(fs::read_to_string(path).expect("read source"), source);
    }

    #[test]
    fn check_reports_a_missing_source_directory() {
        let root = crate::test_support::temporary_directory();

        let error = check(root.path()).expect_err("missing source cannot be scanned");

        assert_eq!(
            error
                .downcast_ref::<std::io::Error>()
                .expect("IO error")
                .kind(),
            std::io::ErrorKind::NotFound
        );
        assert_eq!(fs::read_dir(root.path()).expect("read fixture").count(), 0);
    }

    #[test]
    fn scan_directory_reads_rust_files_in_path_order_and_ignores_other_files() {
        let root = crate::test_support::temporary_directory();
        for name in ["z.rs", "a.rs", "notes.txt"] {
            fs::write(root.path().join(name), "px(1);").expect("write source");
        }

        let failures = scan_directory(root.path(), root.path()).expect("scan source");

        assert_eq!(failures, ["a.rs:1: px(1);", "z.rs:1: px(1);"]);
    }

    #[test]
    fn scan_directory_exempts_theme_file() {
        let directory = crate::test_support::temporary_directory();
        fs::write(directory.path().join("theme.rs"), "let x = px(3.0);\n").expect("write theme");
        fs::write(directory.path().join("scene.rs"), "let y = 1.0;\n").expect("write scene");

        let failures = scan_directory(directory.path(), directory.path()).expect("scan");

        assert!(failures.is_empty());
    }

    #[test]
    fn scan_directory_scans_a_nested_theme_file() {
        let directory = crate::test_support::temporary_directory();
        fs::create_dir_all(directory.path().join("scenes")).expect("create scenes");
        fs::write(
            directory.path().join("scenes/theme.rs"),
            "let x = px(3.0);\n",
        )
        .expect("write nested theme");

        let failures = scan_directory(directory.path(), directory.path()).expect("scan");

        assert_eq!(failures.len(), 1);
        assert!(failures[0].ends_with("theme.rs:1: let x = px(3.0);"));
    }

    #[test]
    fn scan_directory_finds_literals_in_other_files() {
        let directory = crate::test_support::temporary_directory();
        fs::write(directory.path().join("theme.rs"), "let x = px(3.0);\n").expect("write theme");
        fs::write(
            directory.path().join("scene.rs"),
            "fn f() {\n    let y = rgb(0x112233);\n}\n",
        )
        .expect("write scene");

        let failures = scan_directory(directory.path(), directory.path()).expect("scan");

        assert_eq!(failures.len(), 1);
        assert!(failures[0].ends_with("scene.rs:2: let y = rgb(0x112233);"));
    }

    #[test]
    fn check_fails_with_each_raw_value_in_the_ui_source() {
        let root = crate::test_support::temporary_directory();
        let source = root.path().join(UI_SOURCE);
        fs::create_dir_all(&source).expect("create the UI source");
        fs::write(source.join("scene.rs"), "let x = px(3.0);\n").expect("write scene");

        let error = check(root.path()).expect_err("a raw value fails the check");

        assert_eq!(
            error
                .downcast_ref::<RawValues>()
                .expect("raw-value violations")
                .failures,
            ["crates/tikk-ui/src/scene.rs:1: let x = px(3.0);"]
        );
    }
}
