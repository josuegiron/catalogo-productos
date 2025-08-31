import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import * as XLSX from "xlsx";
import { FileDown, Trash2, Search, Settings, CheckCircle2, Plus, Camera, Upload, RefreshCw } from "lucide-react";

/**
 * ✅ FIX: Manejo robusto del Excel integrado
 * - El error venía de intentar leer "/Listado_de_productos_prueba.xlsx" cuando no está servido o la ruta no existe.
 * - Ahora:
 *   1) Probamos múltiples rutas candidatas (con y sin slash inicial, y relativas al <base href>).
 *   2) Mostramos un banner de error claro si falla y permitimos "Reintentar".
 *   3) Agregamos un cargador manual del Excel (subir archivo desde el teléfono) como fallback inmediato.
 *   4) Service Worker PWA no falla si el Excel no existe (usa add() con try/catch y addAll con Promise.allSettled).
 *   5) Tests mínimos en runtime (console) para el parser de encabezados y filas (no rompen la UI).
 */

// ---------- Utilidades comunes ----------
const normalize = (s: any) => (s ?? "").toString().trim();

function makePlaceholder(name: string, code?: string) {
  const text = (normalize(name) || "Producto").slice(0, 22);
  const canvas = document.createElement("canvas");
  canvas.width = 512; canvas.height = 320;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#eef"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#222"; ctx.font = "bold 28px sans-serif";
  ctx.fillText("FOTOGRAFÍA", 16, 40);
  ctx.font = "20px sans-serif";
  ctx.fillText(text, 16, 100);
  if (code) ctx.fillText(`Código: ${code}`, 16, 160);
  return canvas.toDataURL("image/png");
}

// ---------- Parser Excel ----------
function detectHeaderIndexes(rawHeaders: any[]) {
  const headers = rawHeaders.map((h) => normalize(h).toLowerCase());
  // Soportar "CODIGO ", "CÓDIGO", "codigo", etc.
  const idxCodigo = headers.findIndex((h) => /c[oó]digo\b/.test(h) || h === "codigo" || h === "codigo:" || h.startsWith("codigo"));
  const idxNombre = headers.findIndex((h) => h.includes("nombre") || h.includes("producto") || h.includes("medicamento") || h.includes("descrip"));
  return { idxCodigo, idxNombre };
}

function mapRowsFromSheet(sheet: XLSX.WorkSheet, defaultOption = "N/A") {
  const data = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1 });
  if (!data.length) return [] as any[];
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
  }));
}

// ---------- Tests mínimos (runtime, no bloqueantes) ----------
function runSelfTests() {
  try {
    // Test de detección de encabezados con variaciones típicas
    const headers1 = ["CODIGO ", "NOMBRE", "OTRO"]; // coincide con tu archivo de ejemplo
    const det1 = detectHeaderIndexes(headers1);
    console.assert(det1.idxCodigo === 0 && det1.idxNombre === 1, "TEST: encabezados básicos fallaron");

    const headers2 = ["código", "medicamento"]; // acentos y sinónimos
    const det2 = detectHeaderIndexes(headers2);
    console.assert(det2.idxCodigo === 0 && det2.idxNombre === 1, "TEST: encabezados acentuados fallaron");

    // Test de mapeo de filas
    const ws = XLSX.utils.aoa_to_sheet([
      ["CODIGO ", "NOMBRE"],
      ["A-1", "PARACETAMOL 500mg"],
      ["B-2", "IBUPROFENO 400mg"],
    ]);
    const mapped = mapRowsFromSheet(ws, "N/A");
    console.assert(mapped.length === 2 && mapped[0].codigo === "A-1" && mapped[0].nombre.includes("PARACETAMOL"), "TEST: mapeo de filas falló");
    console.info("✅ Tests de parser OK");
  } catch (err) {
    console.warn("⚠️ Tests de parser encontraron un problema", err);
  }
}

