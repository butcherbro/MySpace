# MySpace — правила для Claude Code

Локальное Milanote-подобное приложение: Tauri 2 (Rust, `src-tauri/`) + React 19 + TS (`src/`),
SQLite (rusqlite bundled, FTS5), синхронизация устройств по LAN, автообновление через GitHub Releases.
Пользователь — вайб-кодер, цель production-качество. Роль Claude — техлид: думать на шаг вперёд,
останавливать плохие решения, объяснять почему. Отвечать по-русски.

## Где что лежит
- Текущее состояние и следующий шаг: `.continue-here.md` (читать первым).
- Бэклог и известные ограничения: `tasks/todo.md` (разделы «Следующие фичи», «Sync», «P2 / platform»).
- Архитектура: `docs/audits/2026-09-24-architecture-audit.md`, решения — `docs/decisions/` (ADR-0011 sync, ADR-0012 устройства).
- Релизы: `docs/release.md`. Платформы: `README.md`, раздел Platforms.

## Ветки и релизы
- Работа в фича-ветках от `main`, PR в `main`. Прямо в `main` не пушить.
- Версия живёт в трёх местах: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (+ lock-файлы).
- Релиз: поднять версию во всех трёх, влить в `main`, затем `git tag vX.Y.Z && git push origin vX.Y.Z`.
  Workflow `.github/workflows/release.yml` соберёт macOS arm64/x64 и Windows и опубликует в публичный
  `butcherbro/MySpace-releases`. Установленные приложения обновятся сами.
- Приватный ключ подписи обновлений — только в GitHub Secrets и менеджере паролей, никогда в репозитории.

## Гейты перед каждым коммитом (все должны быть зелёными)
```
npm run typecheck && npm run lint && npm run test
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
npm run test:e2e        # Playwright против mock-бэкенда в браузере
```
Известный флейк e2e: `group-tab-drop.spec.ts:40`. Остальные падения — реальные.

## Запуск
- Dev: `npm run tauri dev` (горячая перезагрузка фронта, Rust пересобирается при изменениях).
- Браузер без Rust: `npm run dev` → http://localhost:1420, работает mock-бэкенд; фикстуры через `?fixture=...`
  (`dense-board`, `corrupt-note`, `foreign-shortcut`, `sync-peers`, `startup-failure`).
- Данные приложения: macOS `~/Library/Application Support/com.bro.myspace`, Windows `%APPDATA%\com.bro.myspace`.
  Логи — `logs/myspace.log.<YYYY-MM-DD>` там же (JSON, по дню на файл). Dev и установленная версия делят одну базу.

## Архитектурные правила (не нарушать)
- Все записи в БД идут через один писатель (`Workspace`, `sync::funnel::apply`) в одной транзакции.
  Новая мутация — вариант `Mutation` в `domain/mutation.rs` с `op_name()` и решением `is_local_only()`.
- Новый тип карточки — через реестр `domain/kinds/` (`to_payload`/`from_payload`), миграция additive.
- Таблицы, привязанные к устройству, перечислены в `LOCAL_ONLY_TABLES` и не синхронизируются.
- Фронт не угадывает ревизии: мутации возвращают receipt с DTO.
- Платформенный код: macOS-ветка + ветка для остальных; проверять `cargo clippy --target x86_64-pc-windows-gnu`
  или CI-джоб `windows-cargo`.
- Не добавлять зависимости без проверки лицензии и `cargo audit` / `npm audit`.

## Субагенты
Мелкие изолированные задачи можно отдавать субагентам с явным списком файлов. Субагентам запрещены
`git stash/checkout/reset` и коммиты; коммитит только основная сессия после прогона гейтов.
