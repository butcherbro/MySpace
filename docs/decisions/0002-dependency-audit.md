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

## Addendum (2026-09-18): `pulldown-cmark`

Added to render `.md` file cards as HTML (todo.md #21) instead of raw text.

| Package | Version | License | Maintainer / org | Threat |
|---|---|---|---|---|
| `pulldown-cmark` | 0.13.4 | MIT | pulldown-cmark-org (raphlinus et al.), also vendored by `rustdoc`/`rustc` itself | LOW |

CommonMark/GFM parser only, no network access, no macros/build scripts beyond
standard cargo. Pulled in one transitive dependency, `pulldown-cmark-escape`
(same org, MIT) and `unicase` (MIT, used for case-insensitive footnote-label
matching) — both LOW threat by the same criteria. Rendered HTML is served only
inside the existing `sandbox=""` iframe used for `.html` file cards
(`src-tauri/src/lib.rs`), so raw HTML pass-through from markdown source carries
the same (already-accepted) risk profile as arbitrary `.html` files, not a new
one — scripts never execute regardless of markdown content.

- **Уровень угрозы: НИЗКИЙ**
- **Найдено: 0 подозрительных элементов**
- **Вывод: безопасно.**