// ---------- Utilidades PWA ----------
function createIconDataURL(size = 192) {
  const c = document.createElement("canvas");
  c.width = c.height = size; const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#10b981"; ctx.fillRect(0,0,size,size);
  ctx.fillStyle = "#fff"; ctx.font = `${Math.floor(size*0.3)}px sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("RX", size/2, size/2);
  return c.toDataURL("image/png");
}

function usePWASetup() {
  useEffect(() => {
    // Manifest inyectado en caliente
    const icon192 = createIconDataURL(192);
    const icon512 = createIconDataURL(512);
    const manifest = {
      name: "Selección de Medicamentos",
      short_name: "Medic-Sel",
      start_url: "./",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#10b981",
      icons: [
        { src: icon192, sizes: "192x192", type: "image/png", purpose: "any maskable" },
        { src: icon512, sizes: "512x512", type: "image/png", purpose: "any maskable" }
      ]
    } as any;
    const blob = new Blob([JSON.stringify(manifest)], { type: "application/manifest+json" });
    const url = URL.createObjectURL(blob);
    let link = document.querySelector('link[rel="manifest"]');
    if (!link) { link = document.createElement("link"); link.setAttribute("rel", "manifest"); document.head.appendChild(link); }
    link.setAttribute("href", url);

    // Service Worker robusto (no falla si el Excel no existe)
    const swCode = `
      const PRECACHE = 'app-precache-v2';
      const EXCEL_FILE = 'Listado_de_productos_prueba.xlsx';

      async function safeAdd(cache, url) {
        try { await cache.add(url); } catch (e) { /* ignora si 404 o no está */ }
      }

      self.addEventListener('install', (e)=>{
        e.waitUntil((async()=>{
          const cache = await caches.open(PRECACHE);
          const scope = self.registration.scope || self.location.origin + '/';
          const candidates = [
            new URL(EXCEL_FILE, scope).toString(),
            './' + EXCEL_FILE,
            '/' + EXCEL_FILE,
          ];
          await Promise.allSettled(candidates.map(u => safeAdd(cache, u)));
          self.skipWaiting();
        })());
      });

      self.addEventListener('activate', (e)=>{
        e.waitUntil((async()=>{
          const keys = await caches.keys();
          await Promise.all(keys.filter(k=>k!==PRECACHE).map(k=>caches.delete(k)));
          self.clients.claim();
        })());
      });

      self.addEventListener('fetch', (e)=>{
        const reqUrl = new URL(e.request.url);
        const isExcel = reqUrl.pathname.endsWith('/' + EXCEL_FILE) || reqUrl.href.endsWith('/' + EXCEL_FILE) || reqUrl.pathname === '/' + EXCEL_FILE || reqUrl.pathname === EXCEL_FILE;
        if (isExcel) {
          // Network-first con fallback a cache
          e.respondWith((async()=>{
            const cache = await caches.open(PRECACHE);
            try {
              const net = await fetch(e.request);
              if (net && net.ok) cache.put(e.request, net.clone());
              return net;
            } catch (err) {
              const cached = await cache.match(e.request);
              if (cached) return cached;
              // pruebe otras keys por si la URL absoluta no coincide
              const keys = await cache.keys();
              for (const k of keys) { if (k.url.endsWith('/' + EXCEL_FILE)) { const c = await cache.match(k); if (c) return c; } }
              return Response.error();
            }
          })());
          return;
        }
        // App shell: cache-first básico
        e.respondWith((async()=>{
          const cache = await caches.open(PRECACHE);
          const cached = await cache.match(e.request);
          if (cached) return cached;
          try {
            const net = await fetch(e.request);
            if (net && net.ok && e.request.method === 'GET' && reqUrl.origin === location.origin) {
              cache.put(e.request, net.clone());
            }
            return net;
          } catch (err) {
            return cached || Response.error();
          }
        })());
      });
    `;
    const swBlob = new Blob([swCode], { type: "text/javascript" });
    const swURL = URL.createObjectURL(swBlob);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register(swURL).catch(console.error);
    }

    return () => { URL.revokeObjectURL(url); URL.revokeObjectURL(swURL); };
  }, []);
}

// ---------- Carga del Excel con estrategias y fallback ----------
// Obtiene todo el libro como XLSX desde Google Sheets
async function fetchExcelArrayBuffer(): Promise<ArrayBuffer | null> {
  const SHEET_ID = "1L6DSyixp9ejlx8QbNp6x2vMVno6W2m-E"; // <- reemplaza por el real
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`;

  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.arrayBuffer();
  } catch (e) {
    console.error("Error cargando Google Sheet como XLSX:", e);
    return null;
  }
}

