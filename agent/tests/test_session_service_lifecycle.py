"""Session lifecycle invariants: one run per session, honest terminal states."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from src.session.events import EventBus
from src.session.models import Attempt, AttemptStatus
from src.session.service import SessionBusyError, SessionService
from src.session.store import SessionStore


class _DummyIndex:
    def index_session(self, session_id: str, title: str) -> None:
        del session_id, title

    def index_message(self, session_id: str, role: str, content: str) -> None:
        del session_id, role, content


def _service(tmp_path: Path, monkeypatch) -> SessionService:
    monkeypatch.setattr("src.session.service.get_shared_index", lambda: _DummyIndex())
    return SessionService(
        store=SessionStore(tmp_path / "sessions"),
        event_bus=EventBus(),
        runs_dir=tmp_path / "runs",
    )


def _stub_agent(service: SessionService, monkeypatch, result: dict, *, gate=None):
    """Replace _run_with_agent with a stub returning ``result``.

    Args:
        service: Service under test.
        monkeypatch: pytest monkeypatch fixture.
        result: Result dict the fake agent returns.
        gate: Optional asyncio.Event the fake agent waits on before returning,
            used to hold a run in flight while a second send is attempted.
    """

    async def _fake(attempt, messages=None, **kwargs):
        del attempt, messages, kwargs
        if gate is not None:
            await gate.wait()
        return dict(result)

    monkeypatch.setattr(service, "_run_with_agent", _fake)


# ---------------------------------------------------------------------------
# Concurrency
# ---------------------------------------------------------------------------


def test_second_send_is_refused_while_the_first_run_is_in_flight(tmp_path, monkeypatch):
    """The claim is taken synchronously, so no second attempt is ever created."""

    async def scenario() -> None:
        service = _service(tmp_path, monkeypatch)
        session = service.create_session(title="busy")
        gate = asyncio.Event()
        _stub_agent(service, monkeypatch, {"status": "success", "content": "ok"}, gate=gate)

        first = await service.send_message(session.session_id, "one")
        assert first["attempt_id"]

        with pytest.raises(SessionBusyError):
            await service.send_message(session.session_id, "two")

        # The refused send must not have persisted a message or an attempt.
        assert [m.content for m in service.store.get_messages(session.session_id)] == ["one"]
        stored = service.store.get_session(session.session_id)
        assert stored.last_attempt_id == first["attempt_id"]

        gate.set()
        for _ in range(100):
            await asyncio.sleep(0.01)
            if session.session_id not in service._inflight:
                break
        assert session.session_id not in service._inflight

    asyncio.run(scenario())


def test_claim_is_released_after_the_run_finishes(tmp_path, monkeypatch):
    """A sequential second send succeeds once the first run reaches a terminal state."""

    async def scenario() -> None:
        service = _service(tmp_path, monkeypatch)
        session = service.create_session(title="sequential")
        _stub_agent(service, monkeypatch, {"status": "success", "content": "ok"})

        await service.send_message(session.session_id, "one")
        for _ in range(100):
            await asyncio.sleep(0.01)
            if session.session_id not in service._inflight:
                break
        assert session.session_id not in service._inflight

        second = await service.send_message(session.session_id, "two")
        assert second["attempt_id"]

    asyncio.run(scenario())


def test_claim_is_released_when_the_agent_raises(tmp_path, monkeypatch):
    """An exception inside the run must not strand the session as busy."""

    async def scenario() -> None:
        service = _service(tmp_path, monkeypatch)
        session = service.create_session(title="boom")

        async def _explode(attempt, messages=None, **kwargs):
            del attempt, messages, kwargs
            raise RuntimeError("agent exploded")

        monkeypatch.setattr(service, "_run_with_agent", _explode)

        await service.send_message(session.session_id, "one")
        for _ in range(100):
            await asyncio.sleep(0.01)
            if session.session_id not in service._inflight:
                break
        assert session.session_id not in service._inflight
        stored = service.store.get_session(session.session_id)
        attempt = service.store.get_attempt(session.session_id, stored.last_attempt_id)
        assert attempt.status == AttemptStatus.FAILED

    asyncio.run(scenario())


def test_non_user_roles_never_claim_the_session(tmp_path, monkeypatch):
    """System/assistant messages create no attempt, so they must not block sends."""

    async def scenario() -> None:
        service = _service(tmp_path, monkeypatch)
        session = service.create_session(title="notes")
        _stub_agent(service, monkeypatch, {"status": "success", "content": "ok"})

        await service.send_message(session.session_id, "note", role="system")
        assert session.session_id not in service._inflight
        assert await service.send_message(session.session_id, "real")

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# Terminal states
# ---------------------------------------------------------------------------


def test_cancelled_run_is_cancelled_not_failed(tmp_path, monkeypatch):
    """A cooperative cancel gets its own status, event and reply text."""

    async def scenario() -> None:
        service = _service(tmp_path, monkeypatch)
        session = service.create_session(title="cancel")
        seen: list[str] = []
        service.event_bus.emit = lambda sid, event, data: seen.append(event)  # type: ignore[assignment]
        _stub_agent(
            service,
            monkeypatch,
            {"status": "cancelled", "reason": "cancelled by user"},
        )

        await service.send_message(session.session_id, "go")
        for _ in range(100):
            await asyncio.sleep(0.01)
            if session.session_id not in service._inflight:
                break

        stored = service.store.get_session(session.session_id)
        attempt = service.store.get_attempt(session.session_id, stored.last_attempt_id)
        assert attempt.status == AttemptStatus.CANCELLED
        assert "attempt.cancelled" in seen
        assert "attempt.failed" not in seen
        reply = service.store.get_messages(session.session_id)[-1]
        assert reply.content == "Run cancelled."

    asyncio.run(scenario())


def test_metrics_reach_the_attempt_and_the_reply(tmp_path, monkeypatch):
    """Loaded metrics were dropped on the floor before reaching the reply."""

    async def scenario() -> None:
        service = _service(tmp_path, monkeypatch)
        session = service.create_session(title="metrics")
        _stub_agent(
            service,
            monkeypatch,
            {"status": "success", "content": "done", "metrics": {"sharpe": 1.25}},
        )

        await service.send_message(session.session_id, "backtest")
        for _ in range(100):
            await asyncio.sleep(0.01)
            if session.session_id not in service._inflight:
                break

        stored = service.store.get_session(session.session_id)
        attempt = service.store.get_attempt(session.session_id, stored.last_attempt_id)
        assert attempt.metrics == {"sharpe": 1.25}
        reply = service.store.get_messages(session.session_id)[-1]
        assert reply.metadata["metrics"] == {"sharpe": 1.25}

    asyncio.run(scenario())


def test_empty_successful_answer_says_so():
    """An empty answer must not be dressed up as a finished strategy run."""
    attempt = Attempt(session_id="s" * 12, prompt="p")
    attempt.mark_completed(summary="")
    message = SessionService._format_result_message(attempt)
    assert "without producing any text output" in message
    assert "Strategy execution completed" not in message


# ---------------------------------------------------------------------------
# History window
# ---------------------------------------------------------------------------


def test_one_oversized_message_does_not_empty_the_history_window():
    """The newest turn survives truncated instead of the window collapsing."""
    messages = [
        type("M", (), {"role": "user", "content": "older turn"})(),
        type("M", (), {"role": "assistant", "content": "x" * 20000})(),
        type("M", (), {"role": "user", "content": "current turn is dropped"})(),
    ]
    history = SessionService._convert_messages_to_history(messages)
    assert history, "an oversized newest message wiped the entire window"
    assert history[-1]["content"].endswith("[... truncated]")
    assert len(history[-1]["content"]) <= 12000 + len("\n[... truncated]")


def test_normal_history_is_untouched():
    """Messages inside the budget are passed through unchanged."""
    messages = [
        type("M", (), {"role": "user", "content": "first"})(),
        type("M", (), {"role": "assistant", "content": "second"})(),
        type("M", (), {"role": "user", "content": "current turn is dropped"})(),
    ]
    history = SessionService._convert_messages_to_history(messages)
    assert [m["content"] for m in history] == ["first", "second"]
