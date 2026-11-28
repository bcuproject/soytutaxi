import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import soytutaxi_voice_agent as stt

ATTRS = {"bcu_assistant": "soytutaxi", "stt_api": "https://x.supabase.co/functions/v1/whatsapp/voice-tool",
         "stt_token": "t" * 43, "wa_call_id": "wacid.1", "caller_phone": "+5491100007777", "stt_voice": ""}
FACTS = {"operator": "SoyTuTaxi", "demo": True, "now": "viernes, 27 de noviembre, 08:00", "today": "2026-11-27",
         "callerName": "Ana María", "airports": [{"code": "EZE", "name": "Ezeiza", "meetingPointEs": "Hall A"}],
         "zones": [{"code": "palermo", "name": "Palermo"}, {"code": "recoleta", "name": "Recoleta"}],
         "vehicles": [{"code": "sedan_premium", "es": "Sedán", "maxPassengers": 3}],
         "rules": {"leadTimeHours": 3, "maxAdvanceDays": 180, "freeCancellationHoursBefore": 24, "refundPercentAfter": 50,
                   "freeWaitAirportMinutes": 60, "freeWaitCityMinutes": 15, "arrivalPickupBufferMinutes": {"EZE": 60},
                   "paymentModes": ["prepaid", "pay_on_pickup_cash"]},
         "upcomingBookings": []}


class Selection(unittest.TestCase):
    def test_only_soytutaxi_calls_with_tool_access(self):
        self.assertTrue(stt.selected(ATTRS))
        self.assertFalse(stt.selected({**ATTRS, "bcu_assistant": "taxi"}))
        self.assertFalse(stt.selected({**ATTRS, "stt_api": "http://insecure"}))
        self.assertFalse(stt.selected({**ATTRS, "stt_token": "short"}))
        self.assertFalse(stt.selected({}))
        self.assertFalse(stt.selected(None))


class PromptAndGreeting(unittest.TestCase):
    def test_prompt_carries_real_facts_and_rules(self):
        p = stt.build_prompt(FACTS)
        for needle in ("Palermo, Recoleta", "at least 3 hours", "Free cancellation until 24 hours", "Hall A",
                       "TEST service", "leave_note", "transfer_to_person", "NOT confirmed", "Never ask for card numbers"):
            self.assertIn(needle, p)

    def test_greeting_uses_first_name_and_offers_english(self):
        g = stt.greeting(FACTS)
        self.assertTrue(g.startswith("¡Hola Ana!"))
        self.assertIn("English", g)
        self.assertTrue(stt.greeting({}).startswith("¡Hola!"))

    def test_tool_body_never_contains_phone(self):
        tools = stt.Tools(None, ATTRS)
        b = tools.body("book", {"quoteId": "q"}, "en")
        self.assertEqual(b, {"callId": "wacid.1", "token": "t" * 43, "action": "book", "args": {"quoteId": "q"}, "language": "en"})
        self.assertNotIn("+549", json.dumps(b))
        self.assertEqual(stt.quote_args("to_airport", "eze", "Palermo", "Gorriti 4800", "2026-11-29", "09:00", 2, 2, 1, "", "")["airport"], "EZE")


