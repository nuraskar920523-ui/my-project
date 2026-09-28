# Задание для CLI-агента: интеграция TenderSniper Lite v5.4 в рабочий n8n

> Скопируй этот файл агенту целиком. Он написан так, чтобы агент шёл по шагам, останавливался на контрольных
> точках и ничего не «улучшал» сам.

---

## Роль и жёсткие правила

Ты интегрируешь уже исправленный и протестированный workflow n8n **TenderSniper Lite (Алматы)** в рабочий сервер.
Код готов. Твоя задача: проверить окружение, сделать бэкап, заменить workflow, проверить работу и доложить.

**Запрещено:**
1. Менять логику, пороги, регулярки, промпты и тексты в `src/` и `dist/`. Если что-то кажется ошибкой, опиши это в отчёте, но не правь.
2. Редактировать `dist/TenderSniper_Lite_Almaty.json` вручную. Если правка всё же согласована с владельцем, она делается в `src/`, затем `python3 build.py`, затем тесты.
3. Переименовывать узлы: код обращается к ним по имени через `$('Имя узла')`.
4. Возвращать узел IF «Есть кандидаты для ИИ?», HTTP-узлы вместо Code-узлов или передавать токены и ключи через items.
5. Менять названия колонок Google Sheets и ID таблиц.
6. Запускать `test/run_tests.js` на рабочем сервере. Тест **удаляет** файлы в `/home/node/.n8n`. Только в одноразовом контейнере (шаг 3).
7. Удалять или перезаписывать `multi_catalog_cache.json`, `alstyle_catalog_cache.json`, `doc_cache/` и базу n8n.
8. Выводить значения `GOSZAKUP_TOKEN` и `GEMINI_API_KEY` в логи, отчёт или чат. Проверяй только их наличие.

**На каждой точке «⛔ СТОП» при несоответствии** прекращай работу и сообщи владельцу, что именно не так. Не обходи проблему.

---

## Что в пакете (папка `tendersniper/`)

| Путь | Назначение |
|---|---|
| `dist/TenderSniper_Lite_Almaty.json` | Готовый workflow для импорта |
| `original/TenderSniper_Lite_Almaty.original.json` | Прежняя версия (для сравнения) |
| `src/*.js`, `src/lib/*.js` | Исходники Code-узлов и общие библиотеки |
| `build.py` | Сборка `dist/` из `src/` с проверкой синтаксиса каждого узла |
| `test/run_tests.js` | 31 интеграционный тест на моках |
| `tools/check_goszakup_api.js` | Проверка API ЦЭФ (только чтение) |
| `tools/inspect_catalog.js` | Проверка формата и валюты каталога (только чтение) |
| `CHANGES.md` | Что и почему изменено |

Архитектура потока (22 узла, без ветвления после Pre-Filter):
```
Telegram Trigger / Schedule → Auth & Command Router → IF «Проверка доступа и команды»
  ├─ false → Send Direct / Auth Reply
  └─ true  → Generate IT Keywords → Fetch IT Lots from ЦЭФ (Code) → Merge & Deduplicate Lots
             → Fetch Lot History (Sheets) → Document Extraction Layer → Fetch Al-Style Catalog
             → Pre-Filter & Candidate Builder → Gemini AI Инспектор (Code) → Parse Gemini Verdict
             → Build Digest & Export Rows → Send Executive Digest
                                          → Are New Lots Found? → Prepare Rows → Save to Кандидаты
                                             → Prepare History IDs → Save to История → Log Sheets Final Result
```

---

## Шаг 0. Определи, как запущен n8n

Выполни и запиши в отчёт:
```bash
docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null | grep -i n8n || echo "n8n не в docker"
```
Дальше в командах `N8N` означает способ вызова CLI n8n:
- в docker: `docker exec -u node <имя_контейнера> n8n ...` (для shell: `docker exec -u node <имя_контейнера> sh -c '...'`);
- без docker: `n8n ...` от пользователя, под которым работает n8n.

Если есть отдельный контейнер task runner (`n8nio/runners` или `N8N_RUNNERS_MODE=external`), проверки из шага 1 делай **и в нём**: Code-узлы исполняются там.

---

## Шаг 1. Проверка окружения (только чтение)

