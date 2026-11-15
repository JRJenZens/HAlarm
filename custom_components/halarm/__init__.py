"""HAlarm: configurable multi-speaker Cast alarms with a Home Assistant sidebar panel.

YAML setup: halarm: {}  (may live in an existing packages directory).
"""
from __future__ import annotations

import asyncio
from datetime import timedelta
import logging
import re
from pathlib import Path
import shutil
from time import monotonic
from typing import Any
from uuid import uuid4

import probatio

from homeassistant.components import frontend, panel_custom, websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers.storage import Store
from homeassistant.helpers.typing import ConfigType
from homeassistant.util import dt as dt_util

from .cast_stop import is_early_stop

DOMAIN = "halarm"
_LOGGER = logging.getLogger(__name__)
CONFIG_SCHEMA = probatio.Schema({probatio.Optional(DOMAIN): dict}, extra=probatio.ALLOW_EXTRA)
SOUND_FILE = re.compile(r"^[^/\\\x00-\x1f]+\.mp3$", re.IGNORECASE)
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
VERSION = 1


class AlarmManager:
    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.store: Store[dict[str, Any]] = Store(hass, VERSION, "halarm.v1")
        self.alarms: list[dict[str, Any]] = []
        self.base_url = ""
        self.sounds: dict[str, str] = {}
        self.durations: dict[str, float] = {}
        self.media_available = False
        self.active: dict[str, dict[str, Any]] = {}
        self.last_fired: dict[str, str] = {}
        self._unsubs: list[Any] = []
        self._last_scan = 0.0
        self.last_error: str | None = None
        self.last_voice_stop: dict[str, str] | None = None
        self.transitions: list[dict[str, Any]] = []

    async def setup(self) -> None:
        stored = await self.store.async_load()
        if stored is None:
            # Migration: the former Alarmcentral integration stores settings here.
            # Read-only migration. Never delete or modify the legacy storage file.
            legacy = await Store(self.hass, 2, "alarmpanel.v2").async_load()
            if isinstance(legacy, dict) and "alarms" in legacy:
                stored = legacy
                await self.store.async_save({
                    "alarms": legacy.get("alarms", []),
                    "base_url": legacy.get("base_url", ""),
                    "last_fired": legacy.get("last_fired", {}),
                })
                _LOGGER.info("HAlarm imported %d alarms from Alarmcentral", len(legacy.get("alarms", [])))
        stored = stored or {}
        self.alarms = stored.get("alarms", [])
        self.last_fired = stored.get("last_fired", {})
        self.base_url = stored.get("base_url", "") or (self.hass.config.internal_url or "")
        await self.scan_sounds(force=True)
        self._unsubs.append(async_track_time_interval(
            self.hass, self._tick, timedelta(seconds=10)
        ))
        self._unsubs.append(self.hass.bus.async_listen("state_changed", self._on_state))

    @callback
    def shutdown(self, event: Any) -> None:
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()
        for item in self.active.values():
            item["stop"].set()
            if item["task"]:
                item["task"].cancel()

    async def save(self) -> None:
        await self.store.async_save({
            "alarms": self.alarms,
            "base_url": self.base_url,
            "last_fired": self.last_fired,
        })

    def snapshot(self) -> dict[str, Any]:
        devices = []
        for state in self.hass.states.async_all("media_player"):
            devices.append({
                "entity_id": state.entity_id,
                "name": state.attributes.get("friendly_name", state.entity_id),
                "available": state.state not in ("unavailable", "unknown"),
            })
        devices.sort(key=lambda d: d["name"].casefold())
        now = dt_util.now()
        return {
            "alarms": self.alarms,
            "sounds": [{"file": name, "label": label} for name, label in sorted(
                self.sounds.items(), key=lambda item: item[1].casefold()
            )],
            "devices": devices,
            "ringing": [
                {"id": alarm_id, "device": data["device"], "since": data["since"]}
                for alarm_id, data in self.active.items()
            ],
            "base_url": self.base_url,
            "suggested_url": self.hass.config.internal_url or "",
            "media_available": self.media_available,
            "local_time": now.isoformat(),
            "last_error": self.last_error,
            "last_voice_stop": self.last_voice_stop,
            "transitions": self.transitions[-24:],
        }

    @staticmethod
    def _mp3_seconds(path: Path) -> float | None:
        """Estimate MP3 duration from first valid MPEG frame; works best for CBR.

        A Cast media_duration attribute supersedes this estimate if available.
        """
        try:
            with path.open("rb") as fp:
                head = fp.read(65536)
            offset = 0
            if head.startswith(b"ID3") and len(head) > 10:
                offset = 10 + ((head[6]&127)<<21 | (head[7]&127)<<14 | (head[8]&127)<<7 | (head[9]&127))
            bitrates = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0]
            for pos in range(offset, max(offset,len(head)-4)):
                a,b,c,d = head[pos:pos+4]
                if a != 255 or b & 0xe0 != 0xe0:
                    continue
                # MPEG1 Layer III, bitrate derived from header index.
                if ((b >> 3)&3) != 3 or ((b >> 1)&3) != 1:
                    continue
                rate = bitrates[(c>>4)&15]
                if rate > 0:
                    return max(0.0, (path.stat().st_size-pos)*8 / (rate*1000))
        except (OSError, ValueError, IndexError):
            return None
        return None

    def _files_sync(self) -> tuple[dict[str, str], dict[str, float], bool]:
        """Mirror original sounds for both HA media sources and public Cast URLs.

        User manages /config/halarm/sounds/. Legacy sounds are imported. Mirroring is
        performed in the executor; Home Assistant Media Source uses media_dirs.
        """
        sound_dir = Path(self.hass.config.path("halarm", "sounds"))
        sound_dir.mkdir(parents=True, exist_ok=True)
        # Preserve user audio across HACS replacement of the integration folder.
        # Copy legacy files once; never overwrite an existing persistent sound.
        legacy_dir = Path(__file__).parent / "sounds"
        if legacy_dir.is_dir():
            for legacy in legacy_dir.iterdir():
                target = sound_dir / legacy.name
                if legacy.is_file() and SOUND_FILE.fullmatch(legacy.name) and not target.exists():
                    shutil.copy2(legacy, target)
        public_dir = Path(self.hass.config.path("www", "halarm"))
        public_dir.mkdir(parents=True, exist_ok=True)
        sound_dir.mkdir(parents=True, exist_ok=True)
        local_media_root = self.hass.config.media_dirs.get("local")
        media_dir = Path(local_media_root) / "halarm" if local_media_root else None
        if media_dir is not None:
            try:
                media_dir.mkdir(parents=True, exist_ok=True)
            except OSError:
                _LOGGER.warning("Kan ikke oprette lokal mediemappe %s", media_dir, exc_info=True)
                media_dir = None
        found: dict[str, str] = {}
        durations: dict[str, float] = {}
        for path in sound_dir.iterdir():
            if not path.is_file() or path.name.startswith(".") or not SOUND_FILE.fullmatch(path.name):
                continue
            name = path.name
            label = re.sub(r"^Alarm_", "", path.stem, flags=re.IGNORECASE).replace("_", " ").strip() or path.stem
            found[name] = label
            if (seconds := self._mp3_seconds(path)) is not None:
                durations[name] = seconds
            target = public_dir / name
            if (not target.exists() or target.stat().st_mtime_ns != path.stat().st_mtime_ns
                    or target.stat().st_size != path.stat().st_size):
                shutil.copy2(path, target)
            if media_dir is not None:
                media_target = media_dir / name
                try:
                    if (not media_target.exists() or
                            media_target.stat().st_mtime_ns != path.stat().st_mtime_ns or
                            media_target.stat().st_size != path.stat().st_size):
                        shutil.copy2(path, media_target)
                except OSError:
                    _LOGGER.warning("Kunne ikke kopiere lyd til %s", media_target, exc_info=True)
                    media_dir = None
        for obsolete in public_dir.iterdir():
            if obsolete.is_file() and obsolete.suffix.lower() == ".mp3" and obsolete.name not in found:
                obsolete.unlink()
        if media_dir is not None:
            for obsolete in media_dir.iterdir():
                if obsolete.is_file() and obsolete.suffix.lower() == ".mp3" and obsolete.name not in found:
                    obsolete.unlink()
        return found, durations, media_dir is not None

    async def scan_sounds(self, force: bool = False) -> None:
        if not force and monotonic() - self._last_scan < 20:
            return
        self.sounds, self.durations, self.media_available = await self.hass.async_add_executor_job(self._files_sync)
        self._last_scan = monotonic()

    def _validate(self, raw: dict[str, Any]) -> dict[str, Any]:
        aid = raw.get("id")
        existing = next((a for a in self.alarms if a["id"] == aid), None)
        if aid is not None and existing is None:
            raise ValueError("Alarmen findes ikke længere")
        name = str(raw.get("name", "Vækkeur")).strip()[:70] or "Vækkeur"
        time = str(raw.get("time", "07:00"))
        if not TIME_RE.fullmatch(time):
            raise ValueError("Ugyldigt tidspunkt")
        days = raw.get("days", [])
        if not isinstance(days, list) or any(type(i) is not int or i < 0 or i > 6 for i in days):
            raise ValueError("Ugyldige ugedage")
        days = sorted(set(days))
        if not days:
            raise ValueError("Vælg mindst én ugedag")
        device = str(raw.get("device", ""))
        if not device.startswith("media_player.") or self.hass.states.get(device) is None:
            raise ValueError("Vælg en tilgængelig medieafspiller")
        sound = str(raw.get("sound", ""))
        if sound not in self.sounds:
            raise ValueError("Vælg en eksisterende MP3 fil fra sounds mappen")
        try:
            volume = int(raw.get("volume", 60))
        except (ValueError, TypeError) as err:
            raise ValueError("Ugyldig lydstyrke") from err
        if not 10 <= volume <= 100:
            raise ValueError("Lydstyrken skal være 10 til 100 procent")
        return {
            "id": aid or uuid4().hex,
            "name": name,
            "time": time,
            "days": days,
            "device": device,
            "sound": sound,
            "volume": volume,
            "enabled": bool(raw.get("enabled", True)),
        }

    async def upsert(self, raw: dict[str, Any]) -> dict[str, Any]:
        await self.scan_sounds(force=True)
        alarm = self._validate(raw)
        for idx, old in enumerate(self.alarms):
            if old["id"] == alarm["id"]:
                if alarm["id"] in self.active and (
                    alarm["device"] != old["device"] or not alarm["enabled"]
                ):
                    await self.stop(alarm["id"])
                self.alarms[idx] = alarm
                break
        else:
            self.alarms.append(alarm)
        await self.save()
        self.notify()
        return alarm

    async def remove(self, aid: str) -> None:
        if aid in self.active:
            await self.stop(aid)
        self.alarms = [a for a in self.alarms if a["id"] != aid]
        self.last_fired.pop(aid, None)
        await self.save()
        self.notify()

    async def toggle(self, aid: str, enabled: bool) -> None:
        alarm = self.by_id(aid)
        if not enabled and aid in self.active:
            await self.stop(aid)
        alarm["enabled"] = enabled
        await self.save()
        self.notify()

    def by_id(self, aid: str) -> dict[str, Any]:
        for alarm in self.alarms:
            if alarm["id"] == aid:
                return alarm
        raise ValueError("Alarmen findes ikke")

    async def set_url(self, url: str) -> None:
        url = url.strip().rstrip("/")
        if not url.startswith(("http://", "https://")) or len(url) > 250:
            raise ValueError("Angiv en HTTP eller HTTPS adresse")
        self.base_url = url
        await self.save()
        self.notify()

    def notify(self) -> None:
        self.hass.bus.async_fire("halarm_updated")

    @callback
    def _tick(self, now_utc: Any) -> None:
        """Check local wall clock; a per-minute persistent key prevents repeats."""
        local = dt_util.as_local(now_utc)
        hhmm = local.strftime("%H:%M")
        day = local.weekday()
        key = local.strftime("%Y-%m-%d %H:%M")
        matches = [a.copy() for a in self.alarms if a["enabled"] and a["time"] == hhmm
                   and day in a["days"] and self.last_fired.get(a["id"]) != key]
        if matches:
            self.hass.async_create_task(self._run_scheduled(matches, key))

    async def _run_scheduled(self, matches: list[dict[str, Any]], key: str) -> None:
        claimed = []
        for alarm in matches:
            if self.last_fired.get(alarm["id"]) == key:
                continue
            self.last_fired[alarm["id"]] = key
            claimed.append(alarm)
        if not claimed:
            return
        await self.save()
        for alarm in claimed:
            try:
                await self.start(alarm["id"])
            except Exception as err:
                self.last_error = f"{alarm['name']}: {err}"
                self.notify()
                _LOGGER.exception("Kunne ikke starte alarm '%s'", alarm["name"])

    async def start(self, aid: str) -> None:
        alarm = self.by_id(aid)
        await self.scan_sounds(force=True)
        if alarm["sound"] not in self.sounds:
            raise ValueError("MP3 filen findes ikke: " + alarm["sound"])
        if aid in self.active:
            raise ValueError("Alarmen ringer allerede")
        if any(r["device"] == alarm["device"] for r in self.active.values()):
            raise ValueError("En anden alarm bruger allerede denne højttaler")
        if self.hass.states.get(alarm["device"]) is None:
            raise ValueError("Højttaleren findes ikke")
        self.last_error = None
        item: dict[str, Any] = {
            "device": alarm["device"],
            "stop": asyncio.Event(),
            "since": dt_util.now().isoformat(),
            "play_started": 0.0,
            "saw_playing": False,
            "playing_since": 0.0,
            "duration": None,
            "source": None,
            "stop_reason": None,
            "task": None,
        }
        self.active[aid] = item
        item["task"] = self.hass.async_create_task(self._play_loop(aid, alarm.copy(), item))
        self.notify()

    async def stop(self, aid: str) -> None:
        item = self.active.get(aid)
        if not item:
            return
        item["stop_reason"] = "dashboard"
        item["stop"].set()
        # Stop also when initiated from dashboard. Handler ignores the transition.
        try:
            await self.hass.services.async_call("media_player", "media_stop",
                {"entity_id": item["device"]}, blocking=True)
        except Exception:
            _LOGGER.warning("Kunne ikke stoppe lyd paa %s", item["device"], exc_info=True)
        self.notify()

    def _sources(self, sound: str) -> list[tuple[str, str]]:
        """Try Home Assistant's supported media source before plain HTTP.

        The fallback direct URL is useful if the Cast device cannot resolve
        HA's internal hostname, e.g. homeassistant.local.
        """
        from urllib.parse import quote
        candidates: list[tuple[str, str]] = []
        if self.media_available:
            candidates.append(("mediebibliotek", f"media-source://media_source/local/halarm/{quote(sound)}"))
        if self.base_url:
            candidates.append(("direkte URL", f"{self.base_url}/local/halarm/{quote(sound)}"))
        return candidates

    async def _wait_for_playing(self, device: str, item: dict[str, Any], seconds: int = 14) -> bool:
        """Check that Cast actually entered playing; success of play_media is not enough."""
        for _ in range(seconds * 2):
            if item["stop"].is_set():
                return False
            state = self.hass.states.get(device)
            if state and state.state == "playing":
                item["saw_playing"] = True
                if not item.get("playing_since"):
                    item["playing_since"] = monotonic()
                duration = state.attributes.get("media_duration")
                if isinstance(duration, (int, float)) and duration > 0:
                    item["duration"] = duration
                return True
            try:
                await asyncio.wait_for(item["stop"].wait(), timeout=0.5)
            except asyncio.TimeoutError:
                pass
        return False

    async def _play_loop(self, aid: str, alarm: dict[str, Any], item: dict[str, Any]) -> None:
        device = alarm["device"]
        tried: list[str] = []
        try:
            await self.hass.services.async_call("media_player", "volume_set", {
                "entity_id": device, "volume_level": alarm["volume"] / 100
            }, blocking=True)
            sources = self._sources(alarm["sound"])
            if not sources:
                raise RuntimeError("Ingen mediekilde tilgaengelig. Kontroller /media og lokal URL under Indstillinger")
            selected: tuple[str, str] | None = None
            while not item["stop"].is_set():
                # On first playback try multiple independent ways of reaching the MP3.
                # After successful playback, prefer that same transport for repeats.
                options = [selected] if selected else sources
                started = False
                for method, audio_url in options:
                    if item["stop"].is_set():
                        break
                    item["saw_playing"] = False
                    item["playing_since"] = 0.0
                    item["source"] = audio_url
                    item["duration"] = self.durations.get(alarm["sound"])
                    item["play_started"] = monotonic()
                    try:
                        await self.hass.services.async_call("media_player", "play_media", {
                            "entity_id": device,
                            "media_content_id": audio_url,
                            "media_content_type": "audio/mpeg",
                        }, blocking=True)
                        started = await self._wait_for_playing(device, item)
                    except Exception as err:
                        _LOGGER.warning("Alarm %s: %s fejlede: %s", alarm["name"], method, err)
                        tried.append(f"{method}: {err}")
                        continue
                    if started:
                        selected = (method, audio_url)
                        _LOGGER.debug("HAlarm: %s afspilles via %s paa %s", alarm["name"], method, device)
                        break
                    tried.append(f"{method}: Cast viste ikke 'playing'")
                if item["stop"].is_set():
                    break
                if not started:
                    detail = "; ".join(tried[-3:])
                    raise RuntimeError(
                        "Google Cast enheden begyndte ikke at afspille lyd. "
                        "Kontroller at Home Assistants interne URL er en lokal IP adresse "
                        "som hoejttaleren kan naa, og at filen kan afspilles. "
                        f"Detaljer: {detail}"
                    )
                # Wait for the selected track to end; return to the top to repeat.
                while not item["stop"].is_set():
                    try:
                        await asyncio.wait_for(item["stop"].wait(), timeout=0.5)
                        break
                    except asyncio.TimeoutError:
                        pass
                    state = self.hass.states.get(device)
                    elapsed = monotonic() - item["playing_since"]
                    if state and state.state == "playing":
                        duration = state.attributes.get("media_duration")
                        if isinstance(duration, (int, float)) and duration > 0:
                            item["duration"] = duration
                    if state and state.state == "idle":
                        break
                    duration = item.get("duration")
                    cap = duration + 4 if duration else 180
                    if state and state.state in ("unknown", "unavailable"):
                        raise RuntimeError("Højttaleren mistede forbindelsen; alarmen er stoppet")
                    if elapsed > min(max(cap, 8), 720):
                        raise RuntimeError("Afspilningen overskred tidsgrænsen; alarmen er stoppet")
                if not item["stop"].is_set():
                    try:
                        await asyncio.wait_for(item["stop"].wait(), timeout=0.8)
                    except asyncio.TimeoutError:
                        pass
        except asyncio.CancelledError:
            raise
        except Exception as err:
            self.last_error = f"{alarm['name']}: {err}"
            _LOGGER.exception("HAlarm afspilningsfejl: %s", err)
            self.hass.bus.async_fire("halarm_error", {"id": aid, "error": str(err)})
        finally:
            if self.active.get(aid) is item:
                del self.active[aid]
            self.notify()

    def _add_transition(self, device: str, old: Any, new: Any, note: str) -> None:
        # Diagnostics show how a particular Nest speaker transitions on voice stop.
        self.transitions.append({
            "at": dt_util.now().strftime("%H:%M:%S"),
            "device": device,
            "from": old.state,
            "to": new.state,
            "note": note,
        })
        self.transitions = self.transitions[-40:]

    @callback
    def _on_state(self, event: Any) -> None:
        device = event.data.get("entity_id", "")
        old = event.data.get("old_state")
        new = event.data.get("new_state")
        if not old or not new:
            return
        for aid, item in list(self.active.items()):
            if item["device"] != device or item["stop"].is_set():
                continue
            if new.state == "playing":
                item["saw_playing"] = True
                if not item["playing_since"]:
                    item["playing_since"] = monotonic()
                reported = new.attributes.get("media_duration")
                if isinstance(reported, (int, float)) and reported > 0:
                    item["duration"] = reported
                self._add_transition(device, old, new, "afspiller")
                return
            if old.state == new.state:
                continue
            # Nest Hub commonly goes playing -> off, while Nest Audio/Mini may
            # go playing -> idle or paused when the Assistant stops playback.
            if old.state not in ("playing", "buffering", "paused", "idle") or new.state not in ("off", "idle", "paused"):
                self._add_transition(device, old, new, "observeret")
                continue
            if not item["saw_playing"] or not item["playing_since"]:
                continue
            elapsed = monotonic() - item["play_started"]
            since_playing = monotonic() - item["playing_since"]
            duration = item.get("duration") or old.attributes.get("media_duration")
            position = old.attributes.get("media_position")
            try:
                duration = float(duration) if duration is not None else None
            except (TypeError, ValueError):
                duration = None
            try:
                position = float(position) if position is not None else None
            except (TypeError, ValueError):
                position = None
            should_stop, reason = is_early_stop(old.state, new.state, elapsed, since_playing, duration, position)
            if not should_stop:
                self._add_transition(device, old, new, reason)
                continue
            item["stop_reason"] = f"playback transitioned {old.state} -> {new.state}"
            item["stop"].set()
            self.last_voice_stop = {"device": device, "at": dt_util.now().isoformat(), "transition": f"{old.state} → {new.state}"}
            self._add_transition(device, old, new, "alarm stoppet")
            self.notify()
            _LOGGER.info("HAlarm %s stopped early on %s (%s -> %s)", aid, device, old.state, new.state)
            return


