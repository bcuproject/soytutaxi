import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import CentralPage from "./pages/CentralPage";
import ConexionPage from "./pages/ConexionPage";
import type { Locale } from "@shared/domain/types.ts";
import { Button, DemoBanner, Logo } from "./components/ui";
import { backend, type StaffSession } from "./lib/backend";
import { LocaleContext, makeT } from "./lib/i18n";
import { StaffLangProvider } from "./lib/staffLang";
import BookingPage from "./pages/BookingPage";
import DispatchPage from "./pages/DispatchPage";
import DriverApp from "./pages/DriverApp";
import StatusPage from "./pages/StatusPage";

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem("stt_locale");
    if (saved === "en" || saved === "es-AR") return saved;
  } catch { /* ignore */ }
  return navigator.language?.toLowerCase().startsWith("es") ? "es-AR" : "en";
}

function PassengerShell({ children }: { children: ReactNode }) {
  return (
    <LocaleSwitchContext>
      {(locale, setLocale) => (
        <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,rgba(245,196,0,0.08),transparent_55%)]">
          <header className="mx-auto flex max-w-5xl items-center justify-between px-5 py-5">
            <Link to="/"><Logo /></Link>
            <div className="flex rounded-lg border border-ink-700 p-0.5 text-xs font-semibold" role="group" aria-label="Idioma / Language">
              {(["es-AR", "en"] as Locale[]).map((l) => (
                <button key={l} onClick={() => setLocale(l)} aria-pressed={locale === l}
                  className={`rounded-md px-2.5 py-1 ${locale === l ? "bg-ink-700 text-white" : "text-ink-400"}`}>{l === "en" ? "EN" : "ES"}</button>
              ))}
            </div>
          </header>
          <main>{children}</main>
          <footer className="mx-auto max-w-5xl px-5 py-10 text-xs text-ink-500">SoyTuTaxi · Buenos Aires · +54 9 11 6369-2528 · info@soytutaxi.com</footer>
        </div>
      )}
    </LocaleSwitchContext>
  );
}

function LocaleSwitchContext({ children }: { children: (l: Locale, set: (l: Locale) => void) => ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const setLocale = (l: Locale) => { setLocaleState(l); try { localStorage.setItem("stt_locale", l); } catch { /* ignore */ } };
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const value = useMemo(() => ({ locale, setLocale, t: makeT(locale) }), [locale]);
  return <LocaleContext.Provider value={value}>{children(locale, setLocale)}</LocaleContext.Provider>;
}

function StaffOnly({ children }: { children: ReactNode }) {
  const [s, setS] = useState<StaffSession | null | undefined>(undefined);
  useEffect(() => { backend.staffSession().then(setS); }, []);
  if (s === undefined) return null;
  if (!s) return <div className="py-24 text-center"><p className="text-ink-300">Ingresá a despacho primero.</p><Link to="/despacho"><Button className="mt-4">Despacho</Button></Link></div>;
  return <>{children}</>;
}

export default function App() {
  const loc = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [loc.pathname]);
  return (
    <>
      {backend.mode === "demo" && <DemoBanner text={makeT(initialLocale())("demo.banner")} />}
      <Routes>
        <Route path="/" element={<PassengerShell><BookingPage /></PassengerShell>} />
        <Route path="/reserva/:ref" element={<PassengerShell><StatusPage /></PassengerShell>} />
        <Route path="/despacho" element={<StaffLangProvider><DispatchPage /></StaffLangProvider>} />
        <Route path="/chofer" element={<DriverApp />} />
        <Route path="/central" element={<StaffLangProvider><CentralPage /></StaffLangProvider>} />
        <Route path="/conexion" element={<StaffLangProvider><ConexionPage /></StaffLangProvider>} />
        <Route path="/despacho/nueva" element={<StaffLangProvider><StaffOnly><div className="min-h-screen"><BookingPage staff /></div></StaffOnly></StaffLangProvider>} />
        <Route path="*" element={<PassengerShell><div className="py-24 text-center text-ink-400">404</div></PassengerShell>} />
      </Routes>
    </>
  );
}
