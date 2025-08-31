// src/parse.worker.js
import * as XLSX from "xlsx";

const normalize = (s) => (s ?? "").toString().trim();
function detectHeaderIndexes(rawHeaders) {
  const headers = rawHeaders.map((h) => normalize(h).toLowerCase());
  const idxCodigo = headers.findIndex((h) => /c[oó]digo\b/.test(h) || h === "codigo" || h === "codigo:" || h.startsWith("codigo"));
  const idxNombre = headers.findIndex((h) => h.includes("nombre") || h.includes("producto") || h.includes("medicamento") || h.includes("descrip"));
  return { idxCodigo, idxNombre };
}
function mapRowsFromSheet(sheet, defaultOption = "N/A") {
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  if (!data.length) return [];
  const headers = data[0];
  const { idxCodigo, idxNombre } = detectHeaderIndexes(headers);
  if (idxCodigo === -1 && idxNombre === -1) return [];
  const rows = data.slice(1).filter((r) => r && (r[idxCodigo] || r[idxNombre]));
  return rows.map((r) => ({
    codigo: normalize(idxCodigo > -1 ? r[idxCodigo] : ""),
    nombre: normalize(idxNombre > -1 ? r[idxNombre] : ""),
    imagen: "",
    qty: 0,
    opcion: defaultOption,
    seleccionado: false,
    _lcNombre: normalize(idxNombre > -1 ? r[idxNombre] : "").toLowerCase(),
    _lcCodigo: normalize(idxCodigo > -1 ? r[idxCodigo] : "").toLowerCase(),
  }));
}

self.onmessage = async (e) => {
  try {
    const { buf, isCsv, defaultOption } = e.data;
    const wb = isCsv
      ? XLSX.read(new TextDecoder().decode(buf), { type: "string" })
      : XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const mapped = mapRowsFromSheet(ws, defaultOption);
    self.postMessage({ ok: true, products: mapped });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.message || err) });
  }
};
