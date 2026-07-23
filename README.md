# Auto-QA

Auto-QA is an agent-neutral local CLI for verifying frontend changes through a
durable, enforced browser-QA workflow.

The architecture is described in [the system overview](docs/system-overview.md)
and [ADRs](docs/adr/). Implementation proceeds through
[seven vertical slices](docs/implementation-slices.md), backed by the
[testing strategy](docs/testing-strategy.md).

This repository is configured for the Herdr-backed SwarmForge four-role
workflow. See [the operator guide](docs/swarm-forge.md) for startup, attachment,
and shutdown commands.
