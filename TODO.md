FEATURES
[ ] Trigger charging math + session on vehicle plugged in (at home) event. Does Tesla provide a way to push this event?
    [ ] Need to (re?) design application as a long-running process
[ ] Host application online somewhere
    Ideally this is part of the install + build process, and can leverage publicly available tooling for hosting (GH pages?)
    Need to think about what other functionality we'll need in the future,
    e.g. limited data storage for historical battery usage, past charging sessions, etc
[ ] Base charge amount on:
    [ ] Solar battery historical usage (average / seasonal / day of week) -- build local record over time and/or try to find an API?
    [ ] weather forecast (solar irradiation)
    [ ] projected amount of battery storage accrued during EV charging session (based on both of the above)
[ ] 

TASKS / BUGS
[ ] Recreate ev-charge-coordinator application on Tesla dev portal to expire the client secret that was leaked into LLM logs. Will require rerunning `pair-tesla-key` and `authenticate`.
[ ] Rename ambiguous battery-related commands like `get-battery-soc`, `charge-from-battery`, and `set-battery-buffer`
[ ] Consider removing `get-ev-bsoc` in favor of `get-charging-state`
[ ] Clean up README (remove slop; make dev setup steps clear and contiguous; same for end-user steps; ensure unified docs across CLI + REPL, as there is some divergence)
    [ ] So far, have cleaned up up to "## CLI Reference". Continue from there.
         [ ] ...but skipped over Tesla and Franklin setup in ## Configuration
[ ] Wake before issuing command -- how to ensure app is not keeping vehicle awake and causing phantom drain? Need some research.
    Note: this is already in place for write (state-changing) commands, but not for reads.
[ ] Rename `npm start config --clear-all` to `--clear-credentials`
[ ] Tab completion for flags
[ ] Replace `keytar` (deprecated) with...? Need to clarify specific needed functionality.
    [ ] Update CI accordingly
[ ] 