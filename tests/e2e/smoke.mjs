// Browser smoke test of the demo build. Usage: node tests/e2e/smoke.mjs [baseUrl] [shotDir]
import puppeteer from "puppeteer-core";
const BASE = process.argv[2] ?? "http://localhost:4173";
const SHOTS = process.argv[3] ?? "/tmp";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"], headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/tile\.openstreetmap|ERR_|Failed to load resource/.test(m.text() + (m.location()?.url ?? "")) && errors.push(m.text()));
const assert = (c, msg) => { if (!c) throw new Error("ASSERT: " + msg); console.log("ok -", msg); };
// Find and click in one step inside the page: a handle found before a re-render can go stale.
const clickText = async (sel, text) => {
  await page.waitForFunction((s, t) => {
    const el = [...document.querySelectorAll(s)].find((e) => e.textContent.includes(t) && e.isConnected && !e.disabled);
    if (!el) return false;
    el.click();
    return true;
  }, {}, sel, text);
};

await page.setViewport({ width: 1280, height: 900 });
await page.goto(BASE + "/", { waitUntil: "networkidle0" });
await page.evaluate(() => localStorage.setItem("stt_locale", "en"));
await page.reload({ waitUntil: "networkidle0" });
assert(await page.$eval("body", (b) => b.innerText.includes("DEMO MODE")), "demo label visible");

// Acceptance: EZE pickup, 4 people + 4 large cases
await page.select('[data-testid="zone"]', "palermo");
await page.type('[data-testid="address"]', "Honduras 5600, Palermo Soho");
await page.type('[data-testid="flight"]', "ar1303");
const plus = async (label, n) => { for (let i = 0; i < n; i++) await page.click(`button[aria-label="${label} +"]`); };
await plus("Passengers", 2);
await plus("Large suitcases", 2);
await page.click('button[aria-label="Carry-on bags −"]');
await page.screenshot({ path: `${SHOTS}/1-form.png`, fullPage: true });
await page.click('[data-testid="get-quote"]');
await page.waitForSelector('[data-testid="quote-total"]');
const sedanDisabled = await page.$eval('[data-testid="vehicle-sedan_premium"]', (b) => b.disabled);
const minivanChecked = await page.$eval('[data-testid="vehicle-minivan"]', (b) => b.getAttribute("aria-checked"));
assert(sedanDisabled && minivanChecked === "true", "sedan ineligible, minivan selected");
assert((await page.$eval('[data-testid="quote-total"]', (e) => e.textContent)).includes("45"), "minivan fare USD 45 shown");
await page.screenshot({ path: `${SHOTS}/2-review.png`, fullPage: true });

// Submit without contact → validation
await page.click('[data-testid="submit-booking"]');
await page.waitForSelector('[role="alert"]');
assert(true, "contact validation shown");
await page.type('input[autocomplete="name"]', "Emma Wilson");
await page.type('input[type="tel"]', "+44 7700 900123");
await page.click('[data-testid="submit-booking"]');
await page.waitForSelector('[data-testid="booking-ref"]');
const ref = await page.$eval('[data-testid="booking-ref"]', (e) => e.textContent);
assert(/^STT-[A-Z0-9]{6}$/.test(ref), `booking reference ${ref}`);
assert(await page.$eval("body", (b) => b.innerText.includes("isn't confirmed yet")), "receipt is distinct from confirmation");
await page.screenshot({ path: `${SHOTS}/3-done.png`, fullPage: true });
await clickText("button", "View booking status");
await page.waitForFunction(() => document.body.innerText.toLowerCase().includes("finding a driver") && document.body.innerText.toLowerCase().includes("meeting point"));
assert(true, "status page shows awaiting driver + meeting point");
await page.screenshot({ path: `${SHOTS}/4-status.png`, fullPage: true });
await page.click('[data-testid="cancel-open"]');
await page.waitForSelector('[data-testid="cancel-box"]');
assert(await page.$eval('[data-testid="cancel-box"]', (e) => /no charge/i.test(e.innerText)), "self-service cancel shows the policy terms");
await clickText("button", "Keep it");
await page.waitForSelector('[data-testid="cancel-open"]');

