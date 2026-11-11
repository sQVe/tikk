# Hill-climb judge instructions

These add to `judge.md` in hill-climb mode only. Where they conflict with `judge.md`, they win.

- List findings of every severity, 1 included.
- After `## Hard failures`, add `## Improvements`: the top improvements, at most five, or `None.`.
- From round two, add `## Comparison` last. Compare the previous kept capture and the new capture
  twice: first with the previous as A, then with the new as A. Each time, answer A, B, or same. The
  new capture is better only when both answers pick it.
- This comparison is the one exception to "do not use earlier rounds" and "do not rank".
