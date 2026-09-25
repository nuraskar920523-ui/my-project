// Безопасное чтение переменных окружения: $env может быть заблокирован (N8N_BLOCK_ENV_ACCESS_IN_NODE)
function tsGetEnv(name, fallback) {
  try { if (typeof $env !== 'undefined' && $env && $env[name]) return String($env[name]); } catch (e) {}
  try { if (typeof process !== 'undefined' && process.env && process.env[name]) return String(process.env[name]); } catch (e) {}
  return fallback === undefined ? '' : fallback;
}