// Dispatch (client-side navigation keeps the in-memory demo store)
await page.evaluate(() => { history.pushState({}, "", "/despacho"); dispatchEvent(new PopStateEvent("popstate")); });
await page.waitForSelector('[data-testid="demo-signin"]');
await page.click('[data-testid="demo-signin"]');
await page.waitForSelector('[data-testid="schedule"]');
await page.setViewport({ width: 1440, height: 900 });
const blocks = await page.$$eval('[data-testid^="block-"]', (b) => b.map((x) => x.dataset.testid));
assert(blocks.includes("block-STT-DEM001") && blocks.includes(`block-${ref}`), `schedule shows seeded + new booking (${blocks.length} blocks)`);
await page.screenshot({ path: `${SHOTS}/5-schedule.png` });
await clickText('[role="tab"]', "Mapa");
await page.waitForSelector('[data-testid="driver-map"] .leaflet-marker-icon');
await new Promise((r) => setTimeout(r, 3500));
const cars = await page.$$eval('[data-testid="driver-map"] .leaflet-marker-icon', (els) => els.length);
assert(cars >= 7, `map shows driver markers + airports (${cars})`);
await page.screenshot({ path: `${SHOTS}/5b-map.png` });
await clickText('[role="tab"]', "Reservas");
await page.waitForSelector('[data-testid="bookings-grid"]');
await page.screenshot({ path: `${SHOTS}/6-grid.png` });
await clickText("td", "STT-DEM004");
await page.waitForSelector('[role="dialog"]');
assert(await page.$eval('[role="dialog"]', (d) => d.innerText.includes("silla de ruedas")), "drawer shows notes");
// Message the passenger from the booking
await page.click('[data-testid="passenger-message-open"]');
await page.waitForSelector('[data-testid="passenger-message"]');
await page.type('[data-testid="passenger-message-text"]', "Hola, tu chofer ya está en camino.");
await page.click('[data-testid="passenger-message-send"]');
await page.waitForFunction(() => document.querySelector('[data-testid="passenger-message"]')?.innerText.includes("Enviado"));
assert(true, "dispatcher sends a WhatsApp to the passenger from the booking");
await page.screenshot({ path: `${SHOTS}/7a-passenger-message.png` });
await page.screenshot({ path: `${SHOTS}/7-drawer.png` });
await page.keyboard.press("Escape");

// Staff booking without flight → requires reason
// WhatsApp inbox
await clickText('[role="tab"]', "WhatsApp");
await page.waitForSelector('[data-testid="wa-inbox"]');
await clickText('[data-testid="wa-inbox"] button', "Tom Baker");
await page.waitForSelector('[data-testid="wa-thread"]');
assert(await page.$eval('[data-testid="wa-thread"]', (t) => t.innerText.includes("9 people")), "whatsapp thread shows the passenger's messages");
await clickText("button", "Tomar conversación");
await page.waitForSelector("textarea");
await page.type("textarea", "Hola Tom, para 9 con equipaje te mando una Combi: USD 85.");
await page.keyboard.press("Enter");
await page.waitForFunction(() => document.querySelector('[data-testid="wa-thread"]').innerText.includes("USD 85"));
assert(true, "staff took over and replied in the WhatsApp inbox");
await page.screenshot({ path: `${SHOTS}/7-whatsapp.png` });
await clickText("button", "Devolver al bot");
await clickText('[role="tab"]', "Agenda");

