# Contributing

Thanks for helping improve WebHarness.

## Before you start

Read [docs/development.md](docs/development.md) for the code layout, supported runtime, and verification commands. Behavior changes should include a test that fails before the change and passes afterward.

## Pull requests

Keep changes focused. Explain the user-visible behavior, the trust/security impact if any, and the verification you ran.

At minimum, run:

```bash
bash tests/harness.sh
bash tests/publication.sh
bash tests/lifecycle.sh
npm --prefix providers/pi-dev ci
npm --prefix providers/pi-dev test
```

Do not commit `.env`, OAuth/session state, logs, runtime PID files, generated `node_modules`, or real deployment credentials/hostnames.

## Security changes

If a change touches path confinement, process execution, OAuth, lifecycle ownership, or credential/state handling, describe the threat it addresses and add a regression test for that boundary.
