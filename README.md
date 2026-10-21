# herdr-pi-subagents

herdr's Pi integration, with support for [pi-subagents](https://github.com/nicobailon/pi-subagents) background runs.

## The problem

With herdr's official Pi integration, a pane shows **done** and fires the done notification as soon as the main agent launches background subagents, even though work is still running.

- herdr's extension derives the pane state from the parent's own turn: `agent_start` means working, and `agent_settled` with `isIdle()` means idle. The only outside signal it accepts is `herdr:blocked`.
- A background subagent launch returns right away, so the parent's turn ends and the pane reports idle. herdr shows a working → idle transition you haven't looked at as done.
- pi-subagents already emits `herdr:busy` (`{ active, label }`) while background runs are active, but herdr's extension doesn't listen for it. pi-subagents documents this in `docs/extension-api.md`: *"Herdr's Pi integration does not consume `herdr:busy` yet."* Its `report-metadata` call only changes the label, so you see "⏳ 2 subagents" next to a done dot.

## What this package changes

The extension is herdr's Pi integration (version 9), reporting under the same `herdr:pi` source, with these differences:

- **Counts `herdr:busy` like `herdr:blocked`.** The pane reports `working` while the parent's turn is active or any background run is active. `blocked` still takes precedence.
- **Holds idle briefly when the last run finishes.** pi-subagents wakes the parent with a new turn when a run completes. The extension waits `HERDR_PI_SUBAGENTS_IDLE_DEBOUNCE_MS` (default `1500`) before reporting idle, so the pane goes straight from working to working instead of flashing done in between. This only applies when busy ends; a normal end of turn reports idle immediately, as before.
- **Counts busy raised before the session starts.** On `/reload`, pi-subagents can re-raise busy before this extension's `session_start` runs.
- **Disables itself next to the official integration.** If `~/.pi/agent/extensions/herdr-agent-state.ts` (or the same path under `$PI_CODING_AGENT_DIR`) is herdr's own extension, this one doesn't report anything and shows a warning instead, so the two don't race on the pane state.

## Install

```sh
herdr integration uninstall pi
pi install git:github.com/zeekrey/herdr-pi-subagents
```

Then restart Pi inside herdr.

Keep pi-subagents' Herdr bridge enabled. This extension turns its `herdr:busy` signal into pane state.

## Show the subagent label in the sidebar

pi-subagents also reports a label like `⏳ 2 subagents (worker, reviewer)`, but herdr's default sidebar layout doesn't show it. To see it, add `state_text` to the agent rows in `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent", "state_text"],
]
```

Then run `herdr server reload-config`. While background subagents run, the second line of the Pi entry shows the label. Otherwise it shows the normal state (`idle`, `done`, `working`). This only affects the expanded sidebar; the collapsed and mobile views keep their compact layout.

Note: `herdr integration install pi`, or accepting herdr's "integration outdated" prompt, reinstalls the official extension. This package then disables itself until you uninstall the official one again.

## Development

```sh
bun test
```

## License

Apache-2.0, like herdr. See `LICENSE` and `NOTICE`.
