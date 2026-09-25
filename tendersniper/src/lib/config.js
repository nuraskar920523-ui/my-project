// ---------- TENDERSNIPER: ЕДИНАЯ КОНФИГУРАЦИЯ (вставляется сборщиком build.py) ----------
const TS_CONFIG = {
  ADMIN_CHAT_ID: 681740470,
  AUTHORIZED_USER_IDS: [681740470],
  N8N_DIR: '/home/node/.n8n',
  REGISTRY_PATH: '/home/node/.n8n/tendersniper_registry.json',
  LOCK_PATH: '/home/node/.n8n/tendersniper_scan.lock',
  LOCK_TIMEOUT_MS: 20 * 60 * 1000,
  CHECKED_TTL_DAYS: 7,
  SENT_TTL_DAYS: 120,
  GEMINI_MODEL_DEFAULT: 'gemini-3.8-flash',
  BID_DISCOUNT: 0.10,
  SNR_TAX_RATE: 0.03,
  DIGEST_MIN_MARGIN: 15,
  DIGEST_ALT_MIN_PROFIT: 30000,
  DIGEST_ALT_MIN_MARGIN: 5,
  MIN_LOT_BUDGET: 30000,
  MAX_LOT_BUDGET: 10000000,
  MIN_HOURS_TO_DEADLINE: 3,
  EXCLUDE_TRADE_METHOD_IDS: [],
  ALMATY_UTC_OFFSET: '+05:00'
};
