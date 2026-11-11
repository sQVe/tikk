use gpui_kit::base::{h_flex, v_flex};
use gpui_kit::{Div, ParentElement, Styled, div};

use crate::{kit, theme::Theme};

pub struct Item {
    pub label: String,
    pub detail: String,
    pub selected: bool,
}

impl Item {
    fn render(&self, theme: &Theme) -> Div {
        let mut row = h_flex()
            .h(theme.sizing.row_height)
            .w_full()
            .gap(theme.spacing.small)
            .px(theme.spacing.small)
            .rounded(theme.radius.small);

        if self.selected {
            row = row
                .bg(theme.colors.selected)
                .font_weight(theme.text.selected_weight);
        }

        row.child(div().flex_1().child(kit::label(&self.label, theme)))
            .child(
                div()
                    .text_size(theme.text.counts)
                    .text_color(theme.colors.muted)
                    .child(self.detail.clone()),
            )
    }
}

pub fn panel(title: &str, items: &[Item], theme: &Theme) -> Div {
    let mut list = v_flex()
        .flex_1()
        .min_h(theme.sizing.none)
        .p(theme.spacing.small)
        .gap(theme.spacing.tiny);

    for item in items {
        list = list.child(item.render(theme));
    }

    v_flex()
        .size_full()
        .bg(theme.colors.surface)
        .border(theme.border.width)
        .border_color(theme.colors.border)
        .rounded(theme.radius.medium)
        .overflow_hidden()
        .child(
            div()
                .px(theme.spacing.medium)
                .py(theme.spacing.small)
                .text_size(theme.text.section)
                .text_color(theme.colors.foreground)
                .child(title.to_string()),
        )
        .child(list)
}
