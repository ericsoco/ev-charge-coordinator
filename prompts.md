# 2026.Mar.01

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