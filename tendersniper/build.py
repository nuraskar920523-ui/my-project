#!/usr/bin/env python3
"""Сборка исправленного workflow TenderSniper из original/*.json + src/*.js.

Код узлов лежит в src/, общие библиотеки в src/lib/ и вставляются строкой `//@@include:<name>`.
Результат: dist/TenderSniper_Lite_Almaty.json (импорт в n8n).
"""
import copy
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
LIB = SRC / "lib"
ORIGINAL = ROOT / "original" / "TenderSniper_Lite_Almaty.original.json"
DIST = ROOT / "dist" / "TenderSniper_Lite_Almaty.json"
RADAR_DIST = ROOT / "dist" / "TenderSniper_Radar_Collector.json"

CODE_NODES = {
    "Auth & Command Router": "auth.js",
    "Generate IT Keywords": "keywords.js",
    "Fetch IT Lots from ЦЭФ": "fetch_lots.js",
    "Merge & Deduplicate Lots": "merge.js",
    "Document Extraction Layer": "doc_extraction.js",
    "Fetch Al-Style Catalog": "catalog_status.js",
    "Pre-Filter & Candidate Builder": "prefilter.js",
    "Gemini AI Инспектор": "gemini_inspector.js",
    "Parse Gemini Verdict": "parse_verdict.js",
    "Build Digest & Export Rows": "digest.js",
    "Prepare Rows for Sheets": "prepare_rows.js",
    "Prepare History IDs": "prepare_history.js",
    "Log Sheets Final Result": "log_final.js",
}
# HTTP-узлы, которые становятся Code-узлами (имя и позиция сохраняются — ссылки $('...') не ломаются)
CONVERT_TO_CODE = {"Fetch IT Lots from ЦЭФ", "Gemini AI Инспектор"}
REMOVED_NODES = {"Есть кандидаты для ИИ?"}
INCLUDE_RE = re.compile(r"^//@@include:(\w+)\s*$", re.M)


def assemble(filename: str) -> str:
    code = (SRC / filename).read_text(encoding="utf-8")

    def repl(m):
        lib = LIB / f"{m.group(1)}.js"
        if not lib.exists():
            sys.exit(f"{filename}: нет библиотеки {lib}")
        return lib.read_text(encoding="utf-8").rstrip("\n")

    return INCLUDE_RE.sub(repl, code)


def syntax_check(name: str, code: str) -> None:
    # Code-узел n8n исполняется как тело async-функции (разрешены return и await на верхнем уровне)
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
        f.write("async function __n8nCodeNode() {\n" + code + "\n}\n")
        path = f.name
    res = subprocess.run(["node", "--check", path], capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"Синтаксическая ошибка в узле «{name}»:\n{res.stderr}")


def main() -> None:
    wf = json.loads(ORIGINAL.read_text(encoding="utf-8"))
    out = copy.deepcopy(wf)

    nodes = []
    for node in out["nodes"]:
        name = node["name"]
        if name in REMOVED_NODES:
            continue
        if name in CONVERT_TO_CODE:
            node = {
                "parameters": {},
                "id": node["id"],
                "name": name,
                "type": "n8n-nodes-base.code",
                "typeVersion": 2,
                "position": node["position"],
                "alwaysOutputData": True,
            }
        if name in CODE_NODES:
            code = assemble(CODE_NODES[name])
            syntax_check(name, code)
            node["parameters"] = {"jsCode": code}
        nodes.append(node)
    out["nodes"] = nodes

    conns = out["connections"]
    for removed in REMOVED_NODES:
        conns.pop(removed, None)
    # Линейный поток: Pre-Filter -> Gemini (Code) -> Parse -> Build Digest (один запуск)
    conns["Pre-Filter & Candidate Builder"] = {"main": [[{"node": "Gemini AI Инспектор", "type": "main", "index": 0}]]}
    # Ветка false «Are New Lots Found?» (продолжения дайджеста / нет находок) больше никуда не ведёт:
    # блокировка снимается в Build Digest, а Log Sheets логирует только реальную запись истории.
    conns["Are New Lots Found?"]["main"] = [conns["Are New Lots Found?"]["main"][0], []]

    names = {n["name"] for n in out["nodes"]}
    for src, c in conns.items():
        assert src in names, f"связь из несуществующего узла {src}"
        for branch in c["main"]:
            for link in branch:
                assert link["node"] in names, f"связь в несуществующий узел {link['node']}"

    out["settings"] = dict(out.get("settings") or {})
    out["settings"]["timezone"] = "Asia/Almaty"
    # Устаревшие static data (старое имя расписания и lastScanTime, замененный файловой блокировкой)
    sd = out.get("staticData") or {}
    out["staticData"] = {k: v for k, v in sd.items() if k.startswith("node:Schedule (09:30")} or None

    DIST.parent.mkdir(parents=True, exist_ok=True)
    DIST.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"OK -> {DIST.relative_to(ROOT)} ({len(out['nodes'])} узлов)")
    build_radar()


def build_radar() -> None:
    """Отдельный workflow сбора итогов закупок для радара демпинга."""
    code = assemble("radar_collector.js")
    syntax_check("Radar Collector", code)
    wf = {
        "name": "TenderSniper Radar Collector (Almaty)",
        "nodes": [
            {
                "parameters": {"rule": {"interval": [{"field": "cronExpression", "expression": "10 1-6 * * *"}]}},
                "id": "6f1c2a1e-9b0e-4d7e-a1f1-5a2c0d7e0b01",
                "name": "Schedule (01:10–06:10 Almaty)",
                "type": "n8n-nodes-base.scheduleTrigger",
                "typeVersion": 1.2,
                "position": [0, 0],
            },
            {
                "parameters": {},
                "id": "6f1c2a1e-9b0e-4d7e-a1f1-5a2c0d7e0b02",
                "name": "Manual Run",
                "type": "n8n-nodes-base.manualTrigger",
                "typeVersion": 1,
                "position": [0, 200],
            },
            {
                "parameters": {"jsCode": code},
                "id": "6f1c2a1e-9b0e-4d7e-a1f1-5a2c0d7e0b03",
                "name": "Radar Collector",
                "type": "n8n-nodes-base.code",
                "typeVersion": 2,
                "position": [260, 100],
                "alwaysOutputData": True,
            },
        ],
        "connections": {
            "Schedule (01:10–06:10 Almaty)": {"main": [[{"node": "Radar Collector", "type": "main", "index": 0}]]},
            "Manual Run": {"main": [[{"node": "Radar Collector", "type": "main", "index": 0}]]},
        },
        "active": False,
        "settings": {"executionOrder": "v1", "timezone": "Asia/Almaty"},
        "tags": [],
    }
    RADAR_DIST.write_text(json.dumps(wf, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"OK -> {RADAR_DIST.relative_to(ROOT)} ({len(wf['nodes'])} узла)")


if __name__ == "__main__":
    main()
