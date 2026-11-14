use serde_json::{Value, json};
use tikk_core::{
    AnswerEffects, AskEffects, Identity, Question, QuestionItem, Store, StoreError, TicketId,
};

use crate::output::Output;

pub(crate) fn run_ask(
    store: &Store,
    id: &TicketId,
    text: &str,
    caller: &Identity,
    effects: &AskEffects,
) -> Result<Output, StoreError> {
    let question = tikk_core::ask_question(store, id, text, caller, effects)?;

    Ok(question_output(id, &question))
}

pub(crate) fn run_answer(
    store: &Store,
    id: &TicketId,
    item: &QuestionItem,
    text: &str,
    effects: &AnswerEffects,
) -> Result<Output, StoreError> {
    let question = tikk_core::answer_question(store, id, item, text, effects)?;

    Ok(question_output(id, &question))
}

pub(crate) fn question_json(question: &Question) -> Value {
    let answer = question
        .answer
        .as_ref()
        .map(|answer| json!({ "text": answer.text, "answeredAt": answer.answered_at.to_string() }));

    json!({
        "item": question.item.as_str(),
        "text": question.text,
        "askedAt": question.asked_at.to_string(),
        "answer": answer,
    })
}

pub(crate) fn question_text(question: &Question) -> String {
    match &question.answer {
        Some(answer) => format!(
            "question {}: {} answer: {}",
            question.item, question.text, answer.text
        ),
        None => format!("question {}: {} (open)", question.item, question.text),
    }
}

fn question_output(id: &TicketId, question: &Question) -> Output {
    let mut json = question_json(question);

    json["id"] = json!(id.to_string());

    Output {
        json,
        text: format!("{id}  {}", question_text(question)),
    }
}
