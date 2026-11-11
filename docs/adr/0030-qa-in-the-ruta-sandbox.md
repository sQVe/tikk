# ADR 0030: QA in the ruta sandbox

**Date**: 2026-11-11\
**Status**: Accepted\
**Related**: [ADR 0028 (Two-family UI mock gate)](./0028-two-family-ui-mock-gate.md)

## Context

UI review needs captures of real GPUI rendering. Input checks also need a real window. Running
those checks on the user's desktop could move their pointer, take keyboard focus, or open links.
The desktop's scale and other windows would also affect captures.

Display isolation, input, capture, and cleanup are shared needs across projects. Maintaining those
parts inside tikk would duplicate the work of the ruta CLI.

## Decision

tikk uses ruta for UI QA on a private headless Weston and Xwayland display. Agents run and drive
scenes only in that sandbox, never on the real display. This isolates display and input without
pretending to isolate a native process from the host machine.

ruta owns display isolation, input, capture, and process cleanup. tikk owns `ruta.toml`, the scene
build, and scene-name validation for capture. Thin xtask wrappers keep these responsibilities
separate. The installed ruta release is pinned in development and CI commands.

The scene build keeps the caller's toolchain environment but drops display and session variables.
Runtime processes use ruta's private display and environment. One-shot captures use a separate
sandbox so they do not stop an interactive session. Input coordinates and captures use the same
private window pixels.

A headed demo is an explicit exception to headless operation. Only the nested compositor may use
the user's Wayland session. The scene, input, and capture stay on its private display. Unattended
QA remains headless.

## Consequences

### Positive

- Captures show the real GPUI renderer without taking over the user's display or input.
- ruta shares display and cleanup fixes across projects.
- tikk keeps build and scene validation local, without owning a second sandbox implementation.

### Negative

- Capture and input checks require Linux, ruta, Weston, Xwayland, xdotool, ImageMagick, and a Vulkan
  driver. They cover GPUI's X11 backend, not its native Wayland backend.
- The wrapper requires the scene binary at the path in `ruta.toml`. Custom Cargo target folders
  cannot be used for capture.
- Changes to ruta's CLI or config require checking the wrappers and the end-to-end test.
- Headed demos can mix user input with agent input and are not suitable for unattended checks.
- The sandbox is not a security boundary against a process with host shell access.

## Alternatives considered

### The user's real display

Open the scene on the desktop that is already running. Rejected because input could interfere with
other work, and desktop state would affect captures.

### A sandbox inside xtask

Own the compositor, input, and process cleanup code inside tikk. Rejected because this duplicates
shared infrastructure and makes tikk responsible for fixes unrelated to its UI.

### Native Wayland capture and input

Use a private compositor with Wayland input and capture protocols. Deferred because ruta already
provides the required window capture and input through Xwayland. Supporting another backend would
add a second set of tools and checks before tikk needs it.