# The panel and its websocket data require the administrator role.
@websocket_api.require_admin
@websocket_api.websocket_command({probatio.Required("type"): "halarm/get"})
@websocket_api.async_response
async def ws_get(hass, connection, msg):
    manager = hass.data[DOMAIN]
    await manager.scan_sounds()
    connection.send_result(msg["id"], manager.snapshot())


@websocket_api.require_admin
@websocket_api.websocket_command({probatio.Required("type"): "halarm/save", probatio.Required("alarm"): dict})
@websocket_api.async_response
async def ws_save(hass, connection, msg):
    try:
        item = await hass.data[DOMAIN].upsert(msg["alarm"])
        connection.send_result(msg["id"], item)
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_alarm", str(err))


@websocket_api.require_admin
@websocket_api.websocket_command({probatio.Required("type"): "halarm/delete", probatio.Optional("alarm_id"): str, probatio.Optional("target_alarm"): str})
@websocket_api.async_response
async def ws_delete(hass, connection, msg):
    alarm_id = msg.get("alarm_id") or msg.get("target_alarm")
    if not alarm_id:
        connection.send_error(msg["id"], "missing_alarm", "Alarmen mangler et ID. Genindlaes HAlarm siden.")
        return
    await hass.data[DOMAIN].remove(alarm_id)
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.require_admin
@websocket_api.websocket_command({probatio.Required("type"): "halarm/toggle", probatio.Required("alarm_id"): str, probatio.Required("enabled"): bool})
@websocket_api.async_response
async def ws_toggle(hass, connection, msg):
    try:
        await hass.data[DOMAIN].toggle(msg["alarm_id"], msg["enabled"])
        connection.send_result(msg["id"], {"ok": True})
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_alarm", str(err))