// Flight tracking: STT-DEM001's flight is late → suggested pickup in the drawer
await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => x.innerText.trim() === "Mañana"); b && b.click(); });
await page.waitForFunction(() => document.body.innerText.includes("STT-DEM001"));
await clickText('[role="tab"]', "Reservas");
await clickText("tr, button, [role=button]", "STT-DEM001");
await page.waitForSelector('[data-testid="pickup-proposal"]');
assert(await page.$eval('[data-testid="pickup-proposal"]', (e) => e.innerText.includes("+45 min") && e.innerText.includes("Aprobar")), "suggested pickup from a late flight, waiting for approval");
await page.screenshot({ path: `${SHOTS}/14-pickup-proposal.png` });
await page.keyboard.press("Escape");
await clickText('[role="tab"]', "Agenda");

// Airport timetable (same panel as the driver app's Vuelos tab)
await clickText('[role="tab"]', "Vuelos");
await page.waitForSelector('[data-testid="flight-board"] li');
assert(await page.$eval('[data-testid="flight-board"]', (e) => e.innerText.includes("Mendoza") && e.innerText.includes("Demorado")), "EZE arrivals board with live status");
await page.type('input[aria-label="Buscar vuelo"]', "ar 1303");
await page.waitForFunction(() => document.querySelectorAll('[data-testid="flight-board"] li').length === 1);
assert(true, "board search by flight number");
await page.screenshot({ path: `${SHOTS}/12-flights.png` });
await page.click('input[aria-label="Buscar vuelo"]', { clickCount: 3 });
await page.keyboard.press("Backspace");
await clickText('[data-testid="flights"] button', "AEP");
await page.waitForFunction(() => document.querySelector('[data-testid="flight-board"]').innerText.includes("Bariloche"));
await page.setViewport({ width: 390, height: 844 });   // isMobile would reload the page and drop demo state
await page.screenshot({ path: `${SHOTS}/13-flights-phone.png` });
await page.setViewport({ width: 1440, height: 900 });