### 1.1 Версия n8n
```bash
N8N --version
```
Нужна версия 1.x или новее (Code node v2).

### 1.2 Переменные окружения
Проверь только наличие, без вывода значений:
```bash
docker exec <контейнер> sh -c 'for v in GOSZAKUP_TOKEN GEMINI_API_KEY NODE_FUNCTION_ALLOW_BUILTIN N8N_BLOCK_ENV_ACCESS_IN_NODE N8N_RUNNERS_ENABLED N8N_RUNNERS_MODE N8N_RUNNERS_TASK_TIMEOUT GENERIC_TIMEZONE GEMINI_MODEL USD_KZT_RATE; do eval "x=\${$v}"; if [ -n "$x" ]; then case $v in *TOKEN*|*KEY*) echo "$v=<задано>";; *) echo "$v=$x";; esac; else echo "$v=<нет>"; fi; done'
```
Требования:
- `GOSZAKUP_TOKEN` и `GEMINI_API_KEY` заданы. **⛔ СТОП**, если нет.
- `NODE_FUNCTION_ALLOW_BUILTIN` содержит `fs`, `https` и `http` (или `*`). Нужны узлам Auth, Fetch IT Lots, Document Extraction, Pre-Filter, Gemini, Parse и Digest. Прежняя версия уже использовала `fs` и `https`, поэтому, скорее всего, всё настроено. Если `http` нет, а `fs,https` есть, **⛔ СТОП**: сообщи владельцу, что нужно добавить `http` и перезапустить n8n.
- Если `N8N_RUNNERS_ENABLED=true` и `N8N_RUNNERS_TASK_TIMEOUT` меньше 300 (или не задан при версии, где по умолчанию 60), сообщи владельцу: рекомендуется `N8N_RUNNERS_TASK_TIMEOUT=300`. Узлы рассчитаны на жёсткий лимит 250 с.

### 1.3 Каталог `/home/node/.n8n` доступен на запись там, где исполняются Code-узлы
```bash
docker exec -u node <контейнер> sh -c 'ls -la /home/node/.n8n/ | head -30; touch /home/node/.n8n/.ts_write_test && rm /home/node/.n8n/.ts_write_test && echo WRITE_OK'
```
Нужно `WRITE_OK` и наличие `multi_catalog_cache.json` или `alstyle_catalog_cache.json`. **⛔ СТОП**, если записи нет.
При внешнем task runner выполни то же в контейнере runner: каталог должен быть тем же томом.

### 1.4 API ЦЭФ: какой уровень запроса поддерживается
Скопируй `tools/check_goszakup_api.js` в контейнер и запусти (токен берётся из окружения контейнера):
```bash
docker cp tendersniper/tools/check_goszakup_api.js <контейнер>:/tmp/check_goszakup_api.js
docker exec -u node <контейнер> node /tmp/check_goszakup_api.js
docker exec <контейнер> rm /tmp/check_goszakup_api.js
```
Запиши в отчёт итоговый уровень и пример лота:
- `extended+paging`: идеально, будут дедлайны, ссылки на объявления и пагинация;
- `base+paging` или `base (v5.3)`: работать будет, но без дедлайнов (workflow откатится сам). Сообщи владельцу;
- HTTP 401/403 или «ни один уровень не принят»: **⛔ СТОП**.
- Если в выводе «ПАГИНАЦИЯ НЕ РАБОТАЕТ», **⛔ СТОП** и сообщи владельцу: иначе лоты будут дублироваться между страницами (дедуп их уберёт, но впустую потратятся запросы).
- Запиши формат `endDate` из примера. Ожидается `YYYY-MM-DD HH:MM:SS` (время Алматы) или ISO с зоной. Если формат другой, сообщи владельцу.

### 1.5 Каталог: формат и валюта
```bash
docker cp tendersniper/tools/inspect_catalog.js <контейнер>:/tmp/inspect_catalog.js
docker exec -u node <контейнер> node /tmp/inspect_catalog.js
docker exec <контейнер> rm /tmp/inspect_catalog.js
```
Проверь по выводу для каждого дистрибьютора:
- есть ценовой ключ с пометкой `(ПРИОРИТЕТ)` (дилерская или закупочная цена). Если есть только `(запасной)`, укажи в отчёте, какой ключ будет использоваться;
- **ASBIS**: цены в тенге? Сравни примеры с ценами Al-Style на похожие товары. Если цены явно в USD (ноутбук за 300–900), то:
  - если есть поле валюты со значением USD, попроси владельца задать `USD_KZT_RATE` в окружении n8n;
  - если поля валюты нет, **⛔ СТОП**: владелец должен решить, как исправить генератор кэша каталога.

