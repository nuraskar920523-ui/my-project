# TenderSniper Lite (Алматы) — v5.4

- `dist/TenderSniper_Lite_Almaty.json` — готовый workflow n8n для импорта.
- `CHANGES.md` — что исправлено по аудиту, изменения поведения, что осталось на решение.
- `INSTRUCTION_FOR_CLI.md` — пошаговая инструкция для CLI-агента: проверка сервера, бэкап, импорт, приёмка, откат.

Разработка: код Code-узлов лежит в `src/` (общие части — `src/lib/`, вставляются через `//@@include:<name>`).
```bash
python3 build.py                                                   # собрать dist/ (+ проверка синтаксиса узлов)
docker run --rm -e TS_TEST_SANDBOX=1 -v "$PWD":/w -w /w node:22 node test/run_tests.js   # 31 тест на моках
```
Тесты пишут в `/home/node/.n8n` — только в одноразовом контейнере, никогда на рабочем сервере n8n.