// Choferes: documents (expiring / missing) and pay; Informes
await clickText('[role="tab"]', "Choferes");
// Choferes → Plantel: applications to approve, "+ Nuevo chofer" with an invitation link
await page.waitForSelector('[data-testid="driver-roster"]');
assert(await page.$eval('[data-testid="driver-roster"]', (e) => e.innerText.includes("Ana Ruiz") && e.innerText.includes("Solicitud")), "driver applications show in Plantel");
await clickText('[data-testid="driver-row-Ana Ruiz"] button', "Aprobar");
await page.waitForFunction(() => document.querySelector('[data-testid="driver-roster"]')?.innerText.includes("Ana Ruiz aprobado"));
assert(true, "dispatch approves an application");
await page.click('[data-testid="new-driver"]');
await page.waitForSelector('[data-testid="driver-form"]');
await page.type('[data-testid="driver-name"]', "Pedro Gómez");
await page.$eval('[data-testid="driver-phone"]', (e) => { e.value = ""; });
await page.type('[data-testid="driver-phone"]', "+54 9 11 5555-0101");
await page.type('[data-testid="driver-plate"]', "ab 123 zz");
await page.click('[data-testid="driver-save"]');
await page.waitForSelector('[data-testid="invite-dialog"]');
assert(await page.$eval('[data-testid="invite-link"]', (e) => /\/chofer\?invite=[0-9a-z]{64}/.test(e.innerText)), "new driver gets a one-time invitation link");
await page.screenshot({ path: `${SHOTS}/7e-driver-invite.png` });
await clickText('[data-testid="invite-dialog"] button', "Cerrar");
await page.waitForFunction(() => document.querySelector('[data-testid="driver-row-Pedro Gómez"]')?.innerText.includes("AB123ZZ"));
assert(true, "new driver listed with their vehicle");
await clickText('[data-testid="drivers-admin"] [role="tab"]', "Documentación");
await page.waitForSelector('[data-testid="doc-row"]');
assert(await page.$eval('[data-testid="drivers-admin"]', (e) => e.innerText.includes("Falta") && e.innerText.includes("Venció") && e.innerText.includes("Solo avisos")), "documents table shows missing and expired documents, warn-only by default");
await clickText('[data-testid="doc-row"] button', "Falta");
await page.waitForSelector('[data-testid="doc-form"]');
await page.type('[data-testid="doc-form"] input[aria-label="Vencimiento"]', "01012031");
await clickText('[data-testid="doc-form"] button', "Guardar");
await page.waitForFunction(() => !document.querySelector('[data-testid="doc-form"]') && ![...document.querySelectorAll('[data-testid="doc-row"] button')].some((b) => b.textContent === "Falta"));
assert(true, "missing document recorded");
await page.screenshot({ path: `${SHOTS}/15-documents.png`, fullPage: true });
await clickText('[data-testid="drivers-admin"] [role="tab"]', "Pagos");
await page.waitForSelector('[data-testid="pay-row"]');
await page.click('[data-testid="pay-row"]');
await page.waitForSelector('[data-testid="statement"]');
assert(await page.$eval('[data-testid="statement"]', (e) => e.innerText.includes("Efectivo cobrado") && /A pagar|Debe rendir/.test(e.innerText)), "driver statement with cash netted off");
await page.click('[data-testid="settle"]');
await page.waitForFunction(() => document.querySelector('[data-testid="pay-row"]').innerText.includes("Sin pendientes"));
assert(true, "settlement closes the balance");
await clickText('[role="tab"]', "Cuentas");
await page.waitForSelector('[data-testid="account-row"]');
await page.click('[data-testid="account-row"]');
await page.waitForSelector('[data-testid="account-detail"]');
await page.click('[data-testid="generate-invoice"]');
await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="invoice-row"]')].some((r) => r.innerText.includes("Borrador")));
assert(true, "monthly invoice drafted for a hotel account");
await clickText('[data-testid="invoice-row"] button', "Emitir");
await page.waitForFunction(() => document.querySelector('[data-testid="invoice-row"]').innerText.includes("Emitida"));
assert(true, "invoice issued");
await page.screenshot({ path: `${SHOTS}/18-accounts.png`, fullPage: true });
await clickText('[role="tab"]', "Informes");
await page.waitForSelector('[data-testid="reports"] [role="img"]');
assert(await page.$eval('[data-testid="reports"]', (e) => /por canal/i.test(e.innerText) && /reservas/i.test(e.innerText)), "reports dashboard");
await page.screenshot({ path: `${SHOTS}/16-reports.png`, fullPage: true });
await clickText('[role="tab"]', "Agenda");

// Calls in Despacho: 3-way switch; answering pops the booking form (caller prefilled) next to the caller's history
await page.click('[data-testid="call-mode"] [data-mode="smart"]');
await page.waitForSelector('[data-testid="ring-seconds"]');
assert(true, "Despacho can switch calls to Central + Sofía back-up (ring time shown)");
await page.click('[data-testid="call-mode"] [data-mode="desk"]');
await page.click('[data-testid="simulate-call"]');
await page.waitForSelector('[data-testid="call-ringing"]');
await clickText('[data-testid="call-ringing"] button', "Atender");
await page.waitForSelector('[data-testid="call-sheet"] [data-testid="zone"]');
await page.select('[data-testid="call-sheet"] [data-testid="zone"]', "recoleta");
await page.type('[data-testid="call-sheet"] [data-testid="address"]', "Av. Alvear 1891");
await page.type('[data-testid="call-sheet"] [data-testid="flight"]', "LA4521");
await page.click('[data-testid="call-sheet"] [data-testid="get-quote"]');
await page.waitForSelector('[data-testid="call-sheet"] [data-testid="submit-booking"]');
assert(await page.$eval('[data-testid="call-sheet"] input[type="tel"]', (e) => e.value === "+5491155550002")
  && await page.$eval('[data-testid="call-sheet"] input[autocomplete="name"]', (e) => e.value === "Familia Pereyra"), "answering in Despacho opens the booking form with the caller filled in");
