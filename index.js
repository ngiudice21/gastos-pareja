// src/App.js
import { useState, useEffect, useCallback } from "react";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
} from "firebase/auth";
import {
  doc, getDoc, setDoc, onSnapshot, collection,
  addDoc, deleteDoc, serverTimestamp, query, orderBy,
} from "firebase/firestore";
import { auth, db } from "./firebase";

// ── Catálogo completo de categorías ──────────────────────────
const CATALOGO = [
  { id: "super",       label: "Supermercado",     emoji: "🛒", color: "#6ee7b7", default: true  },
  { id: "servicios",   label: "Servicios",        emoji: "💡", color: "#93c5fd", default: true  },
  { id: "animales",    label: "Animales",         emoji: "🐾", color: "#fbbf24", default: true  },
  { id: "salud",       label: "Salud",            emoji: "💊", color: "#f87171", default: true  },
  { id: "ocio",        label: "Ocio",             emoji: "🎬", color: "#c084fc", default: true  },
  { id: "transporte",  label: "Transporte",       emoji: "🚌", color: "#fb923c", default: true  },
  { id: "restaurante", label: "Restaurante",      emoji: "🍽️", color: "#34d399", default: true  },
  { id: "otro",        label: "Otro",             emoji: "📦", color: "#94a3b8", default: true  },
  { id: "educacion",   label: "Educación",        emoji: "📚", color: "#60a5fa", default: false },
  { id: "alquiler",    label: "Alquiler",         emoji: "🏠", color: "#a78bfa", default: false },
  { id: "refacciones", label: "Refacciones Hogar",emoji: "🔧", color: "#f97316", default: false },
  { id: "ropa",        label: "Ropa",             emoji: "👕", color: "#ec4899", default: false },
  { id: "tecnologia",  label: "Tecnología",       emoji: "💻", color: "#38bdf8", default: false },
  { id: "viajes",      label: "Viajes",           emoji: "✈️", color: "#4ade80", default: false },
];

const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const fmt      = (n) => new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(n);
const hoyISO   = () => new Date().toISOString().slice(0, 10);
const mesKey   = (y, m) => `${y}-${String(m + 1).padStart(2, "0")}`;
const mesLabel = (y, m) => `${MESES[m]} ${y}`;

const DEFAULT_CONFIG = {
  modoProp: "porcentual",
  propManual: 50,
  categoriasActivas: CATALOGO.filter(c => c.default).map(c => c.id),
  nombres: { p1: "Persona 1", p2: "Persona 2" },
};

// Obtiene ingreso vigente para persona/mes dado historial (array de {persona, mesKey, monto})
function ingresoVigente(hist, persona, year, month) {
  const mk = mesKey(year, month);
  const delMes = hist.filter(e => e.persona === persona && e.mesKey === mk);
  if (delMes.length > 0) return delMes.reduce((s, e) => s + e.monto, 0);
  const anteriores = hist.filter(e => e.persona === persona && e.mesKey < mk).sort((a, b) => b.mesKey.localeCompare(a.mesKey));
  if (!anteriores.length) return 0;
  const mkPrev = anteriores[0].mesKey;
  return hist.filter(e => e.persona === persona && e.mesKey === mkPrev).reduce((s, e) => s + e.monto, 0);
}

