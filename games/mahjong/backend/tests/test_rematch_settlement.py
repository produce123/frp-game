"""Regression checks for rematching after the last match and WS LLM win timing."""

import asyncio
from types import SimpleNamespace

import pytest

import app.game.room as room_module
from app.game.blood_flow_room import BloodFlowRoomSession
from app.game.room import RoomSession


@pytest.mark.asyncio
@pytest.mark.parametrize('room_type', [RoomSession, BloodFlowRoomSession])
async def test_rematch_waits_for_previous_drive_to_finish(room_type):
    room = room_type('REMATCH-WAIT', mode='east', capacity=1)
    seat, _, _ = room.join_or_rejoin('玩家')
    room.ready_seat(seat, True)
    release = asyncio.Event()
    previous = asyncio.create_task(release.wait())
    if isinstance(room, BloodFlowRoomSession):
        room._drive_task = previous
        room.match_started = True
    else:
        room.game_task = previous
    room.status = 'finished'

    restart = asyncio.create_task(room.start())
    await asyncio.sleep(0)
    assert not restart.done()
    release.set()
    await asyncio.wait_for(restart, 5)
    current = room._drive_task if isinstance(room, BloodFlowRoomSession) else room.game_task
    assert current is not previous
    assert room.status in ('playing', 'finished')
    room.close()
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_classic_win_snapshot_precedes_server_round_speech(monkeypatch):
    class FakeLlm:
        pass

    monkeypatch.setattr(room_module, 'LLMPlayer', FakeLlm)
    room = RoomSession('WIN-ORDER', mode='east', capacity=1)
    class Manager:
        phase = 'settled'
        match_finished = False
        result = {'winnerIndex': 0}
        players = [SimpleNamespace(seat=0, name='玩家', score=1000)]
        controllers = [FakeLlm()]
        round = 1
        honba = 0

        async def start_game(self, mode):
            pass

        async def next_round(self):
            self.phase = 'finished'
            self.match_finished = True

    room.manager = Manager()
    waiting = asyncio.Event()
    release = asyncio.Event()
    snapshots = []
    messages = []
    room.broadcast_snapshot = lambda: snapshots.append((
        room._settlement_snapshot_released, room._round_speech_pending))
    room.conn.broadcast = lambda message: messages.append(message)
    room._log_llm_match_summary = lambda: None

    async def reactions(result):
        waiting.set()
        await release.wait()

    room._announce_llm_round_reactions = reactions
    drive = asyncio.create_task(room._drive())
    await asyncio.wait_for(waiting.wait(), 5)
    assert snapshots[0] == (True, True)
    assert not any(message['kind'] == 'round_speech_done' for message in messages)
    release.set()
    await asyncio.wait_for(drive, 5)
    kinds = [message['kind'] for message in messages]
    assert kinds.index('round_speech_done') < kinds.index('hand_result')
    assert room._round_speech_pending is False


@pytest.mark.asyncio
async def test_server_round_audio_does_not_wait_for_guessed_playback(monkeypatch):
    room = RoomSession('AUDIO-PACE', mode='east', capacity=1)
    queue = asyncio.Queue()
    room.conn.register(0, queue, None)
    room._presentation_audio_modes[0] = 'legacy-dynamic'

    async def ensure_audio(*args):
        return SimpleNamespace(
            audio_url='/api/tts/audio/' + 'a' * 64 + '.mp3',
            cached=True, size_bytes=64_000)

    monkeypatch.setattr(room_module, 'get_tts_service',
                        lambda: SimpleNamespace(available=True, ensure_audio=ensure_audio))
    controller = SimpleNamespace(config=SimpleNamespace(style='steady'), provider_id='mock')
    targets = room._model_speech_targets('round-reaction')
    await asyncio.wait_for(
        room._emit_llm_round_reaction(1, 'Round complete', controller, targets), 0.5)
    messages = [queue.get_nowait(), queue.get_nowait()]
    assert [item['kind'] for item in messages] == ['llm_message', 'llm_audio']
    assert messages[0]['hasAudio'] is True
