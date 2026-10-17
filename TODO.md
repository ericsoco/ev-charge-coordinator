[ ] Recreate ev-charge-coordinator application on Tesla dev portal to expire the client secret that was leaked into LLM logs. Will require rerunning `pair-tesla-key` and `authenticate`.
[ ] Rename ambiguous battery-related commands like `get-battery-soc`, `charge-from-battery`, and `set-battery-buffer`
[ ] Clean up README (remove slop; make dev setup steps clear and contiguous; same for end-user steps)
[ ] Wake before issuing command -- how to ensure app is not keeping vehicle awake and causing phantom drain? Need some research.
[ ] Trigger charging math + session on vehicle plugged in (at home) event. Does Tesla provide a way to push this event?
[ ] Base charge amount on:
    [ ] Solar battery historical usage (average / seasonal / day of week) -- build local record over time and/or try to find an API?
    [ ] weather forecast (solar irradiation)
[ ] 