class Session(unittest.IsolatedAsyncioTestCase):
    async def test_session_starts_greets_and_exposes_strict_tools(self):
        from livekit.agents.llm.utils import build_strict_openai_schema
        from livekit.plugins import fishaudio, openai, silero

        captured, said, stt_kwargs, tts_kwargs = [], [], {}, {}

        class FakeSession:
            def __init__(self, **kwargs):
                pass

            def on(self, event, cb):
                self.cb = cb

            async def start(self, *, agent, **kwargs):
                captured.extend(build_strict_openai_schema(t) for t in agent.tools)
                self.agent = agent

            async def say(self, text, **kwargs):
                said.append(text)
                self.cb()

            async def aclose(self):
                pass

        room = SimpleNamespace(on=lambda *a: None)
        caller = SimpleNamespace(identity="caller-1", attributes={**ATTRS, "stt_voice": "voice12345"})
        with patch("livekit.agents.AgentSession", FakeSession), \
                patch.object(stt.Tools, "post", AsyncMock(return_value=FACTS)), \
                patch.object(openai, "STT", side_effect=lambda **k: stt_kwargs.update(k)), patch.object(openai, "LLM"), \
                patch.object(fishaudio, "TTS", side_effect=lambda **k: tts_kwargs.update(k)), patch.object(silero.VAD, "load"), \
                patch.object(stt.asyncio, "sleep", AsyncMock()):
            await stt.run_call(SimpleNamespace(room=room), caller)

        names = sorted(t["function"]["name"] for t in captured)
        self.assertEqual(names, ["book_trip", "cancel_booking", "end_call", "get_quote", "leave_note", "my_bookings", "transfer_to_person"])
        for t in captured:
            self.assertIs(t["function"]["parameters"].get("additionalProperties"), False)
        self.assertTrue(said and said[0].startswith("¡Hola Ana!"))
        self.assertTrue(stt_kwargs["detect_language"])
        self.assertEqual(tts_kwargs["voice_id"], "voice12345")
        self.assertEqual(tts_kwargs["output_format"], "pcm")

    async def _call_with_transfer(self, desk_joins):
        import asyncio
        from livekit.plugins import fishaudio, openai, silero
        handlers, state = {}, {"closed": 0, "replies": []}
        started = asyncio.Event()

        class FakeSession:
            def __init__(self, **kwargs):
                pass

            def on(self, event, cb):
                handlers["close"] = cb

            async def start(self, *, agent, **kwargs):
                self.agent = agent
                state["agent"] = agent

            async def say(self, text, **kwargs):
                started.set()

            def generate_reply(self, **kwargs):
                state["replies"].append(kwargs["instructions"])

            async def aclose(self):
                state["closed"] += 1
                handlers["close"]()

        room = SimpleNamespace(on=lambda ev, cb: handlers.__setitem__(ev, cb))
        caller = SimpleNamespace(identity="caller-1", attributes=ATTRS)
        posts = []

        async def post(_self, action, args=None, language="es"):
            posts.append(action)
            return FACTS if action == "config" else {"ok": True}

        with patch("livekit.agents.AgentSession", FakeSession), patch.object(stt.Tools, "post", post), \
                patch.object(openai, "STT"), patch.object(openai, "LLM"), patch.object(fishaudio, "TTS"), \
                patch.object(silero.VAD, "load"), patch.object(stt, "TRANSFER_WAIT_S", 0.05):
            task = asyncio.create_task(stt.run_call(SimpleNamespace(room=room), caller))
            await started.wait()
            out = json.loads(await state["agent"].transfer_to_person("Quiere hablar con alguien"))
            self.assertTrue(out["ok"])
            if desk_joins:
                handlers["participant_connected"](SimpleNamespace(identity="desk-u1"))
                await asyncio.sleep(0.01)
                self.assertFalse(task.done())                     # Sofía left, the call goes on
                handlers["participant_disconnected"](SimpleNamespace(identity="desk-u1"))
            else:
                await asyncio.sleep(0.15)
                handlers["participant_disconnected"](SimpleNamespace(identity="caller-1"))
            await asyncio.wait_for(task, 3)
        return posts, state

    async def test_transfer_hands_over_when_a_person_joins(self):
        posts, state = await self._call_with_transfer(desk_joins=True)
        self.assertIn("transfer", posts)
        self.assertNotIn("transfer_failed", posts)
        self.assertGreaterEqual(state["closed"], 1)

    async def test_transfer_times_out_and_sofia_takes_the_call_back(self):
        posts, state = await self._call_with_transfer(desk_joins=False)
        self.assertIn("transfer_failed", posts)
        self.assertTrue(state["replies"] and "WhatsApp" in state["replies"][0])

    def test_memory_in_greeting_and_prompt(self):
        facts = dict(FACTS, customer={"previousCalls": [{"when": "viernes 27 de noviembre, 18:10", "note": "Pregunta por silla de bebé"}],
                                      "bookings": [{"reference": "STT-AB12CD", "driver": {"name": "Carlos", "plate": "AB123CD"}}]})
        self.assertTrue(stt.greeting(facts).startswith("¡Hola de nuevo"))
        p = stt.build_prompt(facts)
        self.assertIn("silla de bebé", p)
        self.assertIn("AB123CD", p)
        self.assertFalse(stt.greeting(FACTS).startswith("¡Hola de nuevo"))

    async def test_transcript_is_saved_at_the_end(self):
        item = lambda role, text: SimpleNamespace(type="message", role=role, text_content=text)
        session = SimpleNamespace(history=SimpleNamespace(items=[
            item("system", "x"), item("assistant", "¡Hola! Soy Sofía."), item("user", "Quiero cancelar mi viaje"),
            SimpleNamespace(type="function_call"), item("assistant", "Listo, quedó cancelada.")]))
        self.assertEqual(stt.transcript_text(session), "Sofía: ¡Hola! Soy Sofía.\nCliente: Quiero cancelar mi viaje\nSofía: Listo, quedó cancelada.")
        posted = []

        class T:
            async def post(self, action, args=None, language="es"):
                posted.append((action, args))
                return {"ok": True}

        await stt.save_transcript(session, T())
        self.assertEqual(posted[0][0], "transcript")
        await stt.save_transcript(SimpleNamespace(), T())     # no history → nothing posted, no error
        self.assertEqual(len(posted), 1)

    async def test_missing_config_aborts_before_answering(self):
        caller = SimpleNamespace(identity="c", attributes=ATTRS)
        with patch.object(stt.Tools, "post", AsyncMock(return_value={"ok": False})):
            with self.assertRaises(RuntimeError):
                await stt.run_call(SimpleNamespace(room=SimpleNamespace(on=lambda *a: None)), caller)


if __name__ == "__main__":
    unittest.main()