await page.waitForFunction(() => document.querySelector('[data-testid="call-sheet-history"]')?.innerText.includes("STT-DEM002"));
assert(true, "the caller's history shows next to the form");
await page.screenshot({ path: `${SHOTS}/7d-call-sheet.png` });
await clickText('[data-testid="call-sheet"] button', "Cerrar");
await clickText("button", "Colgar");
await page.waitForFunction(() => !document.body.innerText.includes("En llamada ·"));

// Central de reservas: manual mode, a WhatsApp call, a booking taken during the call, sent to dispatch
await clickText("a", "Central");
await page.waitForSelector('[data-testid="desk-mode"]');
await clickText('[data-testid="desk-mode"] button', "Manual");
await page.waitForFunction(() => document.body.innerText.includes("Modo manual"));
await page.click('[data-testid="simulate-call"]');
await page.waitForSelector('[data-testid="call-ringing"]');
assert(await page.$eval('[data-testid="call-ringing"]', (e) => e.innerText.includes("Familia Pereyra")), "incoming WhatsApp call rings with caller name");
await page.screenshot({ path: `${SHOTS}/8-call-ringing.png` });
await clickText('[data-testid="call-ringing"] button', "Atender");
await page.waitForFunction(() => document.body.innerText.includes("En llamada"));
await clickText("button", "Reserva para este cliente");
await page.waitForSelector('[data-testid="zone"]');
await page.select('[data-testid="zone"]', "recoleta");
await page.type('[data-testid="address"]', "Av. Alvear 1891");
await page.type('[data-testid="flight"]', "LA4521");
await page.click('[data-testid="get-quote"]');
await page.waitForSelector('[data-testid="submit-booking"]');
assert(await page.$eval('input[type="tel"]', (e) => e.value === "+5491155550002") && await page.$eval('input[autocomplete="name"]', (e) => e.value === "Familia Pereyra"), "caller's name and phone prefilled in the booking");
await page.click('[data-testid="submit-booking"]');
await page.waitForSelector('[data-testid="booking-ref"]');
const deskRef = await page.$eval('[data-testid="booking-ref"]', (e) => e.textContent);
await page.screenshot({ path: `${SHOTS}/9-call-booking.png` });
await clickText("button", "Colgar");
await clickText('[role="tab"]', "Entrantes");
await page.waitForSelector(`[data-testid="desk-${deskRef}"]`, { timeout: 8000 }).catch(async (e) => {
  console.log("DEBUG", deskRef, (await page.evaluate(() => document.body.innerText)).slice(0, 2500));
  throw e;
});
assert(true, `phone booking ${deskRef} waits at the desk in manual mode`);
await page.screenshot({ path: `${SHOTS}/10-desk-queue.png` });
await page.click(`[data-testid="desk-${deskRef}"] [data-testid="send-board"]`);
await page.waitForFunction((r) => document.body.innerText.includes(`${r} enviada a despacho`), {}, deskRef);
assert(!(await page.$(`[data-testid="desk-${deskRef}"]`)), "sent to dispatch (job board) and left the queue");
// Voice bot mode: Sofía answers; what she can't solve lands under "Para devolver la llamada"
await page.click('[data-testid="call-mode"] [data-mode="bot"]');
await page.waitForFunction(() => document.body.innerText.includes("atiende Sofía"));
await page.click('[data-testid="simulate-call"]');
await page.waitForSelector('[data-testid="transfer-card"]');
assert(await page.$eval('[data-testid="transfer-card"]', (e) => e.innerText.includes("Sofía te pasa una llamada") && e.innerText.includes("dirección")), "Sofía is transferring a call to the Central");
await page.screenshot({ path: `${SHOTS}/17-transfer.png` });
await clickText('[data-testid="transfer-card"] button', "Historial");
await page.waitForSelector('[data-testid="past-calls"]');
assert(await page.$eval('[data-testid="past-calls"]', (e) => e.innerText.includes("silla de bebé")), "caller history shows previous calls with Sofía's note");
await clickText("button", "Cerrar");
await clickText('[data-testid="transfer-card"] button', "Atender");
await page.waitForFunction(() => document.querySelector('[data-testid="transfer-calls"] [role="alert"]'));
assert(true, "demo explains the transfer needs live audio");
await clickText('[role="tab"]', "Llamadas");
await page.waitForSelector('[data-testid="callbacks"]');
assert(await page.$eval('[data-testid="callbacks"]', (e) => e.innerText.includes("silla de ruedas")), "bot call left a callback request with its note");
await page.screenshot({ path: `${SHOTS}/11-voice-bot-calls.png` });
await clickText('[data-testid="callbacks"] button', "Listo, ya lo contactamos");
await page.waitForFunction(() => !document.querySelector('[data-testid="callbacks"]'));
assert(true, "callback marked as done");
await clickText('[data-testid="call-mode"] button', "Central");
await clickText('[role="tab"]', "Entrantes");
await clickText('[data-testid="desk-mode"] button', "Auto");
await clickText("a", "Despacho");
await page.waitForSelector('[data-testid="schedule"]');