// ── Gráfico de torta SVG ──────────────────────────────────────
function PieChart({ data, size = 155 }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (!total) return null;
  const r = size / 2 - 10, cx = size / 2, cy = size / 2;
  let angle = -Math.PI / 2;
  const slices = data.map(d => {
    const sweep = (d.value / total) * 2 * Math.PI;
    const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
    angle += sweep;
    return { ...d, x1, y1, x2: cx + r * Math.cos(angle), y2: cy + r * Math.sin(angle), large: sweep > Math.PI ? 1 : 0, sweep };
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {slices.filter(s => s.sweep > 0.01).map((s, i) => (
        <path key={i} d={`M${cx},${cy} L${s.x1},${s.y1} A${r},${r} 0 ${s.large},1 ${s.x2},${s.y2} Z`} fill={s.color} stroke="#0f1923" strokeWidth={2} />
      ))}
      <circle cx={cx} cy={cy} r={r * 0.45} fill="#0f1923" />
    </svg>
  );
}

const now0 = new Date();

export default function App() {
  // ── Auth ──────────────────────────────────────────────────
  const [user,       setUser]       = useState(undefined); // undefined=cargando, null=no auth
  const [authVista,  setAuthVista]  = useState("login");
  const [authForm,   setAuthForm]   = useState({ nombre: "", email: "", pass: "", pass2: "" });
  const [authError,  setAuthError]  = useState("");
  const [authLoad,   setAuthLoad]   = useState(false);

  // ── Datos compartidos (Firestore) ─────────────────────────
  const [gastos,       setGastos]       = useState([]);
  const [ingresos,     setIngresos]     = useState([]);
  const [config,       setConfig_]      = useState(DEFAULT_CONFIG);
  const [dataLoad,     setDataLoad]     = useState(true);

  // ── UI ────────────────────────────────────────────────────
  const [vista,        setVista]        = useState("dashboard");
  const [toast,        setToast]        = useState(null);
  const [confirmDel,   setConfirmDel]   = useState(null);
  const [ajusteTab,    setAjusteTab]    = useState("general");
  const [mesSel,       setMesSel]       = useState({ year: now0.getFullYear(), month: now0.getMonth() });
  const [anioSel,      setAnioSel]      = useState(now0.getFullYear());
  const [filtroCat,    setFiltroCat]    = useState("todas");
  const [filtroPer,    setFiltroPer]    = useState("todas");
  const [form,         setForm]         = useState({ descripcion: "", monto: "", categoria: "super", pagadoPor: "p1", fecha: hoyISO() });
  const [formIng,      setFormIng]      = useState({ persona: "p1", concepto: "", monto: "", year: now0.getFullYear(), month: now0.getMonth() });
  const [editNombres,  setEditNombres]  = useState({ p1: "", p2: "" });

  // ── Auth listener ─────────────────────────────────────────
  useEffect(() => onAuthStateChanged(auth, u => setUser(u ?? null)), []);

  // ── Firestore listeners (solo cuando hay sesión) ──────────
  useEffect(() => {
    if (!user) { setDataLoad(false); return; }
    setDataLoad(true);
    const PROJECT = "shared"; // todos comparten el mismo documento de proyecto

    // Config (documento único compartido)
    const unsubConfig = onSnapshot(doc(db, "config", PROJECT), snap => {
      if (snap.exists()) setConfig_({ ...DEFAULT_CONFIG, ...snap.data() });
    });

    // Gastos (colección)
    const unsubGastos = onSnapshot(
      query(collection(db, "gastos"), orderBy("fecha", "desc")),
      snap => setGastos(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );

    // Ingresos (colección)
    const unsubIngresos = onSnapshot(
      query(collection(db, "ingresos"), orderBy("mesKey", "desc")),
      snap => setIngresos(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );

    setDataLoad(false);
    return () => { unsubConfig(); unsubGastos(); unsubIngresos(); };
  }, [user]);

  // ── Helpers ───────────────────────────────────────────────
  const toast_ = (msg, tipo = "ok") => { setToast({ msg, tipo }); setTimeout(() => setToast(null), 2800); };

  const saveConfig = useCallback(async (updates) => {
    const next = { ...config, ...updates };
    setConfig_(next);
    await setDoc(doc(db, "config", "shared"), next, { merge: true });
  }, [config]);

  // ── Auth actions ──────────────────────────────────────────
  const registrar = async () => {
    setAuthError("");
    if (!authForm.nombre.trim())        { setAuthError("Ingresá tu nombre"); return; }
    if (!authForm.email.includes("@"))  { setAuthError("Email inválido"); return; }
    if (authForm.pass.length < 6)       { setAuthError("La contraseña debe tener al menos 6 caracteres"); return; }
    if (authForm.pass !== authForm.pass2){ setAuthError("Las contraseñas no coinciden"); return; }
    setAuthLoad(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, authForm.email.trim(), authForm.pass);
      await updateProfile(cred.user, { displayName: authForm.nombre.trim() });
    } catch (e) {
      const msgs = { "auth/email-already-in-use": "Ese email ya está registrado.", "auth/invalid-email": "Email inválido." };
      setAuthError(msgs[e.code] || "Error al registrarse. Intentá de nuevo.");
    }
    setAuthLoad(false);
  };

  const login = async () => {
    setAuthError("");
    setAuthLoad(true);
    try {
      await signInWithEmailAndPassword(auth, authForm.email.trim(), authForm.pass);
    } catch (e) {
      setAuthError("Email o contraseña incorrectos.");
    }
    setAuthLoad(false);
  };

  const logout = () => signOut(auth);

  // ── CRUD Gastos ───────────────────────────────────────────
  const agregarGasto = async () => {
    if (!form.descripcion.trim() || !form.monto || isNaN(+form.monto) || +form.monto <= 0 || !form.fecha) {
      toast_("Completá todos los campos", "error"); return;
    }
    await addDoc(collection(db, "gastos"), {
      descripcion: form.descripcion.trim(),
      monto: parseFloat(form.monto),
      categoria: form.categoria,
      pagadoPor: form.pagadoPor,
      fecha: form.fecha,
      creadoPor: user.displayName,
      ts: serverTimestamp(),
    });
    setForm({ descripcion: "", monto: "", categoria: catActivas[0]?.id || "otro", pagadoPor: "p1", fecha: hoyISO() });
    toast_("Gasto agregado ✓"); setVista("dashboard");
  };

  const eliminarGasto = async (id) => {
    await deleteDoc(doc(db, "gastos", id));
    toast_("Gasto eliminado");
  };

  // ── CRUD Ingresos ─────────────────────────────────────────
  const agregarIngreso = async () => {
    if (!formIng.monto || isNaN(+formIng.monto) || +formIng.monto <= 0) {
      toast_("Ingresá un monto válido", "error"); return;
    }
    await addDoc(collection(db, "ingresos"), {
      persona: formIng.persona,
      concepto: formIng.concepto.trim() || "Ingreso",
      mesKey: mesKey(formIng.year, formIng.month),
      monto: parseFloat(formIng.monto),
      ts: serverTimestamp(),
    });
    setFormIng(f => ({ ...f, concepto: "", monto: "" }));
    toast_("Ingreso agregado ✓");
  };

  const eliminarIngreso = async (id) => {
    await deleteDoc(doc(db, "ingresos", id));
    toast_("Ingreso eliminado");
  };

  // ── Nombres ───────────────────────────────────────────────
  const guardarNombres = async () => {
    const n = { p1: editNombres.p1.trim() || config.nombres.p1, p2: editNombres.p2.trim() || config.nombres.p2 };
    await saveConfig({ nombres: n });
    setEditNombres({ p1: "", p2: "" });
    toast_("Nombres guardados ✓");
  };

  // ── Proporciones ──────────────────────────────────────────
  const propMes = (year, month) => {
    if (config.modoProp === "manual") {
      const p = config.propManual / 100;
      return { i1: 0, i2: 0, pct1: p, pct2: 1 - p, sinDatos: false, esManual: true };
    }
    const i1 = ingresoVigente(ingresos, "p1", year, month);
    const i2 = ingresoVigente(ingresos, "p2", year, month);
    const tot = i1 + i2;
    return { i1, i2, pct1: tot > 0 ? i1 / tot : 0.5, pct2: tot > 0 ? i2 / tot : 0.5, sinDatos: tot === 0, esManual: false };
  };

  const nombres    = config.nombres;
  const catActivas = CATALOGO.filter(c => config.categoriasActivas.includes(c.id));
  const toggleCat  = (id) => saveConfig({ categoriasActivas: config.categoriasActivas.includes(id) ? config.categoriasActivas.filter(x => x !== id) : [...config.categoriasActivas, id] });

  const { i1: ingAct1, i2: ingAct2, pct1: pctAct1, pct2: pctAct2, sinDatos: sinIngAct, esManual: esManualAct } = propMes(now0.getFullYear(), now0.getMonth());

  // ── Cálculos ──────────────────────────────────────────────
  const totalP1g = gastos.filter(g => g.pagadoPor === "p1").reduce((s, g) => s + g.monto, 0);
  const totalP2g = gastos.filter(g => g.pagadoPor === "p2").reduce((s, g) => s + g.monto, 0);
  const totalG   = totalP1g + totalP2g;
  const saldoGP1 = totalP1g - totalG * pctAct1;

  const { pct1: pctM1, pct2: pctM2, sinDatos: sinIngMes } = propMes(mesSel.year, mesSel.month);
  const gastosMes  = gastos.filter(g => { const d = new Date(g.fecha + "T12:00:00"); return d.getFullYear() === mesSel.year && d.getMonth() === mesSel.month; });
  const totalMesP1 = gastosMes.filter(g => g.pagadoPor === "p1").reduce((s, g) => s + g.monto, 0);
  const totalMesP2 = gastosMes.filter(g => g.pagadoPor === "p2").reduce((s, g) => s + g.monto, 0);
  const totalMes   = totalMesP1 + totalMesP2;
  const saldoMesP1 = totalMesP1 - totalMes * pctM1;
  const porCatMes  = catActivas.map(c => ({ ...c, total: gastosMes.filter(g => g.categoria === c.id).reduce((s, g) => s + g.monto, 0) })).filter(c => c.total > 0).sort((a, b) => b.total - a.total);

  const gastosAnio = gastos.filter(g => new Date(g.fecha + "T12:00:00").getFullYear() === anioSel);
  const totalAnio  = gastosAnio.reduce((s, g) => s + g.monto, 0);
  const porCatAnio = catActivas.map(c => ({ ...c, total: gastosAnio.filter(g => g.categoria === c.id).reduce((s, g) => s + g.monto, 0) })).filter(c => c.total > 0).sort((a, b) => b.total - a.total);
  const maxCatAnio = Math.max(...porCatAnio.map(c => c.total), 1);
  const gastosPorMes = Array.from({ length: 12 }, (_, m) => ({ m, label: MESES[m].slice(0, 3), total: gastosAnio.filter(g => new Date(g.fecha + "T12:00:00").getMonth() === m).reduce((s, g) => s + g.monto, 0) }));
  const maxMesAnio = Math.max(...gastosPorMes.map(x => x.total), 1);
  const gastosFilt = gastos.filter(g => (filtroCat === "todas" || g.categoria === filtroCat) && (filtroPer === "todas" || g.pagadoPor === filtroPer));
  const mksTodos   = [...new Set(ingresos.map(e => e.mesKey))].sort((a, b) => b.localeCompare(a));
  const yearsOpts  = Array.from({ length: 5 }, (_, i) => now0.getFullYear() - 2 + i);

  const formatFecha = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "2-digit" });
  const prevMes = () => setMesSel(m => m.month === 0  ? { year: m.year - 1, month: 11 } : { ...m, month: m.month - 1 });
  const nextMes = () => setMesSel(m => m.month === 11 ? { year: m.year + 1, month: 0  } : { ...m, month: m.month + 1 });

  // ── Estilos ───────────────────────────────────────────────
  const S = {
    app:    { background: "#0f1923", minHeight: "100vh", fontFamily: "-apple-system, 'Inter', sans-serif", color: "#e2e8f0", maxWidth: 480, margin: "0 auto", paddingBottom: 84 },
    center: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: "0 24px" },
    header: { background: "#162030", padding: "14px 20px 12px", borderBottom: "1px solid #1e3a52", position: "sticky", top: 0, zIndex: 50 },
    nav:    { position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 480, background: "#162030", borderTop: "1px solid #1e3a52", display: "flex", zIndex: 100 },
    navBtn: (a) => ({ flex: 1, padding: "8px 2px 10px", background: "none", border: "none", color: a ? "#6ee7b7" : "#64a6c8", fontSize: 9, fontWeight: a ? 700 : 400, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }),
    sec:    { padding: "14px 16px 0" },
    card:   { background: "#162030", borderRadius: 12, padding: 16, marginBottom: 12, border: "1px solid #1e3a52" },
    lbl:    { fontSize: 11, color: "#64a6c8", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6, display: "block" },
    input:  { width: "100%", background: "#0f1923", border: "1px solid #1e3a52", borderRadius: 8, padding: "10px 12px", color: "#e2e8f0", fontSize: 15, outline: "none", boxSizing: "border-box" },
    sel:    { width: "100%", background: "#0f1923", border: "1px solid #1e3a52", borderRadius: 8, padding: "10px 12px", color: "#e2e8f0", fontSize: 15, outline: "none", boxSizing: "border-box", appearance: "none" },
    btn:    { width: "100%", background: "#6ee7b7", color: "#0f1923", border: "none", borderRadius: 8, padding: "13px 16px", fontWeight: 700, fontSize: 16, cursor: "pointer", opacity: authLoad ? 0.6 : 1 },
    btnSec: { width: "100%", background: "transparent", color: "#6ee7b7", border: "1px solid #6ee7b7", borderRadius: 8, padding: "11px 16px", fontWeight: 600, fontSize: 14, cursor: "pointer" },
    row:    { display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "1px solid #1e3a5233" },
    emoji:  { fontSize: 20, width: 36, height: 36, background: "#0f1923", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
    toast:  (t) => ({ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", background: t === "error" ? "#7f1d1d" : "#064e3b", color: t === "error" ? "#fca5a5" : "#6ee7b7", padding: "10px 20px", borderRadius: 8, fontSize: 14, fontWeight: 600, zIndex: 300, whiteSpace: "nowrap", border: `1px solid ${t === "error" ? "#f87171" : "#6ee7b7"}44`, boxShadow: "0 4px 20px #0008" }),
  };

  const BalanceChip = ({ saldo, n1, n2 }) => {
    if (Math.abs(saldo) < 1) return (
      <div style={{ background: "#0d2d1f", border: "1px solid #6ee7b733", borderRadius: 10, padding: "12px 14px", marginBottom: 12 }}>
        <div style={{ color: "#6ee7b7", fontWeight: 600, fontSize: 14 }}>✓ Están al día</div>
        <div style={{ color: "#64a6c8", fontSize: 12, marginTop: 2 }}>Cada uno aportó según su proporción</div>
      </div>
    );
    const [deudor, acreedor, monto] = saldo < 0 ? [n1, n2, -saldo] : [n2, n1, saldo];
    return (
      <div style={{ background: "#2d1010", border: "1px solid #f8717133", borderRadius: 10, padding: "12px 14px", marginBottom: 12 }}>
        <div style={{ color: "#f87171", fontWeight: 600, fontSize: 14 }}>{deudor} le debe {fmt(monto)} a {acreedor}</div>
        <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 2 }}>Para equilibrar los aportes proporcionales</div>
      </div>
    );
  };

  const PropBar = ({ pct1, n1, n2, i1, i2, esManual }) => (
    <div>
      <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", height: 26, marginBottom: 8 }}>
        <div style={{ width: `${pct1 * 100}%`, background: "#6ee7b7", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: "#0f1923", minWidth: pct1 > 0 ? 30 : 0 }}>{Math.round(pct1 * 100)}%</div>
        <div style={{ flex: 1, background: "#93c5fd", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: "#0f1923" }}>{Math.round((1 - pct1) * 100)}%</div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#94a3b8" }}>
        <span><span style={{ color: "#6ee7b7" }}>●</span> {n1}{!esManual && i1 > 0 ? `: ${fmt(i1)}` : ""}</span>
        <span><span style={{ color: "#93c5fd" }}>●</span> {n2}{!esManual && i2 > 0 ? `: ${fmt(i2)}` : ""}</span>
      </div>
    </div>
  );

  // ── LOADING ───────────────────────────────────────────────
  if (user === undefined) return (
    <div style={{ ...S.app, ...S.center }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>💰</div>
      <div style={{ color: "#6ee7b7", fontSize: 15 }}>Cargando...</div>
    </div>
  );

  // ── AUTH SCREENS ──────────────────────────────────────────
  if (!user) {
    const esRegistro = authVista === "registro";
    return (
      <div style={{ ...S.app, ...S.center }}>
        <div style={{ fontSize: 44, marginBottom: 12 }}>💰</div>
        <div style={{ fontSize: 22, fontWeight: 800, color: "#fff", marginBottom: 4 }}>Gastos compartidos</div>
        <div style={{ fontSize: 14, color: "#64a6c8", marginBottom: 28 }}>{esRegistro ? "Creá tu cuenta" : "Iniciá sesión"}</div>
        <div style={{ width: "100%", maxWidth: 340 }}>
          {esRegistro && (
            <div style={{ marginBottom: 14 }}>
              <span style={S.lbl}>Tu nombre</span>
              <input style={S.input} placeholder="Ej: Nico" value={authForm.nombre} onChange={e => setAuthForm({ ...authForm, nombre: e.target.value })} />
            </div>
          )}
          <div style={{ marginBottom: 14 }}>
            <span style={S.lbl}>Email</span>
            <input style={S.input} type="email" placeholder="tu@email.com" value={authForm.email} onChange={e => setAuthForm({ ...authForm, email: e.target.value })} />
          </div>
          <div style={{ marginBottom: esRegistro ? 14 : 24 }}>
            <span style={S.lbl}>Contraseña</span>
            <input style={S.input} type="password" placeholder="Mínimo 6 caracteres" value={authForm.pass} onChange={e => setAuthForm({ ...authForm, pass: e.target.value })} onKeyDown={e => e.key === "Enter" && !esRegistro && login()} />
          </div>
          {esRegistro && (
            <div style={{ marginBottom: 24 }}>
              <span style={S.lbl}>Confirmá la contraseña</span>
              <input style={S.input} type="password" placeholder="••••••" value={authForm.pass2} onChange={e => setAuthForm({ ...authForm, pass2: e.target.value })} onKeyDown={e => e.key === "Enter" && registrar()} />
            </div>
          )}
          {authError && <div style={{ background: "#7f1d1d", color: "#fca5a5", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 14 }}>{authError}</div>}
          <button style={S.btn} onClick={esRegistro ? registrar : login} disabled={authLoad}>
            {authLoad ? "..." : esRegistro ? "Crear cuenta" : "Ingresar"}
          </button>
          <div style={{ textAlign: "center", marginTop: 18 }}>
            <button style={{ background: "none", border: "none", color: "#64a6c8", fontSize: 13, cursor: "pointer" }}
              onClick={() => { setAuthVista(esRegistro ? "login" : "registro"); setAuthError(""); }}>
              {esRegistro ? "¿Ya tenés cuenta? Iniciá sesión" : "¿Primera vez? Creá una cuenta"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── APP PRINCIPAL ─────────────────────────────────────────
  return (
    <div style={S.app}>
      {toast && <div style={S.toast(toast.tipo)}>{toast.msg}</div>}

      {confirmDel && (
        <div style={{ position: "fixed", inset: 0, background: "#000c", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#162030", border: "1px solid #1e3a52", borderRadius: 14, padding: 24, width: 300, textAlign: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>¿Eliminar?</div>
            <div style={{ color: "#94a3b8", fontSize: 13, marginBottom: 20 }}>Esta acción no se puede deshacer.</div>
            <div style={{ display: "flex", gap: 10 }}>
              <button style={{ ...S.btnSec, flex: 1 }} onClick={() => setConfirmDel(null)}>Cancelar</button>
              <button style={{ flex: 1, background: "#7f1d1d", color: "#fca5a5", border: "none", borderRadius: 8, padding: 11, fontWeight: 700, fontSize: 14, cursor: "pointer" }}
                onClick={async () => {
                  if (confirmDel.tipo === "gasto")   await eliminarGasto(confirmDel.id);
                  if (confirmDel.tipo === "ingreso") await eliminarIngreso(confirmDel.id);
                  setConfirmDel(null);
                }}>Eliminar</button>
            </div>
          </div>
        </div>
      )}

      {/* HEADER */}
      <div style={S.header}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#fff" }}>💰 Gastos compartidos</div>
            <div style={{ fontSize: 11, color: "#64a6c8", marginTop: 1 }}>
              {nombres.p1} & {nombres.p2}
              {(!sinIngAct || esManualAct) && <span style={{ marginLeft: 8, color: "#6ee7b7" }}>{Math.round(pctAct1 * 100)}% / {Math.round(pctAct2 * 100)}%</span>}
            </div>
          </div>
          <button onClick={logout} style={{ background: "none", border: "1px solid #1e3a52", borderRadius: 8, color: "#64a6c8", fontSize: 11, padding: "6px 10px", cursor: "pointer" }}>
            {user.displayName} ↩
          </button>
        </div>
      </div>

      {/* ════ DASHBOARD ════ */}
      {vista === "dashboard" && (
        <div style={S.sec}>
          {sinIngAct && !esManualAct && (
            <div style={{ background: "#1e2d3d", border: "1px dashed #1e3a52", borderRadius: 10, padding: "12px 14px", marginTop: 14, marginBottom: 4, fontSize: 13, color: "#64a6c8" }}>
              💡 Cargá ingresos en <b style={{ color: "#fff" }}>Ingresos</b> o configurá la proporción manual en <b style={{ color: "#fff" }}>Ajustes</b>.
            </div>
          )}
          {(!sinIngAct || esManualAct) && (
            <div style={{ ...S.card, marginTop: 14 }}>
              <span style={S.lbl}>Proporción {esManualAct ? "manual" : `${MESES[now0.getMonth()]} ${now0.getFullYear()}`}</span>
              <PropBar pct1={pctAct1} n1={nombres.p1} n2={nombres.p2} i1={ingAct1} i2={ingAct2} esManual={esManualAct} />
            </div>
          )}
          <div style={{ display: "flex", gap: 10, marginTop: 12, marginBottom: 12 }}>
            {[{ id: "p1", nombre: nombres.p1, total: totalP1g, deberia: totalG * pctAct1, color: "#6ee7b7" },
              { id: "p2", nombre: nombres.p2, total: totalP2g, deberia: totalG * pctAct2, color: "#93c5fd" }].map(p => (
              <div key={p.id} style={{ flex: 1, background: "#162030", borderRadius: 12, padding: "12px 14px", border: `1px solid ${p.color}22` }}>
                <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 4 }}>{p.nombre}</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: p.color }}>{fmt(p.total)}</div>
                <div style={{ fontSize: 11, color: "#475569", marginTop: 3 }}>Debería: {fmt(p.deberia)}</div>
              </div>
            ))}
          </div>
          <BalanceChip saldo={saldoGP1} n1={nombres.p1} n2={nombres.p2} />
          <div style={S.card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div><span style={S.lbl}>Total acumulado</span><div style={{ fontSize: 30, fontWeight: 800, color: "#fff", lineHeight: 1 }}>{fmt(totalG)}</div></div>
              {gastos[0] && (<div style={{ textAlign: "right" }}><span style={S.lbl}>Último</span><div style={{ fontSize: 13, fontWeight: 600 }}>{gastos[0].descripcion}</div><div style={{ fontSize: 12, color: "#64a6c8" }}>{fmt(gastos[0].monto)} · {formatFecha(gastos[0].fecha)}</div></div>)}
            </div>
          </div>
          {gastos.length === 0 && <div style={{ textAlign: "center", padding: "48px 0", color: "#64a6c8" }}><div style={{ fontSize: 40, marginBottom: 10 }}>🧾</div><div style={{ fontSize: 15, fontWeight: 600, color: "#94a3b8", marginBottom: 4 }}>Sin gastos todavía</div><div style={{ fontSize: 13 }}>Tocá ➕ para agregar el primero</div></div>}
        </div>
      )}

      {/* ════ ANUAL ════ */}
      {vista === "anual" && (
        <div style={S.sec}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14, marginBottom: 14 }}>
            <button onClick={() => setAnioSel(a => a - 1)} style={{ background: "#162030", border: "1px solid #1e3a52", borderRadius: 8, color: "#6ee7b7", fontSize: 22, width: 40, height: 40, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>‹</button>
            <div style={{ textAlign: "center" }}><div style={{ fontSize: 22, fontWeight: 800, color: "#fff" }}>{anioSel}</div><div style={{ fontSize: 12, color: "#64a6c8" }}>{gastosAnio.length} gastos</div></div>
            <button onClick={() => setAnioSel(a => a + 1)} style={{ background: "#162030", border: "1px solid #1e3a52", borderRadius: 8, color: "#6ee7b7", fontSize: 22, width: 40, height: 40, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>›</button>
          </div>
          {gastosAnio.length === 0
            ? <div style={{ textAlign: "center", padding: "40px 0", color: "#64a6c8", fontSize: 13 }}>Sin gastos en {anioSel}</div>
            : <>
                <div style={{ ...S.card, textAlign: "center" }}><span style={S.lbl}>Total {anioSel}</span><div style={{ fontSize: 32, fontWeight: 800, color: "#fff" }}>{fmt(totalAnio)}</div><div style={{ fontSize: 13, color: "#64a6c8", marginTop: 4 }}>Promedio mensual: {fmt(totalAnio / 12)}</div></div>
                <div style={S.card}>
                  <span style={S.lbl}>Distribución por categoría</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    <div style={{ flexShrink: 0 }}><PieChart data={porCatAnio.map(c => ({ value: c.total, color: c.color }))} /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {porCatAnio.map(c => (<div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                        <div style={{ width: 10, height: 10, borderRadius: 3, background: c.color, flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.emoji} {c.label}</div><div style={{ fontSize: 11, color: "#64a6c8" }}>{Math.round(c.total / totalAnio * 100)}% · {fmt(c.total)}</div></div>
                      </div>))}
                    </div>
                  </div>
                </div>
                <div style={S.card}>
                  <span style={S.lbl}>Por categoría</span>
                  {porCatAnio.map(c => (<div key={c.id} style={{ marginBottom: 13 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 5 }}><span>{c.emoji} {c.label}</span><span style={{ color: "#94a3b8" }}>{fmt(c.total)}</span></div>
                    <div style={{ height: 6, background: "#1e3a52", borderRadius: 3, overflow: "hidden" }}><div style={{ width: `${(c.total / maxCatAnio) * 100}%`, height: "100%", background: c.color, borderRadius: 3 }} /></div>
                  </div>))}
                </div>
                <div style={S.card}>
                  <span style={S.lbl}>Mes a mes</span>
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 80 }}>
                    {gastosPorMes.map(({ m, label, total }) => (
                      <div key={m} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                        <div style={{ width: "100%", background: total > 0 ? "#6ee7b7" : "#1e3a52", borderRadius: "3px 3px 0 0", height: `${total > 0 ? Math.max((total / maxMesAnio) * 60, 4) : 4}px`, cursor: total > 0 ? "pointer" : "default", opacity: total > 0 ? 1 : 0.3 }} onClick={() => { if (total > 0) { setMesSel({ year: anioSel, month: m }); setVista("mensual"); } }} />
                        <div style={{ fontSize: 9, color: total > 0 ? "#94a3b8" : "#334155" }}>{label}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: "#475569", marginTop: 8, textAlign: "center" }}>Tocá una barra para ver el mes</div>
                </div>
              </>
          }
        </div>
      )}

      {/* ════ MENSUAL ════ */}
      {vista === "mensual" && (
        <div style={S.sec}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14, marginBottom: 14 }}>
            <button onClick={prevMes} style={{ background: "#162030", border: "1px solid #1e3a52", borderRadius: 8, color: "#6ee7b7", fontSize: 22, width: 40, height: 40, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>‹</button>
            <div style={{ textAlign: "center" }}><div style={{ fontSize: 18, fontWeight: 700, color: "#fff" }}>{MESES[mesSel.month]}</div><div style={{ fontSize: 13, color: "#64a6c8" }}>{mesSel.year}</div></div>
            <button onClick={nextMes} style={{ background: "#162030", border: "1px solid #1e3a52", borderRadius: 8, color: "#6ee7b7", fontSize: 22, width: 40, height: 40, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>›</button>
          </div>
          <div style={{ ...S.card, marginBottom: 12 }}>
            <span style={S.lbl}>Proporción de {MESES[mesSel.month]}</span>
            {sinIngMes && !esManualAct ? <div style={{ fontSize: 13, color: "#64a6c8" }}>Sin ingresos → 50/50</div>
              : <PropBar pct1={pctM1} n1={nombres.p1} n2={nombres.p2} i1={ingresoVigente(ingresos, "p1", mesSel.year, mesSel.month)} i2={ingresoVigente(ingresos, "p2", mesSel.year, mesSel.month)} esManual={esManualAct} />}
          </div>
          {gastosMes.length === 0
            ? <div style={{ textAlign: "center", padding: "40px 0", color: "#64a6c8", fontSize: 13 }}>Sin gastos en {mesLabel(mesSel.year, mesSel.month)}</div>
            : <>
                <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                  {[{ nombre: nombres.p1, total: totalMesP1, deberia: totalMes * pctM1, color: "#6ee7b7" }, { nombre: nombres.p2, total: totalMesP2, deberia: totalMes * pctM2, color: "#93c5fd" }].map((p, i) => (
                    <div key={i} style={{ flex: 1, background: "#162030", borderRadius: 12, padding: "12px 14px", border: `1px solid ${p.color}22` }}>
                      <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 3 }}>{p.nombre}</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: p.color }}>{fmt(p.total)}</div>
                      <div style={{ fontSize: 11, color: "#475569", marginTop: 2 }}>Debería: {fmt(p.deberia)}</div>
                    </div>
                  ))}
                </div>
                <BalanceChip saldo={saldoMesP1} n1={nombres.p1} n2={nombres.p2} />
                <div style={{ ...S.card, display: "flex", justifyContent: "space-between", alignItems: "center" }}><div><span style={S.lbl}>Total del mes</span><div style={{ fontSize: 26, fontWeight: 800, color: "#fff" }}>{fmt(totalMes)}</div></div><div style={{ textAlign: "right" }}><span style={S.lbl}>Gastos</span><div style={{ fontSize: 22, fontWeight: 700 }}>{gastosMes.length}</div></div></div>
                {porCatMes.length > 0 && (<div style={S.card}><span style={S.lbl}>Por categoría</span>{porCatMes.map(c => (<div key={c.id} style={{ marginBottom: 12 }}><div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}><span>{c.emoji} {c.label}</span><span style={{ color: "#94a3b8" }}>{fmt(c.total)} <span style={{ fontSize: 11, color: "#475569" }}>({Math.round(c.total / totalMes * 100)}%)</span></span></div><div style={{ height: 5, background: "#1e3a52", borderRadius: 3, overflow: "hidden" }}><div style={{ width: `${(c.total / porCatMes[0].total) * 100}%`, height: "100%", background: c.color, borderRadius: 3 }} /></div></div>))}</div>)}
                <span style={S.lbl}>Detalle</span>
                {gastosMes.map(g => { const cat = CATALOGO.find(c => c.id === g.categoria); return (<div key={g.id} style={S.row}><div style={S.emoji}>{cat?.emoji || "📦"}</div><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.descripcion}</div><div style={{ fontSize: 12, color: "#64a6c8", marginTop: 1 }}>{nombres[g.pagadoPor]} · {formatFecha(g.fecha)}</div></div><div style={{ fontSize: 15, fontWeight: 700, color: g.pagadoPor === "p1" ? "#6ee7b7" : "#93c5fd", flexShrink: 0 }}>{fmt(g.monto)}</div></div>); })}
              </>
          }
        </div>
      )}

      {/* ════ AGREGAR ════ */}
      {vista === "agregar" && (
        <div style={S.sec}>
          <div style={{ marginTop: 14 }}><span style={S.lbl}>Descripción</span><input style={S.input} placeholder="Ej: Carrefour, Gas, Farmacia..." value={form.descripcion} onChange={e => setForm({ ...form, descripcion: e.target.value })} /></div>
          <div style={{ marginTop: 14 }}><span style={S.lbl}>Monto ($)</span><input style={S.input} type="number" placeholder="0" value={form.monto} onChange={e => setForm({ ...form, monto: e.target.value })} /></div>
          <div style={{ marginTop: 14 }}><span style={S.lbl}>Fecha de pago</span><input style={S.input} type="date" value={form.fecha} onChange={e => setForm({ ...form, fecha: e.target.value })} /></div>
          <div style={{ marginTop: 14 }}><span style={S.lbl}>Categoría</span><select style={S.sel} value={form.categoria} onChange={e => setForm({ ...form, categoria: e.target.value })}>{catActivas.map(c => <option key={c.id} value={c.id}>{c.emoji} {c.label}</option>)}</select></div>
          <div style={{ marginTop: 14 }}><span style={S.lbl}>¿Quién pagó?</span><div style={{ display: "flex", gap: 10 }}>{[{ id: "p1", label: nombres.p1, color: "#6ee7b7" }, { id: "p2", label: nombres.p2, color: "#93c5fd" }].map(p => (<button key={p.id} style={{ flex: 1, padding: 11, borderRadius: 8, border: `2px solid ${form.pagadoPor === p.id ? p.color : "#1e3a52"}`, background: form.pagadoPor === p.id ? `${p.color}18` : "#0f1923", color: form.pagadoPor === p.id ? p.color : "#94a3b8", fontWeight: 600, fontSize: 14, cursor: "pointer" }} onClick={() => setForm({ ...form, pagadoPor: p.id })}>{p.label}</button>))}</div></div>
          <div style={{ marginTop: 24 }}><button style={S.btn} onClick={agregarGasto}>Agregar gasto</button></div>
        </div>
      )}

      {/* ════ INGRESOS ════ */}
      {vista === "ingresos" && (
        <div style={S.sec}>
          <div style={{ ...S.card, marginTop: 14 }}>
            <span style={S.lbl}>Agregar ingreso</span>
            <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>{[{ id: "p1", label: nombres.p1, color: "#6ee7b7" }, { id: "p2", label: nombres.p2, color: "#93c5fd" }].map(p => (<button key={p.id} style={{ flex: 1, padding: 10, borderRadius: 8, border: `2px solid ${formIng.persona === p.id ? p.color : "#1e3a52"}`, background: formIng.persona === p.id ? `${p.color}18` : "#0f1923", color: formIng.persona === p.id ? p.color : "#94a3b8", fontWeight: 600, fontSize: 14, cursor: "pointer" }} onClick={() => setFormIng({ ...formIng, persona: p.id })}>{p.label}</button>))}</div>
            <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
              <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: "#64a6c8", marginBottom: 4 }}>Mes</div><select style={{ ...S.sel, fontSize: 13, padding: "9px 10px" }} value={formIng.month} onChange={e => setFormIng({ ...formIng, month: parseInt(e.target.value) })}>{MESES.map((m, i) => <option key={i} value={i}>{m}</option>)}</select></div>
              <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: "#64a6c8", marginBottom: 4 }}>Año</div><select style={{ ...S.sel, fontSize: 13, padding: "9px 10px" }} value={formIng.year} onChange={e => setFormIng({ ...formIng, year: parseInt(e.target.value) })}>{yearsOpts.map(y => <option key={y} value={y}>{y}</option>)}</select></div>
            </div>
            <div style={{ marginBottom: 12 }}><div style={{ fontSize: 11, color: "#64a6c8", marginBottom: 4 }}>Concepto (opcional)</div><input style={S.input} placeholder="Ej: Sueldo, Freelance, Bono..." value={formIng.concepto} onChange={e => setFormIng({ ...formIng, concepto: e.target.value })} /></div>
            <div style={{ marginBottom: 14 }}><div style={{ fontSize: 11, color: "#64a6c8", marginBottom: 4 }}>Monto ($)</div><input style={S.input} type="number" placeholder="0" value={formIng.monto} onChange={e => setFormIng({ ...formIng, monto: e.target.value })} /></div>
            <button style={S.btn} onClick={agregarIngreso}>Agregar ingreso</button>
          </div>
          {mksTodos.length === 0
            ? <div style={{ textAlign: "center", padding: "28px 0", color: "#64a6c8", fontSize: 13 }}><div style={{ fontSize: 32, marginBottom: 8 }}>💸</div>Sin ingresos registrados</div>
            : <>{mksTodos.map(mk => {
                const [y, m] = mk.split("-").map(Number);
                const entradasMes = ingresos.filter(e => e.mesKey === mk);
                const sum1 = entradasMes.filter(e => e.persona === "p1").reduce((s, e) => s + e.monto, 0);
                const sum2 = entradasMes.filter(e => e.persona === "p2").reduce((s, e) => s + e.monto, 0);
                const totm = sum1 + sum2;
                return (<div key={mk} style={{ ...S.card, marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}><div style={{ fontSize: 14, fontWeight: 700 }}>{mesLabel(y, m - 1)}</div>{totm > 0 && <div style={{ fontSize: 12, color: "#6ee7b7" }}>{Math.round(sum1 / totm * 100)}% / {Math.round(sum2 / totm * 100)}%</div>}</div>
                  {["p1", "p2"].map(persona => {
                    const entradas = entradasMes.filter(e => e.persona === persona);
                    const color = persona === "p1" ? "#6ee7b7" : "#93c5fd";
                    const suma = entradas.reduce((s, e) => s + e.monto, 0);
                    return (<div key={persona} style={{ marginBottom: 6 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 6, borderTop: "1px solid #1e3a5233" }}><span style={{ fontSize: 12, color, fontWeight: 600 }}>{nombres[persona]}</span>{suma > 0 && <span style={{ fontSize: 13, fontWeight: 700, color }}>{fmt(suma)}</span>}</div>
                      {entradas.map(e => (<div key={e.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingLeft: 12, marginTop: 4 }}><span style={{ fontSize: 12, color: "#94a3b8" }}>{e.concepto}</span><div style={{ display: "flex", alignItems: "center", gap: 10 }}><span style={{ fontSize: 13 }}>{fmt(e.monto)}</span><button style={{ background: "none", border: "none", color: "#475569", fontSize: 12, cursor: "pointer", padding: 2 }} onClick={() => setConfirmDel({ tipo: "ingreso", id: e.id })}>🗑️</button></div></div>))}
                      {entradas.length === 0 && <div style={{ fontSize: 12, color: "#334155", paddingLeft: 12, marginTop: 4 }}>Sin ingresos</div>}
                    </div>);
                  })}
                </div>);
              })}</>
          }
        </div>
      )}

      {/* ════ HISTORIAL ════ */}
      {vista === "historial" && (
        <div style={S.sec}>
          <div style={{ marginTop: 14, display: "flex", gap: 8, marginBottom: 4 }}>
            <select style={{ ...S.sel, flex: 1, fontSize: 13, padding: "8px 10px" }} value={filtroCat} onChange={e => setFiltroCat(e.target.value)}><option value="todas">Todas las categorías</option>{catActivas.map(c => <option key={c.id} value={c.id}>{c.emoji} {c.label}</option>)}</select>
            <select style={{ ...S.sel, flex: 1, fontSize: 13, padding: "8px 10px" }} value={filtroPer} onChange={e => setFiltroPer(e.target.value)}><option value="todas">Ambos</option><option value="p1">{nombres.p1}</option><option value="p2">{nombres.p2}</option></select>
          </div>
          <div style={{ fontSize: 12, color: "#475569", marginBottom: 8 }}>{gastosFilt.length} resultado{gastosFilt.length !== 1 ? "s" : ""}</div>
          {gastosFilt.map(g => { const cat = CATALOGO.find(c => c.id === g.categoria); return (<div key={g.id} style={S.row}><div style={S.emoji}>{cat?.emoji || "📦"}</div><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.descripcion}</div><div style={{ fontSize: 12, color: "#64a6c8", marginTop: 1 }}>{nombres[g.pagadoPor]} · {formatFecha(g.fecha)}</div></div><div style={{ textAlign: "right", flexShrink: 0 }}><div style={{ fontSize: 15, fontWeight: 700, color: g.pagadoPor === "p1" ? "#6ee7b7" : "#93c5fd" }}>{fmt(g.monto)}</div><button style={{ background: "none", border: "none", color: "#475569", fontSize: 11, cursor: "pointer", padding: "2px 0" }} onClick={() => setConfirmDel({ tipo: "gasto", id: g.id })}>🗑️</button></div></div>); })}
        </div>
      )}

      {/* ════ AJUSTES ════ */}
      {vista === "ajustes" && (
        <div style={S.sec}>
          <div style={{ display: "flex", gap: 8, marginTop: 14, marginBottom: 16 }}>
            {[{ id: "general", label: "General" }, { id: "categorias", label: "Categorías" }].map(t => (
              <button key={t.id} onClick={() => setAjusteTab(t.id)} style={{ flex: 1, padding: "9px", borderRadius: 8, border: `2px solid ${ajusteTab === t.id ? "#6ee7b7" : "#1e3a52"}`, background: ajusteTab === t.id ? "#0d2d1f" : "#162030", color: ajusteTab === t.id ? "#6ee7b7" : "#64a6c8", fontWeight: 600, fontSize: 14, cursor: "pointer" }}>{t.label}</button>
            ))}
          </div>

          {ajusteTab === "general" && (<>
            <div style={{ marginBottom: 20 }}>
              <span style={S.lbl}>Nombres</span>
              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: "#6ee7b7", marginBottom: 4 }}>Persona 1</div><input style={S.input} placeholder={nombres.p1} value={editNombres.p1} onChange={e => setEditNombres({ ...editNombres, p1: e.target.value })} /></div>
                <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: "#93c5fd", marginBottom: 4 }}>Persona 2</div><input style={S.input} placeholder={nombres.p2} value={editNombres.p2} onChange={e => setEditNombres({ ...editNombres, p2: e.target.value })} /></div>
              </div>
              <div style={{ marginTop: 12 }}><button style={S.btn} onClick={guardarNombres}>Guardar nombres</button></div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <span style={S.lbl}>Modo de cálculo de proporciones</span>
              {[{ id: "porcentual", label: "Porcentual a los ingresos", desc: "Calcula automáticamente la proporción según los sueldos cargados en Ingresos." },
                { id: "manual", label: "Graduación manual", desc: "Definís vos la proporción con una barra deslizable." }].map(modo => (
                <div key={modo.id} onClick={() => saveConfig({ modoProp: modo.id })}
                  style={{ background: config.modoProp === modo.id ? "#0d2d1f" : "#162030", border: `2px solid ${config.modoProp === modo.id ? "#6ee7b7" : "#1e3a52"}`, borderRadius: 10, padding: "12px 14px", marginBottom: 10, cursor: "pointer", display: "flex", gap: 12, alignItems: "flex-start" }}>
                  <div style={{ width: 20, height: 20, borderRadius: "50%", border: `3px solid ${config.modoProp === modo.id ? "#6ee7b7" : "#334155"}`, background: config.modoProp === modo.id ? "#6ee7b7" : "transparent", flexShrink: 0, marginTop: 2, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {config.modoProp === modo.id && <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#0f1923" }} />}
                  </div>
                  <div><div style={{ fontSize: 14, fontWeight: 600, color: config.modoProp === modo.id ? "#6ee7b7" : "#e2e8f0" }}>{modo.label}</div><div style={{ fontSize: 12, color: "#64a6c8", marginTop: 3 }}>{modo.desc}</div></div>
                </div>
              ))}
              {config.modoProp === "manual" && (
                <div style={{ ...S.card, marginTop: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 10 }}>
                    <span style={{ color: "#6ee7b7", fontWeight: 700 }}>{nombres.p1}: {config.propManual}%</span>
                    <span style={{ color: "#93c5fd", fontWeight: 700 }}>{nombres.p2}: {100 - config.propManual}%</span>
                  </div>
                  <input type="range" min={0} max={100} value={config.propManual}
                    onChange={e => setConfig_({ ...config, propManual: parseInt(e.target.value) })}
                    onMouseUp={() => saveConfig({ propManual: config.propManual })}
                    onTouchEnd={() => saveConfig({ propManual: config.propManual })}
                    style={{ width: "100%", accentColor: "#6ee7b7", cursor: "pointer" }} />
                  <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", height: 20, marginTop: 10 }}>
                    <div style={{ width: `${config.propManual}%`, background: "#6ee7b7" }} />
                    <div style={{ flex: 1, background: "#93c5fd" }} />
                  </div>
                </div>
              )}
            </div>

            <div style={{ marginBottom: 20 }}>
              <span style={S.lbl}>Cuenta</span>
              <div style={S.card}>
                <div style={{ fontSize: 14, color: "#e2e8f0", marginBottom: 12 }}>👤 {user.displayName} <span style={{ fontSize: 12, color: "#64a6c8" }}>({user.email})</span></div>
                <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 14 }}>Para que tu pareja acceda, debe crear su propia cuenta con el mismo link de la app.</div>
                <button style={{ ...S.btnSec, color: "#f87171", borderColor: "#f87171" }} onClick={logout}>Cerrar sesión</button>
              </div>
            </div>
          </>)}

          {ajusteTab === "categorias" && (<div>
            <div style={{ fontSize: 13, color: "#64a6c8", marginBottom: 14 }}>Activá o desactivá las categorías. Las inactivas no desaparecen de gastos ya cargados.</div>
            {CATALOGO.map(c => {
              const activa = config.categoriasActivas.includes(c.id);
              return (<div key={c.id} onClick={() => toggleCat(c.id)}
                style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 14px", background: activa ? "#162030" : "#0f1923", borderRadius: 10, marginBottom: 8, border: `1px solid ${activa ? "#1e3a52" : "#0f1923"}`, cursor: "pointer" }}>
                <div style={{ fontSize: 22, width: 36, textAlign: "center" }}>{c.emoji}</div>
                <div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 500, color: activa ? "#e2e8f0" : "#475569" }}>{c.label}</div></div>
                <div style={{ width: 44, height: 24, borderRadius: 12, background: activa ? "#6ee7b7" : "#334155", position: "relative", flexShrink: 0 }}>
                  <div style={{ position: "absolute", top: 3, left: activa ? 23 : 3, width: 18, height: 18, borderRadius: "50%", background: activa ? "#0f1923" : "#64a6c8", transition: "left 0.15s" }} />
                </div>
              </div>);
            })}
          </div>)}
        </div>
      )}

      {/* NAV */}
      <nav style={S.nav}>
        {[
          { id: "dashboard", label: "Inicio",    icon: "📊" },
          { id: "anual",     label: "Anual",     icon: "📆" },
          { id: "mensual",   label: "Mensual",   icon: "📅" },
          { id: "agregar",   label: "Agregar",   icon: "➕" },
          { id: "ingresos",  label: "Ingresos",  icon: "💸" },
          { id: "historial", label: "Historial", icon: "📋" },
          { id: "ajustes",   label: "Ajustes",   icon: "⚙️" },
        ].map(v => (
          <button key={v.id} style={S.navBtn(vista === v.id)} onClick={() => setVista(v.id)}>
            <span style={{ fontSize: 16 }}>{v.icon}</span>
            {v.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
