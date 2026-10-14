[ ] Recreate ev-charge-coordinator application on Tesla dev portal to expire the client secret that was leaked into LLM logs. Will require rerunning `pair-tesla-key` and `authenticate`.
[ ] Rename ambiguous battery-related commands like `get-battery-soc`, `charge-from-battery`, and `set-battery-buffer`
[ ] Clean up README (remove slop; make dev setup steps clear and contiguous; same for end-user steps)
[ ] Wake before issuing command -- how to ensure app is not keeping vehicle awake and causing phantom drain? Need some research.
[ ] Energy config + math (Phase 4) -- overall needs careful review, there's some questionable stuff in here...
    [ ] Make energy config (DEFAULT_ENERGY_CONFIG) editable via config file, not just `config` command with a switch -- this is cumbersome
    [ ] Validate config on config change, not on computeChargeLimit
    [ ] Why is all the energy config stuff stored in credentials? This is not a credential, it's a config.
        Need to look deeper into credentials.ts to understand the point of the file. Seems off -- really should review entire file structure...
[ ] 