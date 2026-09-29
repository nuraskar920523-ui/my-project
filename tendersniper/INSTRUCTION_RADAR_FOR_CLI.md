# Задание для CLI-агента: радар демпинга (v5.5)

> Правила из `INSTRUCTION_FOR_CLI.md` действуют полностью: ничего не менять в коде, на «⛔ СТОП» останавливаться,
> присылать **сырой** вывод. Свои тесты и скрипты не писать и не выдавать их за скрипты из репозитория.

Радар состоит из двух частей:

| Часть | Файл | Что делает |
|---|---|---|
| **Этап A.** Отдельный workflow «Radar Collector» | `dist/TenderSniper_Radar_Collector.json` | Ночью (01:10–06:10 по Алматы, раз в час) собирает итоги закупок Алматы: все участники, их цены, победители. База: `/home/node/.n8n/tendersniper_radar_db.json` |
| **Этап B.** Блок «⚔️ Риск демпинга» в дайджесте основного бота | изменения в `dist/TenderSniper_Lite_Almaty.json` | Читает базу радара и к каждому лоту пишет риск, частых соперников, ожидаемую цену победителя и безубыточную цену |

Этап A независим от основного бота, его можно ставить сразу: база копится несколько ночей.
Этап B **не импортировать**, пока разработчик не получит выгрузку текущего рабочего workflow (см. шаг B1).

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
- 3 узла: `Schedule (01:10–06:10 Almaty)`, `Manual Run`, `Radar Collector`;
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

## Этап B. Блок радара в дайджесте (только после выгрузки)

### B1. Выгрузка текущего рабочего workflow (обязательно)
На сервере сейчас работает версия основного бота с правками, которые вы вносили сами (матричная проверка ТЗ и другие).
Если импортировать `dist/TenderSniper_Lite_Almaty.json` поверх, эти правки **пропадут**. Поэтому:
```bash
docker exec -u node <контейнер> n8n export:workflow --id=<ID рабочего TenderSniper> --output=/tmp/ts_current.json
docker cp <контейнер>:/tmp/ts_current.json ./ts_current_export.json
docker exec <контейнер> rm /tmp/ts_current.json
```
Пришлите владельцу файл `ts_current_export.json` **без изменений**. Разработчик перенесёт ваши правки в исходники,
добавит к ним тесты, соберёт единую версию и выдаст отдельную инструкцию по импорту. До этого этап B не выполнять.

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
7. ts_current_export.json: приложен да/нет
```