---

## Шаг 2. Бэкап

```bash
N8N list:workflow | grep -i tender
```
Запиши ID рабочего workflow TenderSniper (далее `$WF_ID`). Если таких workflow несколько, **⛔ СТОП** и уточни у владельца, какой рабочий.

```bash
TS=$(date +%Y%m%d_%H%M%S)
docker exec -u node <контейнер> n8n export:workflow --id=$WF_ID --output=/home/node/.n8n/backup_tendersniper_$TS.json
docker cp <контейнер>:/home/node/.n8n/backup_tendersniper_$TS.json ./backup_tendersniper_$TS.json
ls -la ./backup_tendersniper_$TS.json
```
Файл должен существовать и не быть пустым. **⛔ СТОП**, если бэкап не создан.

---

## Шаг 3. Сборка и тесты (НЕ на рабочем n8n)

В папке `tendersniper/`:
```bash
python3 build.py
docker run --rm -e TS_TEST_SANDBOX=1 -v "$PWD":/w -w /w node:22 node test/run_tests.js
```
Ожидается `OK -> dist/TenderSniper_Lite_Almaty.json (22 узлов)` и `Итого: 32/32 тестов пройдено`.
Проверь, что `git status` не показывает изменений в `dist/`: собранный файл должен совпадать с закоммиченным.
**⛔ СТОП** при любом упавшем тесте или расхождении.

Docker недоступен: запускай тесты только на отдельной машине или в VM, где нет рабочего n8n. Тест сам откажется работать, если `/home/node/.n8n` не пуст.

---

## Шаг 4. Замена workflow с сохранением ID

Импорт с тем же ID сохраняет историю, привязку к Telegram-webhook и ссылки на workflow.

1. Деактивируй текущий workflow в UI n8n (переключатель Active → off) и запиши время.
2. Подготовь файл для импорта с ID рабочего workflow:
   ```bash
   jq --arg id "$WF_ID" '.id = $id | .active = false' dist/TenderSniper_Lite_Almaty.json > /tmp/ts_import.json
   docker cp /tmp/ts_import.json <контейнер>:/tmp/ts_import.json
   docker exec -u node <контейнер> n8n import:workflow --input=/tmp/ts_import.json
   docker exec <контейнер> rm /tmp/ts_import.json
   ```
3. Открой workflow в UI и проверь:
   - 22 узла, узла «Есть кандидаты для ИИ?» нет, «Fetch IT Lots from ЦЭФ» и «Gemini AI Инспектор» стали Code-узлами;
   - у узлов Telegram (Trigger, Send Direct, Send Executive Digest) выбран credential **TendersniperAlmatybot API**, у трёх Google Sheets **Google Service Account account**. Если credential не подхватился (красный узел), выбери его вручную из списка. Сами credentials не создавай и не меняй;
   - **Workflow Settings → Timezone = Asia/Almaty**;
   - нет красных узлов и предупреждений.
4. Активируй workflow в UI (Active → on). Активация через UI обязательна: так n8n перерегистрирует Telegram-webhook.

Если импорт с ID не сработал в твоей версии n8n: UI, в рабочем workflow Ctrl+A → Delete, затем меню «…» → **Import from File** → `dist/TenderSniper_Lite_Almaty.json`, затем Save. Проверки пункта 3 те же.

---

## Шаг 5. Проверка после активации

Попроси владельца отправить боту команды по очереди и проверь ответы и executions:

| Команда | Ожидается |
|---|---|
| `/help` | Справка с командами `/scan`, `/status`, `/unlock` и критериями «Маржа ≥ 15% … прибыль ≥ 30 000 ₸» |
| `/status` | «🔓 Сканирование не выполняется», счётчики реестра (0 при первом запуске) |
| `/scan` | Через 1–6 минут один дайджест (одно или несколько сообщений с нумерацией N/M) со сводкой в конце |
| `/scan` повторно во время сканирования | «⏳ Сканирование Алматы уже выполняется» |

