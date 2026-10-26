# ADR 0026: Classifier advice comes from clients and never blocks

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0010 (The CLI contract for agents)](./0010-cli-contract.md),
[ADR 0015 (Observed facts in per-machine JSONL)](./0015-facts-in-per-machine-jsonl.md),
[ADR 0021 (Strict validation at claim, submit, and close)](./0021-validation-levels.md)

## Context

Some ticket questions need judgment that a rule cannot give: what a new loose task is about, whether
it repeats an open ticket, and whether an acceptance criterion names a real check. A small
classifier model, such as Jev, can sort text into given categories. Agent harnesses already hold a
model choice and credentials. Tau, the first client, calls Jev from its scripts this way.

tikk must run without Pi and offline ([ADR 0010](./0010-cli-contract.md)). The design targets
`ready` and `claim` in under 200 ms on a store of 2,000 tickets, apart from the Git fetch and PR
reconcile they may run. A model call can take seconds and can fail.

## Decision

Clients call the classifier; the `tikk` binary makes no model call. A client is any agent, harness,
or script that uses the CLI ([ADR 0010](./0010-cli-contract.md)). It reads its input through
`tikk ... --json` and writes the result back as a `suggestion` fact with a tikk command. Tau is the
first client, not the only one. A suggestion is advice: it never changes ticket intent and never
blocks a command.

### Uses

- Triage new loose tasks. Classify a task's purpose, such as bug, idea, chore, or question. tikk
  returns a short list of open tickets that match the task's text, and the classifier labels each
  pair as duplicate, related, or distinct. `tikk needs` shows the result with the new task. Nothing
  is done or merged on its own. The project still comes from `origin`, and `kind` stays `task`.
- Check criteria quality. Before a slice starts, classify each criterion as checkable or vague: does
  it name a command, test, or observable step, and an observable result? A vague criterion is a
  warning ([ADR 0021](./0021-validation-levels.md)). Missing fields stay a strict error that needs
  no model.
- No model call for anything a rule decides: project routing, ready order, claims, done, coverage
  queries, and evidence freshness.

### Suggestion facts

- A `suggestion` fact names its target ticket or criterion, the question, the label, the confidence,
  the model ID, and a hash of the input text ([ADR 0015](./0015-facts-in-per-machine-jsonl.md)). A
  changed input hash marks it stale.
- A person or agent accepts a suggestion by editing the ticket or running a command. A newer fact
  corrects or dismisses it.
- Only ticket text goes to the model. When the model is offline or fails, the client skips the
  advice and records nothing.

The slice that builds a use sets its labels, prompts, thresholds, and fact schema.

## Consequences

### Positive

- tikk stays fast, offline, and free of model keys.
- A wrong label costs a glance, not lost work, since nothing acts on it alone.
- The model ID and input hash show which advice is stale after the text or the model changes.

### Negative

- A client without a model gets no advice. tikk works the same without it.
- Suggestions add facts to the store that are only advice.

## Alternatives considered

### Model calls inside tikk

Let `tikk new` or `tikk ready` call the classifier. Rejected because tikk would need its own model
key and network, and a call of seconds would add far more than the 200 ms target.

### Advice only from Tau

Let only Tau skills write suggestions. Rejected because tikk serves any agent or script, and a
suggestion fact needs nothing that only Tau has.

### Suggestions kept only in the session

Show the advice once and store nothing. Rejected because `tikk needs` could not show a possible
duplicate later, and nobody could tell which advice a later edit answered.

### Suggestions written into front matter

Store the label as a ticket field. Rejected because front matter holds the user's intent
([ADR 0013](./0013-intent-in-markdown-files.md)), and a model must not write it.

### Classifier results as gates

Block a slice start on a vague criterion. Rejected because a false alarm would stop agents, and the
classifier never proves a criterion passed.
