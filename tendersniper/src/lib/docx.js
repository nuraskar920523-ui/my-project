// Текст из .docx без внешних библиотек. Читает центральный каталог ZIP (размеры там верные даже когда
// генератор пишет нули в локальный заголовок и использует data descriptor), затем word/document.xml.
function tsDocxText(buffer) {
  const zlib = require('zlib');
  try {
    // Конец центрального каталога (EOCD): сигнатура 0x06054b50, ищем с конца (комментарий до 64 КБ)
    let eocd = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return '';
    const entries = buffer.readUInt16LE(eocd + 10);
    let p = buffer.readUInt32LE(eocd + 16);
    for (let n = 0; n < entries && p + 46 <= buffer.length; n++) {
      if (buffer.readUInt32LE(p) !== 0x02014b50) break;
      const method = buffer.readUInt16LE(p + 10);
      const compSize = buffer.readUInt32LE(p + 20);
      const nameLen = buffer.readUInt16LE(p + 28);
      const extraLen = buffer.readUInt16LE(p + 30);
      const commentLen = buffer.readUInt16LE(p + 32);
      const localOffset = buffer.readUInt32LE(p + 42);
      const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
      if (name === 'word/document.xml') {
        const lNameLen = buffer.readUInt16LE(localOffset + 26);
        const lExtraLen = buffer.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + lNameLen + lExtraLen;
        const data = buffer.subarray(start, start + compSize);
        const xml = method === 8 ? zlib.inflateRawSync(data).toString('utf8') : (method === 0 ? data.toString('utf8') : '');
        return xml
          .replace(/<w:tab\/?>/gi, '\t')
          .replace(/<\/w:tc>/gi, ' | ')
          .replace(/<\/w:p>/gi, '\n')
          .replace(/<w:br[^>]*\/>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
          .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
  } catch (e) {
    console.warn('[DOCX WARN] Ошибка разбора .docx: ' + e.message);
  }
  return '';
}

// Только русский текст (экономия токенов), но строки с цифрами/латиницей сохраняются даже при казахских буквах:
// в двуязычных таблицах ТТХ («Процессор / Процессор: Intel i5») там самые важные значения.
const TS_KZ_CHARS = /[әғқңөұүһіӘҒҚҢӨҰҮҺІ]/;
function tsRussianOnly(text) {
  if (!text) return '';
  const start = text.search(/техническая\s+спецификация|спецификация\s+товара/i);
  const raw = start > 200 ? text.substring(start) : text;
  return raw.split('\n')
    .filter(l => !TS_KZ_CHARS.test(l) || /[0-9]|[a-z]{2,}/i.test(l))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
