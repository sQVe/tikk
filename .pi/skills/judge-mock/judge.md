# Judge instructions

You review one tikk UI mock. The packet holds `context.md`, the shot, the crop, and `check.txt`. The
shot is the authoritative image. The crop shows detail.

## Scope and evidence

- Review the artifact, not the designer's intent. Do not look for or use earlier rounds.
- Review each candidate alone. Search for defects. Do not rank it against other mocks.
- A scene does not show keyboard use, error recovery, or a narrow window. Do not report those for a
  scene.
- Judge density from the shot, not from an enlarged crop alone.
- The crop is the scene panel. The full shot includes the surrounding window background.
- Unknown details stay unknown. Name the missing evidence instead of guessing.
- Do not report contrast or off-kit sizes and colors. `cargo xtask check` covers them.

## Kit rules

- Scenes use real kit parts and tikk's shared parts with fake data.
- Sizes, spacing, corner radii, text sizes, and colors come from the kit or tikk theme tokens.
- Judge the surface against the tasks in `context.md`. Do not assume a visual direction that the
  packet does not specify.

## Categories

For scope `scene`, judge the first eight categories. For scope `app`, judge all twelve.

- `visualHierarchy`: Do titles and section headers read before secondary text? Does the selected
  item stand out? Are related rows and controls grouped and aligned?
- `typeSpacingDensity`: Do labels, metadata, and headings use different roles? Do repeated rows keep
  one rhythm? Does truncation keep the text the task needs?
- `consistency`: Do cards, pills, marks, and popup content use one shape language? Do focused and
  unfocused panes use one focus treatment?
- `polish`: Is text free of clipping and overlap? Are stray lines, double borders, and shadows
  absent? Are icons aligned with their labels? Are empty states drawn?
- `informationArchitecture`: Can the user find the information that each task needs? Are labels
  and groups clear? Does a popup state its purpose?
- `affordances`: Do buttons, tabs, and rows look clickable? Does the active row show without relying
  on color alone?
- `stateVisibility`: Are focus, selection, running, idle, and hover states visible and distinct?
- `taskFit`: Can each task in `context.md` be finished from the shown surface? Is information the
  task needs hidden or absent?
- `efficiency`: Can the user reach the result in few steps? Do repeated actions keep their place?
  Are key hints shown for common actions?
- `controlAndRecovery`: Can the user cancel without acting? Does a destructive action ask first?
  Does a failed action show a message and a next step?
- `accessibilityAndInput`: Does each control have a visible focus ring and an accessible name? Can
  the keyboard reach each control?
- `adaptability`: Does the layout keep the task's content at a narrow width? Do long labels truncate
  without hiding task text? Does a theme change keep boundaries visible?

## Severity

Use Nielsen's scale for each finding:

- 0: not a problem.
- 1: cosmetic. It does not block a task.
- 2: minor. It causes an interruption.
- 3: major. It blocks a core task.
- 4: catastrophe. The task cannot be done.

A shot cannot prove how often a problem occurs. Mark any frequency claim as provisional.

## Hard failures

Report these kinds only:

- `hiddenTaskInformation`: information the task needs is hidden or absent.
- `unclearFocusOrMode`: the user cannot tell which pane has focus or which mode is active.
- `unreadableText`: required text cannot be read at the native display scale.

## Answer

Write the answer to the path the task names. The file holds only this Markdown, in this order:

1. The first line is exactly one of `Verdict: pass`, `Verdict: fail`, or `Verdict: needs evidence`.
   - Use `fail` when any finding has severity 2 or higher, or any hard failure is open.
   - Use `needs evidence` when no such finding is open and the packet lacks evidence to decide.
   - Otherwise use `pass`.
2. `## Findings`: one entry per finding, with its ID, category, severity, location, evidence, and a
   suggested fix. Write `None.` when there are none.
3. `## Hard failures`: each kind, its location, and its evidence. Write `None.` when there are none.
4. `## Missing evidence`: what you needed and did not get. Write `None.` when there is none.
