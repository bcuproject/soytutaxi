import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LocaleContext, makeT } from "./i18n";
import { EN, EN_PATTERNS, KEEP } from "./staffDict";
import { setDefaultLocale } from "./format";

// Language of the staff screens (Despacho / Central). The screens are written in Spanish; in English
// a translator swaps the on-screen text as it renders. Messages to passengers and chat content are
// never translated (mark such areas with translate="no").
export type StaffLang = "es" | "en";
const KEY = "stt_staff_lang";

function readLang(): StaffLang {
  try { return localStorage.getItem(KEY) === "en" ? "en" : "es"; } catch { return "es"; }
}

const Ctx = createContext<{ lang: StaffLang; setLang: (l: StaffLang) => void }>({ lang: "es", setLang: () => {} });
export const useStaffLang = () => useContext(Ctx);

/** Translate one Spanish string (for prompts, desktop notifications and other text outside the page). */
export function tr(es: string, lang: StaffLang = readLang()): string {
  if (lang === "es") return es;
  return translate(es) ?? es;
}

function translate(text: string): string | null {
  const s = text.replace(/\s+/g, " ").trim();
  if (!s || !/[a-záéíóúñ]/i.test(s)) return null;
  if (KEEP.some((k) => k.test(s))) return null;
  const hit = EN[s];
  let out: string | null = hit ?? null;
  if (out === null) {
    for (const [re, rep] of EN_PATTERNS) if (re.test(s)) { out = s.replace(re, rep); break; }
  }
  // "· Libre", "· 2 abierta(s)": a separator in front of a known piece.
  if (out === null && s.startsWith("· ")) { const rest = translate(s.slice(2)); if (rest !== null) out = "· " + rest.trim(); }
  if (out === null) return null;
  // Keep the spaces around the text: React splits "3 pax · 2 valijas" into several nodes.
  const lead = /^\s/.test(text) ? " " : "", trail = /\s$/.test(text) ? " " : "";
  return lead + out + trail;
}

const ATTRS = ["placeholder", "title", "aria-label"] as const;
const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE", "PRE"]);

function skipped(el: Element | null): boolean {
  for (let e = el; e; e = e.parentElement) {
    if (SKIP.has(e.tagName) || e.getAttribute("translate") === "no" || (e as HTMLElement).isContentEditable) return true;
  }
  return false;
}

// Original Spanish of everything we changed, so switching back restores it.
type Orig = { text?: string; shown?: string; attrs?: Record<string, { es: string; shown: string }> };

function useTranslator(root: React.RefObject<HTMLElement | null>, lang: StaffLang) {
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const orig = new WeakMap<Node, Orig>();
    const touched = new Set<Node>();

    const doText = (n: Text) => {
      const o = orig.get(n);
      const cur = n.nodeValue ?? "";
      if (o && cur === o.shown) return; // our own change
      if (skipped(n.parentElement)) return;
      const en = translate(cur);
      if (en === null || en === cur) { if (o) orig.delete(n); return; }
      orig.set(n, { text: cur, shown: en });
      touched.add(n);
      n.nodeValue = en;
    };
    const doAttrs = (e: Element) => {
      if (skipped(e)) return;
      for (const a of ATTRS) {
        const v = e.getAttribute(a);
        if (!v) continue;
        const o = orig.get(e)?.attrs?.[a];
        if (o && v === o.shown) continue;
        const en = translate(v);
        if (en === null) continue;
        const rec = orig.get(e) ?? {};
        rec.attrs = { ...(rec.attrs ?? {}), [a]: { es: v, shown: en.trim() } };
        orig.set(e, rec); touched.add(e);
        e.setAttribute(a, en.trim());
      }
    };
    const walk = (n: Node) => {
      if (n.nodeType === Node.TEXT_NODE) { doText(n as Text); return; }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      const e = n as Element;
      if (SKIP.has(e.tagName)) return;
      doAttrs(e);
      for (let c = e.firstChild; c; c = c.nextSibling) walk(c);
    };

    if (lang === "es") return;
    walk(el);
    const mo = new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === "characterData") doText(m.target as Text);
        else if (m.type === "attributes") doAttrs(m.target as Element);
        else m.addedNodes.forEach(walk);
      }
    });
    mo.observe(el, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
    return () => {
      mo.disconnect();
      // Back to Spanish: put the original text back where it is still ours.
      touched.forEach((n) => {
        const o = orig.get(n);
        if (!o) return;
        if (n.nodeType === Node.TEXT_NODE && o.text !== undefined && n.nodeValue === o.shown) n.nodeValue = o.text;
        if (o.attrs) for (const [a, v] of Object.entries(o.attrs)) if ((n as Element).getAttribute(a) === v.shown) (n as Element).setAttribute(a, v.es);
      });
    };
  }, [root, lang]);
}

/** Wraps a staff screen: provides the language, translates the screen, and sets the booking form's language. */
export function StaffLangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<StaffLang>(readLang);
  const setLang = (l: StaffLang) => { setLangState(l); try { localStorage.setItem(KEY, l); } catch { /* ignore */ } };
  // The whole <body>, so dialogs and toasts rendered outside the page are covered too.
  const body = useRef<HTMLElement | null>(typeof document !== "undefined" ? document.body : null);
  useTranslator(body, lang);
  // Dates and times on staff screens follow the language too (sáb 28-11 → Sat 28/11).
  setDefaultLocale(lang === "en" ? "en" : "es-AR");
  useEffect(() => () => setDefaultLocale("es-AR"), []);
  useEffect(() => { document.documentElement.lang = lang === "en" ? "en" : "es-AR"; }, [lang]);
  const locale = lang === "en" ? "en" : "es-AR";
  const value = useMemo(() => ({ lang, setLang }), [lang]);
  const loc = useMemo(() => ({ locale, setLocale: () => {}, t: makeT(locale) }) as const, [locale]);
  return (
    <Ctx.Provider value={value}>
      <LocaleContext.Provider value={loc}>
        {children}
      </LocaleContext.Provider>
    </Ctx.Provider>
  );
}

/** ES / EN toggle for the staff headers. */
export function StaffLangSwitch({ className = "" }: { className?: string }) {
  const { lang, setLang } = useStaffLang();
  return (
    <div className={`flex rounded-lg border border-ink-700 p-0.5 text-xs font-semibold ${className}`} role="group" aria-label="Idioma / Language" translate="no" data-testid="staff-lang">
      {(["es", "en"] as StaffLang[]).map((l) => (
        <button key={l} type="button" onClick={() => setLang(l)} aria-pressed={lang === l}
          className={`rounded-md px-2.5 py-1 ${lang === l ? "bg-ink-700 text-white" : "text-ink-400 hover:text-white"}`}>{l === "en" ? "EN" : "ES"}</button>
      ))}
    </div>
  );
}
