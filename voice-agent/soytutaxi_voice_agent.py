"""SoyTuTaxi WhatsApp voice bot ("Sofía"), run by the BCU LiveKit worker (agent.py, agent name "bcu-taxi").

Routing: the SoyTuTaxi `whatsapp` Edge Function hands the WhatsApp call to LiveKit's WhatsApp connector with
participant attributes bcu_assistant=soytutaxi, caller_phone, caller_name, wa_call_id, stt_token, stt_api and
stt_voice. agent.py calls run_call() for those calls only; every other line on this server is unchanged.

Pipeline: Silero VAD + OpenAI transcription (Spanish/English, auto-detected) + OpenAI LLM + Fish Audio TTS.
Safety: the bot never prices, books or reads data itself. Each tool posts to stt_api with the per-call token,
and the SoyTuTaxi server prices with the same fare engine as the website, takes the caller's phone number from
the call record (never from the AI) and sends the booking confirmation to the caller's WhatsApp.
"""
import asyncio
import json
import logging
import os

import aiohttp

log = logging.getLogger("bcu-livekit.soytutaxi")
ASSISTANT = "soytutaxi"
# Fish voice: per-operator choice from the Central (stt_voice), else server env, else Fish's default voice.
DEFAULT_VOICE = os.environ.get("SOYTUTAXI_FISH_VOICE", "")
FISH_MODEL = os.environ.get("SOYTUTAXI_FISH_MODEL", "s2.1-pro")
LLM_MODEL = os.environ.get("SOYTUTAXI_LLM_MODEL", "gpt-4.1-mini")
STT_MODEL = os.environ.get("SOYTUTAXI_STT_MODEL", "gpt-4o-transcribe")
KEYTERMS = ["SoyTuTaxi", "Ezeiza", "Aeroparque", "Jorge Newbery", "Aerolíneas Argentinas", "LATAM", "Flybondi", "JetSMART",
            "Palermo", "Recoleta", "Microcentro", "Puerto Madero", "Belgrano", "Tigre", "Retiro", "San Telmo",
            "valijas", "equipaje de mano", "minivan", "TaxiBus"]


def selected(attributes) -> bool:
    """Only SoyTuTaxi calls that carry a tool URL and token (set by the SoyTuTaxi webhook)."""
    a = attributes or {}
    return (a.get("bcu_assistant") == ASSISTANT and str(a.get("stt_api", "")).startswith("https://")
            and len(str(a.get("stt_token", ""))) >= 20 and bool(a.get("wa_call_id")))


def greeting(facts) -> str:
    name = (facts.get("callerName") or "").split(" ")[0]
    hola = f"¡Hola{(' ' + name) if name else ''}!"
    return (f"{hola} Gracias por llamar a SoyTuTaxi, traslados con tarifa fija desde y hacia Ezeiza y Aeroparque. "
            "Soy Sofía, la asistente virtual. ¿En qué te puedo ayudar? You can also speak English.")


