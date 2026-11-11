use gpui_kit::component::label::Label;
use gpui_kit::{IntoElement, Styled};

use crate::theme::Theme;

pub(crate) fn label(text: &str, theme: &Theme) -> impl IntoElement {
    Label::new(text.to_string())
        .text_size(theme.text.row)
        .text_color(theme.colors.foreground)
}
