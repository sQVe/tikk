use gpui_kit::Div;

use crate::parts::{Item, panel};
use crate::theme::Theme;

pub(super) fn render(theme: &Theme) -> Div {
    let items = [
        Item {
            label: "Sample item one".to_string(),
            detail: "Selected".to_string(),
            selected: true,
        },
        Item {
            label: "Sample item two".to_string(),
            detail: "Ready".to_string(),
            selected: false,
        },
        Item {
            label: "Sample item three".to_string(),
            detail: "Ready".to_string(),
            selected: false,
        },
    ];

    panel("Sample collection".to_string(), &items, theme)
}