В execution запуска `/scan` проверь логи узлов (Console):
- `Fetch IT Lots from ЦЭФ`: `[FETCH] Используется уровень запроса: …` совпадает с результатом шага 1.4;
- `Merge & Deduplicate Lots`: `[MERGE ALMATY SOLO] … Без объявления: … | Алматы: N` при N > 0;
- `Document Extraction Layer`: нет `GEMINI_API_KEY не найден`;
- `Pre-Filter & Candidate Builder`: `[PRE-FILTER V5.4] Индексировано: …` с товарами больше 1000;
- `Gemini AI Инспектор`: `Ошибок: 0` (или единицы). Если ошибки у всех лотов, смотри текст ошибки в `Parse Gemini Verdict`. Частая причина: неверное имя модели, тогда владелец задаёт `GEMINI_MODEL`;
- `Build Digest & Export Rows`: `[AUTH LOCK] Блокировка снята.`

После выполнения:
```bash
docker exec -u node <контейнер> sh -c 'ls -la /home/node/.n8n/tendersniper_* ; test -f /home/node/.n8n/tendersniper_scan.lock && echo "LOCK ОСТАЛСЯ" || echo "lock снят"'
```
Ожидается: `tendersniper_registry.json` есть, lock снят.
Если дайджест не пустой, в листах «Кандидаты Алматы» и «История лотов» появились строки.

Дождись одного запуска по расписанию (09:30 или 13:00 по Алматы) и проверь, что он стартовал **в это время по Алматы**.

**Критерии приёмки** (все пункты должны выполниться):
1. Ответы на `/help`, `/status` и `/scan` как в таблице.
2. На один `/scan` приходит ровно один дайджест. Больше нет лишнего сообщения «не найдено» после дайджеста.
3. Lock снят после выполнения, реестр создан.
4. Повторный `/scan` сразу после первого не присылает те же лоты и почти не вызывает Gemini (в логе `Gemini AI Инспектор`: `Лотов для ИИ: 0` или мало).
5. CRON срабатывает в 09:30 и 13:00 Asia/Almaty.

---

## Шаг 6. Откат (если критерии не выполнены или владелец попросил)

1. Деактивируй workflow в UI.
2. Импортируй бэкап с тем же ID:
   ```bash
   docker cp ./backup_tendersniper_<TS>.json <контейнер>:/tmp/ts_backup.json
   docker exec -u node <контейнер> n8n import:workflow --input=/tmp/ts_backup.json
   ```
3. Удали файлы новой версии (прежней версии они не нужны):
   ```bash
   docker exec -u node <контейнер> sh -c 'rm -f /home/node/.n8n/tendersniper_scan.lock /home/node/.n8n/tendersniper_registry.json /home/node/.n8n/tendersniper_registry.json.tmp'
   ```
4. Активируй workflow в UI и проверь `/help`.

---

## Шаг 7. Отчёт владельцу

Пришли отчёт строго в таком виде:
```
ИНТЕГРАЦИЯ TENDERSNIPER v5.4 — ОТЧЁТ
1. n8n: версия …, docker/без docker, task runner: да/нет (таймаут …)
2. Окружение: GOSZAKUP_TOKEN задан/нет, GEMINI_API_KEY задан/нет, NODE_FUNCTION_ALLOW_BUILTIN=…, запись в /home/node/.n8n: OK/нет
3. API ЦЭФ: уровень «…», пагинация работает/нет, формат endDate: «…», пример refTradeMethodsId: …
4. Каталог: строк …, дистрибьюторы …, ценовой ключ …, валюта ASBIS: KZT/USD/неясно
5. Бэкап: имя файла …
6. Сборка/тесты: 31/31 / ошибки: …
7. Импорт: ID …, credentials подхватились да/нет, timezone Asia/Almaty да/нет
8. Проверка: /help …, /status …, /scan — дайджест пришёл за … мин, лотов в выборке …, сводка: …
9. Логи: уровень запроса …, Алматы …, Индексировано …, ошибки Gemini …
10. Критерии приёмки: 1✅ 2✅ 3✅ 4✅ 5⏳/✅
11. Замечания и вопросы владельцу: …
```
