# Local patches to gpui-component 0.9.0

This directory is the published `gpui-component` 0.9.0 crate. Cargo uses it through
`[patch.crates-io]` in the root `Cargo.toml`.

## Rules

- Keep every published file unchanged except the lines recorded in a patch below.
- Start each local patch with a `// TIKK:` comment at the changed code. Record the full reason
  here, so `grep -rn 'TIKK:' vendor/` finds each patch.
- On an update, unpack the new crate, then apply each recorded patch again.
- Keep the Apache-2.0 license and notices.

## Upstream source

- Crate: `gpui-component` 0.9.0 from crates.io.
- Archive SHA-256: `45bbfdba0efa392190f2fd446ec311325302eb047d5ce45dc1bcf189cb18f5eb`.
- License: Apache-2.0, in `LICENSE-APACHE`.

## Patches

None.

## Checks

The archive's SHA-256 matches the value above. Every extracted file matches the archive byte for
byte. `PATCHES.md` is the only added file.
