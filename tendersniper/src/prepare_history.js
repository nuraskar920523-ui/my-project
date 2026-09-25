const rows = $('Build Digest & Export Rows').first()?.json?.rowsToExport || [];
const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
return rows.map(r => ({ json: { 'Номер_Лота': r['Номер_Лота'], 'Дата_отправки': now } }));