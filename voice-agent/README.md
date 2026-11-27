# SoyTuTaxi voice bot on the BCU LiveKit server

Files:
- `soytutaxi_voice_agent.py`: the assistant. Copy it to `/opt/bcu-livekit/` next to `agent.py`.
- `test_soytutaxi_voice_agent.py`: tests (`/opt/bcu-livekit/.venv/bin/python -m unittest test_soytutaxi_voice_agent`).

Hook in `/opt/bcu-livekit/agent.py`, inside `entrypoint`, right after the `call attrs` log line and before
`selected_assistant(...)`. It is guarded, so a problem in this module can never stop the other lines:

```python
    # BEGIN soytutaxi voice bot (bcu_assistant=soytutaxi only)
    try:
        from soytutaxi_voice_agent import selected as stt_selected, run_call as stt_call
    except Exception as exc:  # noqa: BLE001
        stt_selected = None
        log.warning("soytutaxi module unavailable (%s)", type(exc).__name__)
    if stt_selected and stt_selected(caller.attributes):
        try:
            await stt_call(ctx, caller)
        except Exception as exc:  # noqa: BLE001
            log.warning("soytutaxi voice stopped (%s: %s)", type(exc).__name__, exc)
        try:
            await ctx.api.room.delete_room(api.DeleteRoomRequest(room=ctx.room.name))
        except Exception as exc:  # noqa: BLE001
            log.warning("soytutaxi room cleanup (%s)", type(exc).__name__)
        return
    # END soytutaxi voice bot.
```

Then restart `bcu-livekit.service` at a quiet moment (live calls on that service drop).
