# Pi Desktop

This alpha Electron/React/TypeScript GUI fronts Pi and OMP agent runtimes. Read [CONTRIBUTING.md](CONTRIBUTING.md) and [HOUSE_STANDARDS.md](HOUSE_STANDARDS.md) for implementation. Load the task-applicable sections below; retained reference rules remain mandatory for those surfaces. Alpha APIs may change; preserve forward migrations where practical and never label alpha releases production-ready.

`src/shared` owns pure typed contracts/defaults; `src/main` owns IPC, files, trust and subprocess lifecycle; preload exposes the contextBridge; renderer owns UI/state. Keep Pi/OMP engine-specific paths, session stores, configuration formats, skills, and plugin discovery distinct. Do not inject `--session-dir` when callers have not supplied it. Preserve JSONL RPC correlation, streaming, cancellation, and descendant shutdown ownership.

Retain Electron context isolation, disabled Node integration, sandboxing, typed IPC payload validation, trusted renderer navigation/sender checks, and no renderer Node access. Untrusted workspace allow rules and preview scripts/network remain disabled until trusted. Confine attachments/session deletion to authorized paths and validate package specs before invoking a CLI. Do not weaken these checks for convenience.

Use Node 22.16+ and locked dependencies. Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run format:check`, and `npm run build` as applicable; match current CI. Prefer package scripts/local locked binaries over fetching tools with npx; existing reference npx examples predate CI's ban in workflow/scripts. Native build checks belong in the build lane. Scope formatting to fork-owned globs and changed files; preserve the deliberate TypeScript/renderer rollout exceptions in HOUSE_STANDARDS.

Reuse existing modules and patterns, add focused tests, remove dead code, and deliver complete behavior. Distribution is prebuilt GitHub Release binaries via electron-builder; never npm publish. Follow platform-specific packaging constraints and release checks in the reference. The historical MEMORY.md update suggestion never overrides the operator's requirement that saved memory changes need explicit instruction. Keep credentials, private sessions, and live user configuration out of tests and logs.

## Load rules by task

- Module placement: [Project Structure](docs/AGENT_REFERENCE.md#project-structure); IPC/security changes: [Security](docs/AGENT_REFERENCE.md#security) and [IPC Architecture](docs/AGENT_REFERENCE.md#ipc-architecture).
- Engine/session/subprocess/config changes: [Engines](docs/AGENT_REFERENCE.md#engines-pi-and-omp), [Session Management](docs/AGENT_REFERENCE.md#session-management), [Data Storage](docs/AGENT_REFERENCE.md#data-storage), and [Pi Integration](docs/AGENT_REFERENCE.md#pi-integration).
- Renderer/UI changes: select the affected feature subsection under [Features](docs/AGENT_REFERENCE.md#features), plus its shared/main/preload contract; do not load unrelated feature inventories.
- Packaging/releases: [Distribution](docs/AGENT_REFERENCE.md#distribution) and [Versioning](docs/AGENT_REFERENCE.md#versioning). Development launch changes: [Development](docs/AGENT_REFERENCE.md#development).
- Final implementation handoff: [Final Delivery Checklist](docs/AGENT_REFERENCE.md#final-delivery-checklist).