// ---------- App ----------
export default function App() {
  const [products, setProducts] = useState<any[]>([]);
  const [query, setQuery] = useState("");
  const [onlySelected, setOnlySelected] = useState(false);
  const [options, setOptions] = useState(["N/A", "Unidad", "Caja", "Blister"]);
  const [newOption, setNewOption] = useState("");
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const [loadError, setLoadError] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);

  usePWASetup();

  // Instalable
  useEffect(()=>{
    const handler = (e: any) => { e.preventDefault(); setInstallPrompt(e); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  // Tests de parser (una sola vez)
  useEffect(() => { runSelfTests(); }, []);

  // Cargar Excel al iniciar (con rutas candidatas)
  const loadExcelFromServer = async () => {
    setLoadError("");
    try {
      const buf = await fetchExcelArrayBuffer();
      if (!buf) throw new Error("Archivo no encontrado en rutas candidatas");
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const mapped = mapRowsFromSheet(ws, options[0] || "N/A");
      if (!mapped.length) throw new Error("No se encontraron filas válidas (verifica encabezados 'CODIGO' y 'NOMBRE')");
      setProducts(mapped);
    } catch (e: any) {
      console.error("Error leyendo Excel integrado", e);
      setLoadError(`No se pudo leer el Excel integrado. Detalle: ${e?.message ?? e}`);
    }
  };

  useEffect(() => { loadExcelFromServer(); }, []);

  // Carga manual (fallback) desde archivo local
  const onExcelUpload = async (file?: File | null) => {
    try {
      if (!file) return;
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const mapped = mapRowsFromSheet(ws, options[0] || "N/A");
      if (!mapped.length) throw new Error("No se encontraron filas válidas en el archivo cargado.");
      setProducts(mapped);
      setLoadError("");
    } catch (e: any) {
      setLoadError(`Error leyendo el archivo cargado: ${e?.message ?? e}`);
    }
  };

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return products.filter((p) => {
      const hit = normalize(p.nombre).toLowerCase().includes(q) || normalize(p.codigo).toLowerCase().includes(q);
      const sel = !onlySelected || p.seleccionado || (p.qty && p.qty > 0);
      return hit && sel;
    });
  }, [products, query, onlySelected]);

  const exportExcel = () => {
    const rows = products
      .filter((p) => (p.qty && Number(p.qty) > 0) || p.seleccionado)
      .map((p) => ({ Codigo: p.codigo, Nombre: p.nombre, Cantidad: Number(p.qty || 0), Opcion: p.opcion }));
    if (!rows.length) {
      alert("No hay productos seleccionados ni con cantidad > 0.");
      return;
    }
    const ws = XLSX.utils.json_to_sheet(rows, { header: ["Codigo", "Nombre", "Cantidad", "Opcion"] });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Selección");
    XLSX.writeFile(wb, "seleccion_productos.xlsx");
  };

  const resetAll = () => {
    if (!confirm("¿Restablecer cantidades, opciones y selección?")) return;
    setProducts((prev) => prev.map((p) => ({ ...p, qty: 0, opcion: options[0] || "N/A", seleccionado: false })));
  };

  const addOption = () => {
    const val = normalize(newOption);
    if (!val) return;
    setOptions((prev) => (prev.includes(val) ? prev : [...prev, val]));
    setNewOption("");
  };

  const assignPhoto = (index: number, file?: File | null) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setProducts((prev) => prev.map((p, i) => (i === index ? { ...p, imagen: url } : p)));
  };

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 p-4 pb-28">
      <header className="max-w-6xl mx-auto flex items-center gap-2 mb-4">
        <h1 className="text-2xl font-bold">Selección de medicamentos (PWA)</h1>
        <div className="ml-auto flex gap-2">
          {installPrompt && (
            <button onClick={async()=>{ await installPrompt.prompt?.(); }} className="px-3 py-2 rounded-xl bg-neutral-900 text-white">
              Instalar app
            </button>
          )}
        </div>
      </header>

      {loadError && (
        <div className="max-w-6xl mx-auto mb-3 p-3 rounded-xl border border-red-300 bg-red-50 text-red-800 text-sm flex items-start gap-3">
          <div>⚠️ <b>No se pudo cargar el Excel integrado.</b><br/>
            {loadError}
            <div className="mt-2 text-neutral-700">
              Revisa que el archivo <code>Listado_de_productos_prueba.xlsx</code> esté en la carpeta pública del proyecto y sea accesible. También puedes cargarlo manualmente aquí abajo.
            </div>
          </div>
          <button onClick={loadExcelFromServer} className="ml-auto inline-flex items-center gap-2 px-3 py-2 rounded-lg border bg-white hover:bg-neutral-50">
            <RefreshCw size={16}/> Reintentar
          </button>
        </div>
      )}

      <div className="max-w-6xl mx-auto grid gap-3 md:grid-cols-3 mb-4">
        <div className="flex items-center gap-2 bg-white rounded-2xl p-3 shadow-sm">
          <button onClick={exportExcel} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-600 text-white hover:opacity-90">
            <FileDown size={18}/> Descargar Excel
          </button>
          <button onClick={resetAll} className="ml-auto inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white border hover:bg-neutral-50">
            <Trash2 size={18}/> Restablecer
          </button>
        </div>

        <div className="flex items-center gap-2 bg-white rounded-2xl p-3 shadow-sm">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-3" size={18}/>
            <input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Buscar por nombre o código" className="w-full pl-9 pr-3 py-2 rounded-xl border outline-none focus:ring-2 focus:ring-neutral-300"/>
          </div>
          <label className="flex items-center gap-2 select-none px-3 py-2 rounded-xl border bg-white">
            <input type="checkbox" checked={onlySelected} onChange={(e)=>setOnlySelected(e.target.checked)} />
            Solo seleccionados
          </label>
        </div>

        <div className="bg-white rounded-2xl p-3 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Settings size={18}/>
            <span className="font-medium">Opciones</span>
          </div>
          <div className="flex gap-2 flex-wrap mb-2">
            {options.map((op) => (
              <span key={op} className="px-2 py-1 rounded-full border text-sm">{op}</span>
            ))}
          </div>
          <div className="flex gap-2">
            <input value={newOption} onChange={(e)=>setNewOption(e.target.value)} placeholder="Agregar opción" className="flex-1 px-3 py-2 rounded-xl border"/>
            <button onClick={addOption} className="inline-flex items-center gap-1 px-3 py-2 rounded-xl border bg-white hover:bg-neutral-50"><Plus size={16}/> Agregar</button>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto mb-3">
        <div className="bg-white rounded-2xl p-3 shadow-sm flex items-center gap-3">
          <label className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border bg-white hover:bg-neutral-50 cursor-pointer">
            <Upload size={18}/> Cargar Excel manual
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e)=>onExcelUpload(e.target.files?.[0] || null)} />
          </label>
          <div className="text-sm text-neutral-600">Productos cargados: <b>{products.length}</b></div>
        </div>
      </div>

      <main className="max-w-6xl mx-auto grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((p, index) => (
          <motion.div key={p.codigo + index} whileHover={{ y: -2 }} className={`rounded-2xl p-3 shadow-sm bg-white border ${p.seleccionado || (p.qty && p.qty>0) ? 'border-emerald-400' : 'border-transparent'}`}>
            <div className="relative">
              <button
                className="w-full aspect-video overflow-hidden rounded-xl bg-neutral-100"
                onClick={() => setProducts(prev => prev.map((x,i)=> i===index ? { ...x, seleccionado: !x.seleccionado } : x))}
              >
                {p.imagen ? (
                  <img src={p.imagen} alt={p.nombre} className="w-full h-full object-cover"/>
                ) : (
                  <img src={makePlaceholder(p.nombre, p.codigo)} alt={p.nombre} className="w-full h-full object-cover"/>
                )}
              </button>
              {(p.seleccionado || (p.qty && p.qty>0)) && (
                <span className="absolute top-2 right-2 inline-flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-600 text-white text-xs"><CheckCircle2 size={14}/> Seleccionado</span>
              )}
              <label className="absolute bottom-2 right-2 inline-flex items-center gap-1 px-2 py-1 rounded-full bg-white/90 border text-xs cursor-pointer">
                <Camera size={14}/> Foto
                <input type="file" accept="image/*" className="hidden" onChange={(e)=>assignPhoto(index, e.target.files?.[0] || null)}/>
              </label>
            </div>

            <div className="mt-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm text-neutral-500">{p.codigo || "—"}</div>
                  <div className="font-semibold leading-tight">{p.nombre || "(Sin nombre)"}</div>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-neutral-500">Cantidad</label>
                  <input type="number" min={0} value={p.qty}
                    onChange={(e)=>{
                      const val = Number(e.target.value || 0);
                      setProducts(prev => prev.map((x,i)=> i===index ? { ...x, qty: val } : x));
                    }}
                    className="w-full mt-1 px-3 py-2 rounded-xl border"/>
                </div>
                <div>
                  <label className="text-xs text-neutral-500">Opción</label>
                  <select value={p.opcion} onChange={(e)=>setProducts(prev=>prev.map((x,i)=> i===index ? { ...x, opcion: e.target.value } : x))} className="w-full mt-1 px-3 py-2 rounded-xl border">
                    {options.map(op=> <option key={op} value={op}>{op}</option>)}
                  </select>
                </div>
              </div>
            </div>
          </motion.div>
        ))}
      </main>

      <footer className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur border-t">
        <div className="max-w-6xl mx-auto p-3 flex items-center gap-2">
          <button onClick={exportExcel} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-600 text-white">
            <FileDown size={18}/> Descargar Excel
          </button>
          <div className="ml-auto text-sm text-neutral-600">PWA offline • Excel integrado (si existe) o manual</div>
        </div>
      </footer>
    </div>
  );
}