@websocket_api.require_admin
@websocket_api.websocket_command({probatio.Required("type"): "halarm/start", probatio.Required("alarm_id"): str})
@websocket_api.async_response
async def ws_start(hass, connection, msg):
    try:
        await hass.data[DOMAIN].start(msg["alarm_id"])
        connection.send_result(msg["id"], {"ok": True})
    except ValueError as err:
        connection.send_error(msg["id"], "cannot_start", str(err))


@websocket_api.require_admin
@websocket_api.websocket_command({probatio.Required("type"): "halarm/stop", probatio.Required("alarm_id"): str})
@websocket_api.async_response
async def ws_stop(hass, connection, msg):
    await hass.data[DOMAIN].stop(msg["alarm_id"])
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.require_admin
@websocket_api.websocket_command({probatio.Required("type"): "halarm/stop_all"})
@websocket_api.async_response
async def ws_stop_all(hass, connection, msg):
    manager = hass.data[DOMAIN]
    ids = list(manager.active)
    for alarm_id in ids:
        await manager.stop(alarm_id)
    connection.send_result(msg["id"], {"ok": True, "stopped": len(ids)})


@websocket_api.require_admin
@websocket_api.websocket_command({probatio.Required("type"): "halarm/settings", probatio.Required("base_url"): str})
@websocket_api.async_response
async def ws_settings(hass, connection, msg):
    try:
        await hass.data[DOMAIN].set_url(msg["base_url"])
        connection.send_result(msg["id"], {"ok": True})
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_url", str(err))


