# herdr - pi-subagents-integration

**herdr's Pi integration, with support for [pi-subagents](https://github.com/nicobailon/pi-subagents) background runs.**

<p align="center">
  <img src="assets/demo.gif" alt="herdr keeps the Pi pane working while a background subagent runs, then marks it idle when the parent finishes" width="900" />
</p>

<p align="center"><sub>the pane stays <b>working</b> with <code>⏳ 1 subagent</code> while the child runs, and only goes idle once the parent is really done. <a href="assets/demo.mp4">mp4 →</a></sub></p>

---

## install

swap herdr's official Pi integration for this one:

```sh
herdr integration uninstall pi
pi install git:github.com/zeekrey/herdr-pi-subagents
```

restart Pi inside herdr. that's it.

### show the subagent label (optional)

pi-subagents reports a label like `⏳ 2 subagents (worker, reviewer)`, but herdr's default sidebar hides it. add `state_text` to the agent rows in `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent", "state_text"],
]
```

then `herdr server reload-config`. while subagents run, the Pi entry shows the label; otherwise it shows the normal `idle` / `done` / `working`. this only affects the expanded sidebar.

> **heads up:** `herdr integration install pi`, or saying yes to herdr's "integration outdated" prompt, brings the official extension back. this one then steps aside (and tells you so) until you uninstall the official one again, so the two never fight over your pane.

## the problem

with the official integration, you ask Pi to fan out some background subagents, and herdr immediately says **done** 🔔. but nothing is done: the subagents are still chewing away.

why:

- herdr's extension only watches the parent's own turn: `agent_start` means working, `agent_settled` means idle.
- launching a background subagent returns right away, so the parent's turn ends, and the pane flips to idle. herdr sees working → idle that you haven't looked at yet and calls it done.
- pi-subagents already sends a `herdr:busy` signal while background runs are active. herdr's extension just doesn't listen for it. pi-subagents even says so in its docs: *"Herdr's Pi integration does not consume `herdr:busy` yet."*

this package is the official extension plus that missing listener. the pane stays **working** while any subagent runs, and when the last one finishes it waits a moment for Pi to pick the results back up, so you don't get a fake done in between.
