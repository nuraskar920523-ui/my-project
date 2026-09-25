const rows = $input.first()?.json?.rowsToExport || [];
return rows.map(r => ({ json: r }));