await page.evaluate(() => { history.pushState({}, "", "/despacho/nueva"); dispatchEvent(new PopStateEvent("popstate")); });
await page.waitForSelector('[data-testid="zone"]');
await page.select('[data-testid="zone"]', "recoleta");
await page.type('[data-testid="address"]', "Av. Alvear 1891");
await page.click('[data-testid="get-quote"]');
await page.waitForSelector('[data-testid="flight-exception"]');
await page.type('input[autocomplete="name"]', "Pasajero Telefónico");
await page.type('input[type="tel"]', "+5491155550099");
await page.click('[data-testid="submit-booking"]');
await page.waitForFunction(() => document.body.innerText.includes("Falta el número de vuelo"));
assert(true, "staff booking without flight requires a reason");
await page.type('[data-testid="flight-exception"]', "Vuelo privado");
await page.click('[data-testid="submit-booking"]');
await page.waitForSelector('[data-testid="booking-ref"]');
assert(true, "staff booking with exception reason created");
const staffRef = await page.$eval('[data-testid="booking-ref"]', (e) => e.innerText.trim());
await clickText("button", "Volver a despacho");
await page.waitForSelector('[data-testid="schedule"]');
// New-booking alert: the booking just made pops up in Despacho with its channel, and opens on its day.
await page.waitForSelector(`[data-testid="new-booking-${staffRef}"]`, { timeout: 8000 });
assert(await page.$eval(`[data-testid="new-booking-${staffRef}"]`, (e) => /nueva reserva/i.test(e.innerText) && e.innerText.includes("Central")), "new booking alert shows in Despacho");
await page.screenshot({ path: `${SHOTS}/7c-new-booking.png` });
await clickText(`[data-testid="new-booking-${staffRef}"] button`, "Ver reserva");
await page.waitForFunction((r) => document.querySelector('[role="dialog"]')?.innerText.includes(r), {}, staffRef);
assert(true, "Ver reserva opens the new booking on its day");
await page.keyboard.press("Escape");

// Mobile form
await page.setViewport({ width: 390, height: 844 });   // isMobile would reload the page and drop demo state
await page.goto(BASE + "/", { waitUntil: "networkidle0" });
await page.evaluate(() => localStorage.setItem("stt_locale", "es-AR"));
await page.reload({ waitUntil: "networkidle0" });
await page.screenshot({ path: `${SHOTS}/8-mobile-es.png`, fullPage: true });

assert(errors.length === 0, `no console errors ${errors.join(" | ")}`);
// /conexion: first-admin form (signed out) — the keys form needs a live admin session.
await page.goto(`${BASE}/conexion`, { waitUntil: "networkidle0" });
await page.waitForSelector('[data-testid="bootstrap"]');
assert(await page.$eval('[data-testid="bootstrap"]', (e) => /código de configuración/i.test(e.innerText)), "/conexion offers the first-admin form");

await browser.close();
console.log("SMOKE PASS");
