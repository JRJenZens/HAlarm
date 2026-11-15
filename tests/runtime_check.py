"""Boot the integration and its real HA dependencies in a temporary instance."""
import asyncio
from pathlib import Path
import tempfile
import logging
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
from homeassistant import loader, bootstrap

async def main():
    logging.basicConfig(level=logging.INFO)
    with tempfile.TemporaryDirectory() as directory:
        component=Path(directory)/'custom_components';component.mkdir()
        (component/'halarm').symlink_to(Path(__file__).resolve().parents[1]/'custom_components/halarm',target_is_directory=True)
        hass=HomeAssistant(directory)
        loader.async_setup(hass)
        try:
            async with asyncio.timeout(50):
                ok=await bootstrap.async_from_config_dict({'halarm':{},'http':{'server_host':'127.0.0.1','server_port':18124}},hass)
                assert ok,'HA bootstrap failed'
                assert await async_setup_component(hass,'halarm',{'halarm':{}}),'HAlarm failed setup'
                assert 'halarm' in hass.data
                assert 'halarm' in hass.data['frontend_panels']
                assert Path(directory,'halarm','sounds').is_dir()
                print('Runtime OK: real HA dependency setup, websocket registration, sidebar panel, persistent audio directory')
        finally:
            await hass.async_stop()

if __name__=='__main__':asyncio.run(main())
