Design considerations for observability dashboard.

Contains visual summaries of data in all stores written by the daemon;
also displays information about the app itself and its performance (...eventually. maybe.)

# Stores
- home_battery_samples {soc, wattages: power, home load, solar, grid}
    {
        "id": 4736,
        "siteId": "home",
        "homeBatteryId": "10060005A03X25160189",
        "ts": "2026-11-02T04:53:15.307Z",
        "socPercent": 28.526,
        "socKwh": null,
        "powerW": 5111,
        "homeLoadW": 5117,
        "solarW": -6,
        "gridW": 12
    }

- home_energy_counters {daily amounts (kWh): battery i/o, grid i/o, solar import, home export}
    {
        "id": 4736,
        "siteId": "home",
        "homeBatteryId": "10060005A03X25160189",
        "ts": "2026-11-02T04:53:15.307Z",
        "batteryChargeKwh": 9.006,
        "batteryDischargeKwh": 10.169,
        "gridImportKwh": 0.698,
        "gridExportKwh": 11.435,
        "solarKwh": 22.346,
        "homeUseKwh": 12.924
    }

- ev_samples {vehicle online/offline, charging, soc, energy added}
    {
        "id": 723,
        "vehicleId": "5YJYGDEE0MF094320",
        "ts": "2026-11-02T04:41:14.252Z",
        "state": "online",
        "chargingState": "Stopped",
        "socPercent": 16,
        "chargeEnergyAddedKwh": 4.36
    }

- events
    by kind: charging_start=12 charging_stop=12 daemon_start=27 daemon_stop=19 plug_in=18 unplug=17
    event: 2026-11-02T04:33:10.294Z charging_stop Charging→Stopped

- sessions {start+end ts, energy reeived (kWh + %), home battery??, efficiency}
    {
        "id": 18,
        "siteId": "home",
        "vehicleId": "5YJYGDEE0MF094320",
        "homeBatteryId": "10060005A03X25160189",
        "plugTs": "2026-11-02T03:17:06.335Z",
        "unplugTsMs": null,
        "energyKwh": null,
        "energyPercent": null,
        "elapsedMs": null,
        "houseEnergyKwh": null,
        "efficiency": null
    }

- weather_forecasts {...TODO: schema?...}
    TODO

- decisions
    decision: 2026-11-01 19:17:06 session 18 accepted=0 dry=0 already_charging
        vehicle is already charging
        filters: []
    decision: 2026-10-30 20:02:08 session 17 accepted=1 dry=0 started
        starting: charge limit 76% (none) — 3.5 kWh above 30% buffer
        filters: [{"type":"geofence","pass":true,"reason":"geofence","detail":"at home: 3 m of 25 m radius","distanceM":3}]
    decision: 2026-10-30 09:24:32 session 15 accepted=0 dry=0 below_buffer
        home battery 14.632% is at or below the 30% buffer
        filters: []

# Charts
P0: charts that are specifically relevant to the core function of this app:
charging from battery/solar, not from the grid. Don't overload with data trivia.
P1: data relevant to charging decisions, that help end user understand system state,
but do not directly represent system state changes. I.e., inputs to decisions.
P2: monitoring system functionality; more for the developer than the end-user.

- [P0] Vehicle + home battery SoC
- [P0] Session history
- [P1] I/O: Grid import/export, solar supply, home + EV usage
- [P1] Weather (irradiance, anything else?)
- [P2] Decision history (collapsed list; load last N then paginate)
- [P2] Events history (same)

Questions + ideas to add to prompt:
- How to handle time scales? continuous zoomable line chart? amcharts does this so well...how to emulate with echarts...?
- Layout must rotate along with phone -- horizontal aspect ratio is best way to view time series charts
- Weather icons (sun, cloud, moon, etc) are more legible + familiar than something displaying solar irradiance.
  OpenMeteo should pull this data too, to display as icons evenly across the top of P1 I/O chart;
  also, underlay these with a gradient band representing solar irradiance.