def build_prompt(facts) -> str:
    """System prompt: persona, call rules, and the operator's real facts (no invented prices or policies)."""
    rules = facts.get("rules") or {}
    demo = ("\nIMPORTANT: this is a TEST service with demo prices; say so once when you give the first price."
            if facts.get("demo") else "")
    return f"""You are Sofía, the phone assistant of SoyTuTaxi, an airport transfer company in Buenos Aires.
You are on a WhatsApp voice call. Right now in Buenos Aires it is {facts.get('now')} (today = {facts.get('today')}).

LANGUAGE: speak Rioplatense Spanish (use "vos", warm and polite). If the caller speaks English, switch to English
and pass language="en" to the tools; otherwise pass language="es".

STYLE: this is a phone call. Use short sentences, one question at a time, no lists, no emojis, no markdown.
Say prices exactly as the tools return them. Say dates naturally ("el sábado 28 a las 7 y 40").

WHAT YOU CAN DO:
1. Book a transfer between an airport (Ezeiza EZE or Aeroparque AEP) and a city zone. Collect: direction (from or
   to the airport), airport, zone, street address or hotel, date, time (for arrivals: the flight's SCHEDULED
   landing time and the flight number), number of passengers, large suitcases and carry-on bags. Then call
   get_quote. If it returns problems, explain them simply and ask again. Read back the trip and the price and
   ask "¿Lo confirmo?". Only after a clear yes, ask the name for the booking and how they will pay (only the
   payment options get_quote returned), then call book_trip. Tell them the reference using the "spoken" field,
   that it is NOT confirmed until a driver accepts it, and that the details and status link are on their WhatsApp.
2. Tell callers about their bookings with my_bookings (only bookings of the number they are calling from).
3. Answer questions using ONLY the facts below. If you don't know, or they want to change or cancel a booking,
   complain, have a special request (child seat, pets, wheelchair…), or ask for a person: say a team member will
   contact them on WhatsApp, then call leave_note with a one-line summary and callback=true.
Never invent prices, times, drivers or policies. Never ask for card numbers or the phone number (we already have it).
When the caller is done, say a short goodbye and call end_call.{demo}

FACTS:
Airports and meeting points: {json.dumps(facts.get('airports', []), ensure_ascii=False)}
City zones we serve (use these names): {', '.join(z['name'] for z in facts.get('zones', []))}
Vehicles (max passengers / large suitcases / carry-ons): {json.dumps(facts.get('vehicles', []), ensure_ascii=False)}
Booking needs at least {rules.get('leadTimeHours')} hours' notice and up to {rules.get('maxAdvanceDays')} days ahead.
Free cancellation until {rules.get('freeCancellationHoursBefore')} hours before pickup; later, {rules.get('refundPercentAfter')}% refund.
Free waiting time: {rules.get('freeWaitAirportMinutes')} min at the airport, {rules.get('freeWaitCityMinutes')} min in the city.
Arrivals: we track the flight; the driver meets them this many minutes after scheduled landing: {json.dumps(rules.get('arrivalPickupBufferMinutes', {}))}.
Payment options: {', '.join(rules.get('paymentModes', []))}.
Fares are fixed per zone and vehicle; get_quote gives the exact price.
Caller's upcoming bookings: {json.dumps(facts.get('upcomingBookings', []), ensure_ascii=False)}
"""


class Tools:
    """Thin client for the SoyTuTaxi /voice-tool route. The token only works for this call."""

    def __init__(self, http, attributes):
        self.http = http
        self.url = attributes["stt_api"]
        self.call_id = attributes["wa_call_id"]
        self.token = attributes["stt_token"]

    def body(self, action, args=None, language="es"):
        return {"callId": self.call_id, "token": self.token, "action": action, "args": args or {},
                "language": "en" if language == "en" else "es"}

    async def post(self, action, args=None, language="es"):
        try:
            async with self.http.post(self.url, json=self.body(action, args, language),
                                      timeout=aiohttp.ClientTimeout(total=12)) as r:
                data = await r.json(content_type=None)
                if r.status != 200:
                    log.warning("soytutaxi tool %s → %s", action, r.status)
                    return {"ok": False, "say": "The booking system didn't answer. Apologise and offer a WhatsApp callback."}
                return data
        except Exception as exc:  # noqa: BLE001
            log.warning("soytutaxi tool %s failed (%s)", action, type(exc).__name__)
            return {"ok": False, "say": "The booking system didn't answer. Apologise and offer a WhatsApp callback."}


def quote_args(direction, airport, zone, address, date, time, passengers, large_bags, carry_on, flight, vehicle):
    return {"direction": direction, "airport": (airport or "").upper()[:3], "zone": zone, "address": address,
            "date": date, "time": time, "passengers": passengers, "largeBags": large_bags, "carryOn": carry_on,
            "flight": flight or "", "vehicleClass": vehicle or ""}


