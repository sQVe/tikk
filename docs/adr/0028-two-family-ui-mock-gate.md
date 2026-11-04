# ADR 0028: Two AI judges from different model families gate UI mocks

**Date**: 2026-11-04\
**Status**: Accepted

## Context

tikk's UI is designed in mocks before it is built. Each mock needs a fixed way to decide whether it
is good enough. Without one, the result depends on taste in the moment, and two reviews of the same
mock can disagree.

A scene built from real kit parts shows the visual and clarity parts of a design. It cannot show
keyboard use, a narrow window, or an error. Those parts need the real app in the last slice of each
part.

Some faults are easier to check than to judge. Contrast, sizes, and color values are examples. Model
judges read these values poorly, so the xtask checks test them before any judge runs.

Model judges also agree with people less on small differences, so one judge's view of a minor issue
is not reliable on its own. One lenient judge could pass a weak mock.

## Decision

A UI mock is a scene built from real kit parts with fake data, and two AI judges from different
model families gate it. A mock passes only when `cargo xtask check` passes, and neither judge
reports a finding of severity 2 or higher or an open hard failure.

The judges are `openai/gpt-6.1-sol` and `claude-bridge/claude-opus-5-5`. They come from different
model families, so they share fewer blind spots. Each judge works alone and does not see the other
judge's answer. A project skill runs each round and holds the procedure, so the procedure can change
without code.

### Mocks

- A scene uses the kit's real parts, the tikk kit and theme values, and fake data. Scenes live in
  one committed mocks module, separate from the app code.
- Each scene is captured natively, as a full shot and a crop, with `cargo xtask mock capture
  <scene>`.
- The judges see the shot, the crop, and the `cargo xtask check` result.

### Findings

- Each judge gives findings only, with no scores.
- Each finding has a severity from 0 to 4 on Nielsen's scale, and it names one category.
- A finding of severity 2 or higher fails the mock. Severity 0 and 1 findings do not.
- Missing evidence does not fail the mock. When a judge cannot decide, it answers `needs evidence`.
  The session supplies what it lacked and the judge decides again, so a gap in the packet leads to a
  better packet, not a failed mock. Missing evidence listed beside a pass or fail, such as states a
  still image cannot show, starts no new round.

### Categories

- A scene is judged on visual hierarchy, typography, spacing and density, visual consistency,
  polish, information architecture, discoverability and affordances, feedback and state visibility,
  and task fit.
- The real app is judged on the same categories, and also on efficiency, control and error recovery,
  accessibility and input, and adaptability. These four usability categories are judged only on the
  real app, in each part's last slice, because a scene cannot show them.

### Hard failures

A hard failure fails the mock on its own, whatever the findings. There are five kinds:

- `contrast`: text or control contrast below WCAG 2.2 AA. It comes from the xtask checks. The check
  lists the theme's current failing pairs as known failures, which pass until a theme change fixes
  them. A new failing pair, or a listed pair that starts to pass, fails the check.
- `offKitValue`: a size, radius, text size, or color that is not from the kit or a tikk theme token.
  It comes from the xtask checks.
- `hiddenTaskInformation`: information the task needs is hidden or absent. The judges flag it.
- `unclearFocusOrMode`: the user cannot tell which pane has focus or which mode is active. The
  judges flag it.
- `unreadableText`: required text cannot be read at the native display scale. The judges flag it.

### Smoke test

Four smoke scenes (`smoke-1` to `smoke-4`) check the procedure. The skill lists the verdict each one
must give. Changing a judge model or the judge instructions requires a smoke test run.

## Consequences

### Positive

- Two model families share fewer blind spots than two runs of one model.
- One lenient judge cannot pass a mock.
- Each finding names a location and a fix, so a judge says what to change.
- The xtask checks stop clear faults before any model runs.

### Negative

- Each mock costs two frontier-model runs per round.
- A model update can change findings, so the smoke test must run again.
- A scene cannot show the four usability categories. They wait for the real app in the part's last
  slice.
- The mocks module must follow kit changes, or its scenes show old parts.
- The pass rule is strict. One severity 2 finding from either judge fails the mock.

## Alternatives considered

### One judge

Use a single model judge. Rejected because one model family shares its blind spots, and one judge's
leniency or harshness would decide the result.

### Category scores with a pass line

Each judge scores each category from 0 to 10, and each category passes at 9.0. Rejected because a
score near the pass line is not reliable on its own. Findings name the defect and its fix, so they
decide the verdict.

### Pairwise judging as the gate

Ask judges which of two mocks is better. Rejected because the gate asks whether one mock is good
enough, not which of two is better. Judges can also favor the option they see first.

### HTML mocks with generated CSS

Write each mock as an HTML page, styled with CSS generated from the kit's values. Rejected because
generated CSS stops wrong values but not wrong parts. A CSS copy of each kit part would be a second
kit that drifts from the real one.

### Judges check contrast and kit values

Let the judges flag contrast and off-kit values from the image. Rejected because model judges read
low-level values such as contrast ratios, sizes, and colors poorly, while a test computes them
exactly from the code and the theme file.

### Score usability on scenes

Score efficiency, control and error recovery, accessibility and input, and adaptability on the
scenes too. Rejected because a scene with fake data cannot show keyboard use, recovery from an
error, or a narrow window, so the judges would guess at those findings.
