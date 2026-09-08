// Data export service for the Tutor Manager. Produces CSV (downloadable) and a
// print-ready HTML document for "save as PDF". Only operational data (teachers,
// class sessions, performance) is exported - never student PII.

function csvEscape(value) {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function toCsv(headers, rows) {
  const esc = csvEscape;
  const lines = [headers.map(esc).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => esc(row[h])).join(","));
  }
  return lines.join("\n");
}

export function csvBuffer(content) {
  // UTF-8 BOM for Excel compatibility
  return Buffer.from("\uFEFF" + content, "utf8");
}

// Simple print-friendly HTML used by the "Export PDF" action (browser print).
export function toPrintHtml({ title, subtitle, headers, rows }) {
  const esc = (v) => String(v === null || v === undefined ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows
    .map((r) => `<tr>${headers.map((h) => `<td>${esc(r[h])}</td>`).join("")}</tr>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(
    title
  )}</title><style>
    body{font-family:Arial,Helvetica,sans-serif;color:#1e293b;padding:24px}
    h1{font-size:20px;margin:0 0 4px}
    .sub{color:#64748b;font-size:12px;margin-bottom:18px}
    table{width:100%;border-collapse:collapse;font-size:12px}
    th{background:#7c3aed;color:#fff;text-align:left;padding:8px}
    td{border-bottom:1px solid #e2e8f0;padding:7px 8px}
  </style></head><body><h1>${esc(title)}</h1><p class="sub">${esc(
    subtitle
  )}</p><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}