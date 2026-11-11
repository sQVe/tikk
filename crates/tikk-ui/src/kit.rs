use gpui_kit::component::label::Label;
use gpui_kit::{IntoElement, Styled};

use crate::theme::Theme;

pub(crate) fn label(text: String, theme: &Theme) -> impl IntoElement {
    Label::new(text)
        .text_size(theme.text.row)
        .text_color(theme.colors.foreground)
}
