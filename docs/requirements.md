# 2026.Nov.07: Product Requirements for Mobile + Desktop app

The changes described here represent the first step toward a user-facing graphical UX.
Therefore, there are two steps: set up the overall UX application, and then build
the initial content within it (charts providing observability of collected data).

## 1. User-facing graphical application
### 1a. Application shell
Render a responsive layout that will work on mobile devices of various resolutions
and aspect ratios, and also on a desktop browser. Prioritize mobile views, in portrait mode,
but also ensure the mobile layout works when the device is rotated to landscape mode.

### 1b. Technology choice
Create the application using modern Web technologies.
Prioritize, in order (highest to lowest):
* Page load performance, especially on mobile devices
* Interaction performance, especially on mobile devices
* Small bundle size
* Compatibility with charting libraries evaluated in charts-research.md
* Familiarity to modern Web developers
* Code legibility and extensibility

Offer multiple technical approaches for me to choose from, with pros and cons of each.
I'm leaning toward Svelte.

### 1c. Layout / navigation
Use a standard mobile navigation paradigm, with top-level navigation via labeled
icon buttons within thumb reach. For responsive layouts on larger viewports,
follow Material Design guidelines for Scaling and Adaptation:
https://m2.material.io/components/bottom-navigation#behavior

### 1d. Styling
For navigation elements, leverage modern device-native styling, but simplified.
E.g. avoid complex Liquid Glass-style refraction; favor subtle transparency and flat design instead.
For interactive elements generally, leverage Material 3 Expressive concepts;
if we choose Svelte, [Noph UI](noph.dev) seems like the right choice.
For layout and spacing, follow best practices outlined by [Material 3](https://m3.material.io/styles/spacing/overview).

## 2. Application tabs
The application will have three tabs: Current state monitor, History, and Messages.
These tabs will be accessible to the user via the navigation specified above in 1c.
There may be more tabs in the future, but for now we'll have these three:

### 2a. Current state monitor
The first application tab. Label it "Now", and use a ⚡️ icon.
Displays the current state of the vehicle and home battery, and information
about any active charging session. I'll play a more direct role in designing
this tab, so for now just propose a simple big number display for EV + home
battery SoC and a brief text message describing current charging session.

### 2b. History
The second application tab. Label it "Then", and use a 🔄 icon.
Displays a dashboard of time-series charts and dropdowns that provide a view
into data in our stores, to help the user understand the functioning of the system.

#### BSoC + Sessions chart
At the top of the tab, render a time-series chart that uses the full container width.

The time series chart displays two values (on the y-axis) over a single time scale (on the x-axis):
* Vehicle BSoC
* Home battery BSoC
Color each line differently, and add a legend below the chart to label the colors.

When the time series chart has interaction focus, it should support timescale (x-axis)
zoom and pan, using standard scroll gestures/inputs per mouse, trackpad, touchscreen, etc.
Scrolling vertically zooms the time scale in/out; scrolling horizontally scrubs
the time scale forward/backward in time. The maximum zoom displays two hours of data;
the minimum zoom displays one year of data (if available, and if performant).

I'll leave it to you to handle pagination / lazy loading of data beyond the initial payload,
on user interaction.

Add markers to indicate charging sessions: a faint vertical line on the chart at the start
and at the end of the charging session, with the chart background slightly tinted in between.
On hover/touch of a charging session, display a tooltip that includes metadata about the session:
* Charging start time
* Charging end time
* Vehicle % BSoC start -> end
* Home battery % BSoC start -> end

#### Sessions history selector
Below the BSoC + Sessions chart, render a dropdown selector that contains a list of
charging sessions. Each session is labeled with its start date + time. Selecting a
charging session scrolls and zooms the BSoC + Sessions chart to bring the selected
session into focus, over a one-second eased transition.

I'll leave it to you to handle pagination / lazy loading of data beyond the initial payload.

#### System monitor
Below the Sessions history selector, add another chart. Similar to the BSoC + Sessions
chart, this is a zoomable + scrollable full-conatiner width time-series chart.
This chart displays a number of values, as area charts; it has a vertically-centered
zero-line with some time-series values displayed above and others displayed below.

The values (all units in kWh):
* Grid export, displayed above the centerline
* Grid import, displayed below the centerline
* Solar energy produced, displayed above the centerline
* Energy used by the home/vehicle, displayed below the centerline

Overlaid across the top of the chart (with some buffer to avoid overlapping the
time-series area chart lines themselves), render a top bar displaying weather conditions.
The background of the bar is a light-dark gradient (at 60% alpha) that corresponds to solar irradiance.
Overlaid on the backgound are icons for the weather, spaced at even (px) intervals.
Note: this will require fetching more data from OpenMeteo, likely fetching `weather_code`
and `is_day`, and the icon mapping implemented in the OpenMeteo website project
as [documented here](https://github.com/open-meteo/open-meteo/issues/789#issuecomment-5023503709).
Spacing of the icons depends on the zoom, but never displays more than one icon
per hour on the horizontal time axis. As the chart zooms out, drop icons evenly
to avoid visual clutter and maintain even spacing.

Display this weather bar only when zoomed in to where one week of data or less
is visible on the chart. Fade the bar in/out over 0.5 seconds as needed when zooming.

### 2c. Messages
Displays a list of all the notifications that have been sent. This is basically
the same as what ntfy / Slack displays for our topic.

Note this tab also requires that we establish a push notification channel for our app,
that works across desktop browser and mobile apps.


# 2026.Oct.14: Product Requirements update

## Vehicle charging trigger
Detect a charger plugged in event when the vehicle is at home, adjacent to the solar battery.
At this point, trigger the logic to determine if and how much the vehicle should charge,
and automatically begin charging.


# 2026.Oct.10: Product Requirements update

## Vehicle charging behavior
The goal is to use the home solar battery to both charge the EV battery and power the home, without drawing energy from the grid.
This requires knowing the state of the home solar battery and the EV battery, and maintaining a buffer of energy in the home solar battery for use in the home.
* The Tesla API allows setting a target SoC of anywhere from 50-100%. The Tesla API clamps the target to a minimum of 50%.
* When evaluating state at the start of a planned charging session, the vehicle BSoC can be at any value from 0-100%.
* If the amount of charge available in the solar battery is not enough to charge the vehicle to >= the 50% minimum, then the program will have to set a target lower than the 50% minimum and stop charging via the API once the vehicle BSoC reaches the target. We'll implement this in phases:
    1. Just set-ev-charge-limit to the minimum value allowed by the Tesla API (50%).
    2. Add the intelligence to poll the vehicle charging progress and stop charging at our calculated target.
* Generally, we should express energy in kWh; Tesla and Franklin APIs use %, but to transfer energy between them, kWh is the compatible unit.


# 2026.Mar.01: initial prompt

Create a TypeScript / NodeJS application. The purpose of this application will be to enable me to charge my electric vehicle (EV) with as much energy as is stored in the battery connected to my home solar system. The application architecture should support charging any kind of EV, from any kind of battery, but to start let's make it work specifically with the kind of EV and battery I have: a Tesla Model Y and a FranklinWH aPower 2. Also, let's start with a command-line interface first; we can build a GUI later.

## Communicating with the FranklinWH API
Use the python library `franklinwh` (from https://github.com/richo/franklinwh-python) to instantiate a FranklinWH API client, and send API requests and responses through that client to the business logic in the JavaScript application. I prefer developing in JavaScript, so want to be able to edit business logic there.

This could be achieved via the `python-shell` npm package (https://www.npmjs.com/package/python-shell), but this appears to spawn a new process on every API call. A better approach, if possible, may be to spawn a python server that can be called on localhost, and proxies calls to FranklinWH's APIs.

We'll need to set up authentication with the FranklinWH API, so please provide a mechanism to prompt the user for their API credentials, and for securely storing and reusing those credentials.

## Communicating with the Tesla API
Use the Tesla Fleet API (https://developer.tesla.com/docs/fleet-api) to communicate with the vehicle. Set up the authentication required by the API, with the required auth scopes. Set up the necessary application Virtual Key. If auth requires user action to complete, be sure to prompt and respond to the necessary user actions. Provide a mechanism for securely storing and reusing the Tesla API developer credentials.

## Usage / API
The CLI should offer the following functionality:
* `start`: Start the Python API proxy and NodeJS server.
* `exit`: Terminate the Python API proxy and NodeJS server.
* `get-ev-bsoc`: Get the current battery state of charge from the EV.
* `get-battery-soc`: Get the current battery state of charge from the solar battery.
* `set-ev-charge-limit`: Set the EV's charge limit.
* `start-ev-charging`: Start charging the EV.
* `stop-ev-charging`: Stop charging the EV.
* `charge-from-battery`: Set the EV charge limit to the amount of BSoC left in the solar battery (minus any buffer that must remain in the battery).
* `set-battery-buffer`: Specify the amount of charge to remain in the solar battery; this will not be used for charging the EV.

## Other
This project will be open-source via the MIT license. Add documentation in README.md and the necessary license files for this. Also, document the CLI in the README.
