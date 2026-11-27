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
const clickText = async (sel, text) => {
  const h = await page.waitForFunction((s, t) => [...document.querySelectorAll(s)].find((e) => e.textContent.includes(t)), {}, sel, text);
  await h.asElement().click();
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
await clickText("button", "Volver a despacho");
await page.waitForSelector('[data-testid="schedule"]');

// Mobile form
await page.setViewport({ width: 390, height: 844, isMobile: true });
await page.goto(BASE + "/", { waitUntil: "networkidle0" });
await page.evaluate(() => localStorage.setItem("stt_locale", "es-AR"));
await page.reload({ waitUntil: "networkidle0" });
await page.screenshot({ path: `${SHOTS}/8-mobile-es.png`, fullPage: true });

assert(errors.length === 0, `no console errors ${errors.join(" | ")}`);
await browser.close();
console.log("SMOKE PASS");