@websocket_api.require_admin
@websocket_api.websocket_command({probatio.Required("type"): "halarm/refresh"})
@websocket_api.async_response
async def ws_refresh(hass, connection, msg):
    await hass.data[DOMAIN].scan_sounds(force=True)
    connection.send_result(msg["id"], hass.data[DOMAIN].snapshot())


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    if DOMAIN not in config:
        return True
    manager = AlarmManager(hass)
    await manager.setup()
    hass.bus.async_listen_once("homeassistant_stop", manager.shutdown)
    hass.data[DOMAIN] = manager
    for handler in (ws_get, ws_save, ws_delete, ws_toggle, ws_start, ws_stop, ws_stop_all, ws_settings, ws_refresh):
        websocket_api.async_register_command(hass, handler)
    static_dir = Path(__file__).parent / "frontend"
    await hass.http.async_register_static_paths([
        StaticPathConfig("/halarm-ui", str(static_dir), False),
    ])
    if not frontend.async_panel_exists(hass, DOMAIN):
        await panel_custom.async_register_panel(
            hass, webcomponent_name="halarm-app", frontend_url_path=DOMAIN,
            sidebar_title="HAlarm", sidebar_icon="mdi:alarm-multiple",
            module_url="/halarm-ui/halarm.js?v=0.9.1",
            require_admin=True,
        )
    _LOGGER.info("HAlarm 0.9.1 beta klar")
    return True
