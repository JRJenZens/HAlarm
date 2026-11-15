"""Integration regression tests with real HA states/events and isolated storage."""
import asyncio
from copy import deepcopy
from datetime import datetime, UTC
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from homeassistant.core import HomeAssistant, State, Event
from custom_components.halarm import AlarmManager

ALARM = dict(id='existing', name='Arbejdsdag', time='07:15', days=[0,1,2,3,4],
             device='media_player.nest_mini', sound='Morning.mp3', volume=45, enabled=True)

class ManagerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        self.hass = HomeAssistant(self.tmp.name)
        self.hass.config.media_dirs = {'local': str(Path(self.tmp.name)/'media')}
        self.manager = AlarmManager(self.hass)
        self.manager.alarms = [deepcopy(ALARM)]
        self.hass.states.async_set(ALARM['device'], 'idle')

    async def asyncTearDown(self):
        self.manager.shutdown(None)
        await self.hass.async_block_till_done()
        self.tmp.cleanup()

    def activate(self, duration=60, age=15, startup=0):
        item = dict(device=ALARM['device'], stop=asyncio.Event(), saw_playing=True,
                    playing_since=100-age, play_started=100-age-startup,
                    duration=duration, task=None, since='now', stop_reason=None)
        self.manager.active[ALARM['id']] = item
        return item

    def transition(self, before, after, attrs=None):
        old = State(ALARM['device'], before, attrs or {})
        new = State(ALARM['device'], after)
        with patch('custom_components.halarm.monotonic', return_value=100):
            self.manager._on_state(Event('state_changed', dict(entity_id=ALARM['device'], old_state=old, new_state=new)))

    async def test_nest_mini_idle_voice_stop(self):
        item=self.activate(); self.transition('playing','idle')
        self.assertTrue(item['stop'].is_set())
        self.assertEqual(self.manager.alarms, [ALARM])

    async def test_nest_off_at_track_end_still_stops(self):
        item=self.activate(age=60); self.transition('playing','off')
        self.assertTrue(item['stop'].is_set())

    async def test_pause_immediately_after_playing_stops(self):
        item=self.activate(age=.1); self.transition('playing','paused')
        self.assertTrue(item['stop'].is_set())

    async def test_cast_startup_latency_does_not_fake_natural_end(self):
        item=self.activate(age=48,startup=15); self.transition('playing','idle')
        self.assertTrue(item['stop'].is_set())

    async def test_natural_idle_end_repeats(self):
        item=self.activate(age=60); self.transition('playing','idle')
        self.assertFalse(item['stop'].is_set())

    async def test_idle_then_off_cancels_pending_repeat(self):
        item=self.activate(age=60); self.transition('playing','idle'); self.transition('idle','off')
        self.assertTrue(item['stop'].is_set())

    async def test_startup_transition_before_confirmed_play_is_ignored(self):
        item=self.activate(); item['saw_playing']=False; item['playing_since']=0
        self.transition('buffering','idle'); self.assertFalse(item['stop'].is_set())

    async def test_existing_storage_roundtrip(self):
        self.manager.base_url='http://192.168.1.2:8123'
        self.manager.last_fired={'existing':'2026-11-15 07:15'}
        await self.manager.save()
        restored=AlarmManager(self.hass)
        with patch.object(restored, 'scan_sounds', new=AsyncMock()):
            await restored.setup()
        self.assertEqual(restored.alarms, [ALARM])
        self.assertEqual(restored.base_url,self.manager.base_url)
        self.assertEqual(restored.last_fired,self.manager.last_fired)
        restored.shutdown(None)

    async def test_legacy_migration_is_read_only(self):
        from homeassistant.helpers.storage import Store
        legacy=Store(self.hass,2,'alarmpanel.v2')
        await legacy.async_save(dict(alarms=[ALARM],base_url='http://example:8123',last_fired={}))
        path=Path(self.tmp.name)/'.storage/alarmpanel.v2'; before=path.read_bytes()
        with patch.object(self.manager, 'scan_sounds', new=AsyncMock()):
            await self.manager.setup()
        self.assertEqual(self.manager.alarms,[ALARM]); self.assertEqual(path.read_bytes(),before)

    async def test_persistent_audio_and_mirrors(self):
        folder=Path(self.tmp.name)/'halarm/sounds'; folder.mkdir(parents=True)
        (folder/'Morning.mp3').write_bytes(b'test audio')
        sounds,_,available=await self.hass.async_add_executor_job(self.manager._files_sync)
        self.assertIn('Morning.mp3',sounds); self.assertTrue(available)
        self.assertEqual((Path(self.tmp.name)/'www/halarm/Morning.mp3').read_bytes(),b'test audio')
        self.assertEqual((Path(self.tmp.name)/'media/halarm/Morning.mp3').read_bytes(),b'test audio')

    async def test_same_scheduled_minute_is_claimed_once(self):
        self.manager.start=AsyncMock()
        await asyncio.gather(
            self.manager._run_scheduled([ALARM], '2026-11-15 07:15'),
            self.manager._run_scheduled([ALARM], '2026-11-15 07:15'))
        self.manager.start.assert_awaited_once_with(ALARM['id'])

    async def test_voice_stop_exits_loop_without_playback_retry(self):
        item=self.activate(); calls=[]
        async def service(domain,action,data,**kwargs):
            calls.append(action)
            if action=='play_media':
                self.hass.states.async_set(ALARM['device'],'playing')
                asyncio.get_running_loop().call_later(.01, self.transition, 'playing', 'paused')
        self.manager.base_url='http://example:8123'
        with patch.object(type(self.hass.services),'async_call',side_effect=service):
            await self.manager._play_loop(ALARM['id'],ALARM,item)
        self.assertEqual(calls.count('play_media'),1)
        self.assertNotIn(ALARM['id'],self.manager.active)

if __name__ == '__main__': unittest.main()
