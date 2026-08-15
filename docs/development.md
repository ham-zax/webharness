# Development

## Layout

```text
bin/            public lifecycle commands
config/         trust profiles and MCP template
lib/bridge/     process supervision and lifecycle internals
providers/      model-facing MCP provider implementation
scripts/        setup, rendering, systemd installation, and smoke checks
systemd/        user-service template
tests/          product and lifecycle regression suites
docs/           user-facing documentation
```

The Pi-backed provider lives in `providers/pi-dev/` and has its own pinned npm lockfile and Node test suite.

## Setup for development

```bash
npm --prefix providers/pi-dev ci
```

Node.js `>=22.19` is required by the provider package.

## Test suite

Run:

```bash
bash tests/harness.sh
bash tests/publication.sh
bash tests/lifecycle.sh
npm --prefix providers/pi-dev test
```

Static checks:

```bash
bash -n bin/* lib/bridge/*.sh scripts/*.sh tests/*.sh
node --check scripts/render-config.mjs
node --check providers/pi-dev/server.mjs
git diff --check
```

Dependency audit:

```bash
npm --prefix providers/pi-dev audit --omit=dev
```

## Change discipline

Behavior changes should start with a regression test. Pay particular attention to path canonicalization, create/edit atomicity, process-tree cleanup, output bounds, OAuth/state handling, and lifecycle ownership.

Do not use a live bridge process as the test fixture. The lifecycle suite uses isolated temporary processes/state so development tests do not intentionally interrupt an active ChatGPT connection.
