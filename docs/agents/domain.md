# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root when it exists. It routes readers to the `CONTEXT.md` files relevant to a topic.
- **`CONTEXT.md`** at the repo root for system-wide product language and concepts.
- **`docs/adr/`** for system-wide decisions that touch the area being changed.
- Context-specific `CONTEXT.md` and `docs/adr/` files under `apps/<context>/` or `packages/<context>/`, as identified by `CONTEXT-MAP.md`.

If any of these files don't exist, **proceed silently**. Don't flag their absence or suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This repo uses a multi-context layout:

```
/
├── CONTEXT-MAP.md                    ← routes topics to contexts
├── CONTEXT.md                        ← system-wide product vocabulary
├── docs/adr/                         ← system-wide decisions
├── apps/
│   └── <context>/
│       ├── CONTEXT.md
│       └── docs/adr/                 ← context-specific decisions
└── packages/
    └── <context>/
        ├── CONTEXT.md
        └── docs/adr/                 ← context-specific decisions
```

Context files are created only when a genuine independently maintained domain boundary is identified.

## Use the glossary's vocabulary

When your output names a domain concept—in an issue title, refactor proposal, hypothesis, or test name—use the term as defined in the relevant `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, either reconsider language the project does not use or note a real gap for `/domain-modeling`.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