async def run_call(ctx, caller):
    from livekit.agents import Agent, AgentSession, RoomInputOptions, function_tool
    from livekit.plugins import fishaudio, openai, silero

    attrs = dict(caller.attributes)
    done = asyncio.Event()
    async with aiohttp.ClientSession() as http:
        tools = Tools(http, attrs)
        facts = await tools.post("config")
        if not facts or "zones" not in facts:
            raise RuntimeError("soytutaxi_config_unavailable")
        voice = attrs.get("stt_voice") or DEFAULT_VOICE

        class Sofia(Agent):
            def __init__(self):
                super().__init__(instructions=build_prompt(facts))

            @function_tool
            async def get_quote(self, direction: str, airport: str, zone: str, address: str, date: str, time: str,
                                passengers: int, large_bags: int, carry_on: int = 0, flight: str = "",
                                vehicle: str = "", language: str = "es") -> str:
                """Price a transfer. Call it once you have all the trip details.

                Args:
                    direction: "from_airport" (arriving, going into the city) or "to_airport" (catching a flight).
                    airport: "EZE" (Ezeiza) or "AEP" (Aeroparque).
                    zone: city zone name from the facts list.
                    address: street and number, or hotel name.
                    date: YYYY-MM-DD.
                    time: HH:MM 24h. For arrivals, the flight's scheduled landing time; otherwise the pickup time.
                    passengers: number of people.
                    large_bags: large suitcases.
                    carry_on: carry-on bags.
                    flight: flight number for arrivals, e.g. AR1303.
                    vehicle: optional vehicle code to change vehicle (from otherVehicles of a previous quote).
                    language: "es" or "en".
                """
                r = await tools.post("quote", quote_args(direction, airport, zone, address, date, time, passengers,
                                                         large_bags, carry_on, flight, vehicle), language)
                return json.dumps(r, ensure_ascii=False)

            @function_tool
            async def book_trip(self, quote_id: str, name: str, payment_mode: str, notes: str = "",
                                language: str = "es") -> str:
                """Register the booking. ONLY after the caller clearly said yes to the price read-back.

                Args:
                    quote_id: quoteId from get_quote.
                    name: name for the booking.
                    payment_mode: one of the paymentModes codes from get_quote.
                    notes: short note for the driver, if any.
                    language: "es" or "en".
                """
                r = await tools.post("book", {"quoteId": quote_id, "name": name, "paymentMode": payment_mode,
                                              "notes": notes}, language)
                return json.dumps(r, ensure_ascii=False)

            @function_tool
            async def my_bookings(self, language: str = "es") -> str:
                """List the caller's upcoming bookings (for the number they are calling from).

                Args:
                    language: "es" or "en".
                """
                return json.dumps(await tools.post("bookings", {}, language), ensure_ascii=False)

            @function_tool
            async def leave_note(self, note: str, callback: bool = True) -> str:
                """Leave a note for the SoyTuTaxi team (changes, cancellations, complaints, special requests, a person).

                Args:
                    note: one-line summary of what the caller needs.
                    callback: true if a person should contact them on WhatsApp.
                """
                return json.dumps(await tools.post("note", {"note": note, "callback": callback}), ensure_ascii=False)

            @function_tool
            async def end_call(self) -> str:
                """Hang up after you have said goodbye."""
                done.set()
                return "ok"

        tts_args = dict(api_key=os.environ.get("FISH_AUDIO_API_KEY"), model=FISH_MODEL, output_format="pcm",
                        sample_rate=24000, latency_mode="balanced", http_session=http)
        if voice:
            tts_args["voice_id"] = voice
        session = AgentSession(
            vad=silero.VAD.load(),
            stt=openai.STT(model=STT_MODEL, language="es", detect_language=True,
                           prompt="Llamada a una empresa de traslados al aeropuerto en Buenos Aires. " + ", ".join(KEYTERMS)),
            llm=openai.LLM(model=LLM_MODEL, temperature=0.3),
            tts=fishaudio.TTS(**tts_args),
        )
        room = ctx.room
        room.on("participant_disconnected", lambda p: p.identity == caller.identity and done.set())
        session.on("close", lambda *_: done.set())
        await session.start(agent=Sofia(), room=room,
                            room_input_options=RoomInputOptions(participant_identity=caller.identity,
                                                                close_on_disconnect=True))
        log.info("soytutaxi call started voice=%s", (voice or "default")[:6])
        await session.say(greeting(facts), allow_interruptions=True)
        try:
            await done.wait()
            await asyncio.sleep(1.5)   # let the goodbye finish playing
        finally:
            try:
                await session.aclose()
            except Exception:  # noqa: BLE001
                pass
            log.info("soytutaxi call ended")
