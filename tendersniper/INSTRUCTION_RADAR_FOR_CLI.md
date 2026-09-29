# Задание для CLI-агента: радар демпинга (v5.5)

> Правила из `INSTRUCTION_FOR_CLI.md` действуют полностью: ничего не менять в коде, на «⛔ СТОП» останавливаться,
> присылать **сырой** вывод. Свои тесты и скрипты не писать и не выдавать их за скрипты из репозитория.

Радар состоит из двух частей:

| Часть | Файл | Что делает |
|---|---|---|
| **Этап A.** Отдельный workflow «Radar Collector» | `dist/TenderSniper_Radar_Collector.json` | Вечером (20:10–22:50 по Алматы, каждые 20 минут) собирает итоги закупок Алматы: все участники, их цены, победители. База: `/home/node/.n8n/tendersniper_radar_db.json` |
| **Этап B.** Блок «⚔️ Риск демпинга» в дайджесте основного бота | изменения в `dist/TenderSniper_Lite_Almaty.json` | Читает базу радара и к каждому лоту пишет риск, частых соперников, ожидаемую цену победителя и безубыточную цену |

Этап A независим от основного бота, его можно ставить сразу: база копится несколько ночей.
Этап B — единая версия основного бота с вашими серверными правками (выгрузка получена).

---

## Этап A. Radar Collector

### A1. Тесты (одноразовый контейнер, не рабочий n8n)
В папке пакета (git-клон ветки `claude/intelligent-mayer-rxcqc6`):
```bash
git log -1 --oneline
python3 build.py
docker run --rm -e TS_TEST_SANDBOX=1 -v "$PWD":/w -w /w node:22 node test/run_radar_tests.js
docker run --rm -e TS_TEST_SANDBOX=1 -v "$PWD":/w -w /w node:22 node test/run_tests.js
```
Ожидается: `Итого радар: 13/13 тестов пройдено` и `Итого: 32/32 тестов пройдено`. **⛔ СТОП** при любом другом результате.

### A2. Импорт (новый workflow, рабочий бот не затрагивается)
```bash
docker cp dist/TenderSniper_Radar_Collector.json <контейнер>:/tmp/radar.json
docker exec -u node <контейнер> n8n import:workflow --input=/tmp/radar.json
docker exec <контейнер> rm /tmp/radar.json
```
В UI откройте «TenderSniper Radar Collector (Almaty)» и проверьте:
- 3 узла: `Schedule (20:10–22:50 Almaty, каждые 20 мин)`, `Manual Run`, `Radar Collector`;
- Workflow Settings → Timezone = **Asia/Almaty**.

### A3. Первый запуск вручную
В UI нажмите **Execute workflow** (узел `Manual Run`). Выполнение займёт до ~4 минут.
Из вывода узла `Radar Collector` пришлите JSON целиком и строку лога `[RADAR] …`. Ожидается:
- `ok: true`, `errors: []` (или единичные);
- `discovered` > 0 (найдены лоты Алматы), `trdBuysProcessed` > 0, `dbLotsWithWinner` > 0.

Затем проверьте файл базы:
```bash
docker exec -u node <контейнер> sh -c 'ls -la /home/node/.n8n/tendersniper_radar_db.json; test -f /home/node/.n8n/tendersniper_radar.lock && echo "LOCK ОСТАЛСЯ" || echo "lock снят"'
```
**⛔ СТОП**, если `ok: false`, все запросы с ошибками или `dbLotsWithWinner: 0` после 2 запусков подряд.

### A4. Активация
Включите Active у «TenderSniper Radar Collector (Almaty)». Утром пришлите лог последнего ночного запуска (`[RADAR] …`).

---

## Этап B. Единая версия основного бота (v5.6) + вечернее расписание

Ваши серверные правки (матрица ТЗ, структура требований, .docx, режим размышления, `MIN_LOT_BUDGET: 0`) перенесены
в исходники с исправлениями и тестами — см. `CHANGES.md`, раздел v5.6. Поэтому основной бот заменяется целиком, без ручных правок.

### B1. Тесты (одноразовый контейнер)
```bash
git pull && git log -1 --oneline
python3 build.py
docker run --rm -e TS_TEST_SANDBOX=1 -v "$PWD":/w -w /w node:22 node test/run_tests.js
docker run --rm -e TS_TEST_SANDBOX=1 -v "$PWD":/w -w /w node:22 node test/run_radar_tests.js
```
Ожидается `Итого: 37/37` и `Итого радар: 13/13`. `git status` не должен показывать изменений в `dist/`. **⛔ СТОП** при расхождении.

### B2. Бэкап и замена основного бота (ID `3FFVZUREP8jZfilm`)
```bash
TS=$(date +%Y%m%d_%H%M%S)
docker exec -u node <контейнер> n8n export:workflow --id=3FFVZUREP8jZfilm --output=/home/node/.n8n/backup_tendersniper_$TS.json
```
Деактивируйте основной бот в UI, затем:
```bash
jq --arg id "3FFVZUREP8jZfilm" '.id = $id | .active = false' dist/TenderSniper_Lite_Almaty.json > /tmp/ts_import.json
docker cp /tmp/ts_import.json <контейнер>:/tmp/ts_import.json
docker exec -u node <контейнер> n8n import:workflow --input=/tmp/ts_import.json
docker exec <контейнер> rm /tmp/ts_import.json
```
В UI проверьте: 22 узла, узел расписания называется `Schedule (09:30, 13:00, 20:20 Almaty)`, credentials Telegram и Google
на месте, Timezone = Asia/Almaty. Активируйте в UI.

### B3. Расписание Radar Collector
Импортируйте `dist/TenderSniper_Radar_Collector.json` поверх существующего (с его ID, как в B2) **или** в UI поменяйте
cron узла расписания на `10,30,50 20-22 * * *`. Проверьте, что Active включён.

Итоговое расписание (ноутбук включён ~09:00–17:00 и ~20:00–23:00):

| Время (Алматы) | Что запускается |
|---|---|
| 20:10, 20:30, 20:50, 21:10 … 22:50 | Radar Collector (≤4 мин каждый) |
| 09:30, 13:00 и 20:20 | Сканирование основного бота |

### B4. Проверка
Отправьте боту `/status` (должна быть строка «⚔️ Радар демпинга: … лотов») и `/scan`. Пришлите:
- из execution `/scan` строки логов `[DOC_EXTRACT] …` (с «Достроено структур ТЗ»), `[PRE-FILTER V5.4] Индексировано …`,
  `[GEMINI INSPECTOR] …`, `[PARSE GEMINI] …`;
- текст дайджеста из Telegram (скриншот или копия).

Откат: деактивировать, импортировать `backup_tendersniper_<TS>.json` с тем же ID, активировать.

---

## Отчёт
```
РАДАР — ОТЧЁТ
1. git log -1: …
2. Тесты: радар …/13, основной …/32 (сырой вывод приложен)
3. Импорт Radar Collector: да/нет, timezone Asia/Almaty: да/нет
4. Ручной запуск: JSON вывода узла + строка [RADAR] (приложены)
5. Файл базы: размер …, lock снят: да/нет
6. Активирован: да/нет
7. Этап B: тесты 37/37 и 13/13, импорт с ID 3FFVZUREP8jZfilm да/нет, /status и /scan (логи + дайджест приложены)
```
