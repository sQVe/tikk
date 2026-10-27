---
'tikk': minor
---

The terminal UI shows the list and the selected row's detail side by side when the terminal is at
least 90 columns wide. In a narrower terminal, press Enter to open the detail full screen, and press
Esc to return to the list.

Press `?` to open help. Help lists the key for each action. An action that cannot run now shows the
reason, such as "No ticket is selected." Press `gm` to see recent messages, such as a failed editor
run or a problem in a ticket file.

Change keys in `$XDG_CONFIG_HOME/tikk/config.json`, or in `~/.config/tikk/config.json` when
`XDG_CONFIG_HOME` is not set. Each key names a command by its ID. For example,
`{ "version": 1, "keys": { "help": ["h"] } }` moves help from `?` to `h`. Ctrl+C always quits. When
the file has an error, tikk keeps the default keys and the messages name the file and the problem.
