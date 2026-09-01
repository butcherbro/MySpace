# External Dependency Audit (Task 0.2)

Security review of the V1 dependency set before installation, per the
`external-code-security` skill.

**Date:** 2026-09-01
**Method:** npm registry metadata (version, license, maintainers, repository) for
npm packages; crates.io / Crates.io registry for Rust crates.

## Findings

| Package | Version | License | Maintainer / org | Threat |
|---|---|---|---|---|
| `@tauri-apps/cli` | 2.11.4 | Apache-2.0 OR MIT | tauri-apps (official) | LOW |
| `@xyflow/react` | 12.11.5 | MIT | xyflow (official) | LOW |
| `@tiptap/react` | 3.31.0 | MIT | ueberdosis/tiptap (official) | LOW |
| `react` | 19.2.8 | MIT | Meta (official) | LOW |
| `vite` | 8.2.2 | MIT | Vite team (official) | LOW |
| `rusqlite` | (Crates.io) | MIT | rusqlite team (official) | LOW |

All packages are maintained by their well-known official organizations with no
reported malware/backdoor issues. No `exec`, `eval`, obfuscation, credential
bundling, or suspicious network activity was identified at the metadata level.

## Decision

- **Уровень угрозы: НИЗКИЙ**
- **Найдено: 0 подозрительных элементов**
- **Вывод: безопасно.**

Tiptap released 3.31.0 after the plan's snapshot (3.30.5). The lockfile created
during scaffolding is the source of truth. Tiptap Pro/Cloud/Comments/AI packages
are explicitly excluded.
