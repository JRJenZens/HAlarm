"""Browser smoke test with a simulated HA websocket; never contacts live speakers."""
import asyncio
import json
from pathlib import Path
from playwright.async_api import async_playwright

ROOT=Path(__file__).resolve().parents[1]
async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch()
        page=await browser.new_page(viewport={'width':1280,'height':1000},device_scale_factor=1)
        errors=[];page.on('pageerror',lambda err: errors.append(str(err)))
        await page.set_content('<html><body style="margin:0"><halarm-app></halarm-app></body></html>')
        await page.add_script_tag(path=str(ROOT/'custom_components/halarm/frontend/halarm.js'))
        await page.evaluate('''() => {
          window.calls=[];
          window.snapshot={alarms:[{id:'morning',name:'Arbejdsdag',time:'07:15',days:[0,1,2,3,4],device:'media_player.mini',sound:'Morning.mp3',volume:45,enabled:true}],devices:[{entity_id:'media_player.mini',name:'Nest Mini · Soveværelse',available:true}],sounds:[{file:'Morning.mp3',label:'Morning'}],ringing:[],base_url:'http://192.168.1.20:8123',local_time:'2026-11-15T21:00:00+01:00',media_available:true};
          document.querySelector('halarm-app').hass={connection:{subscribeEvents:async()=>()=>{},sendMessagePromise:async msg=>{calls.push(msg); if(msg.type==='halarm/save')snapshot.alarms=[msg.alarm];if(msg.type==='halarm/toggle')snapshot.alarms[0].enabled=msg.enabled;return snapshot;}}};
        }''')
        await page.get_by_text('Arbejdsdag',exact=True).wait_for()
        out=ROOT/'docs';out.mkdir(exist_ok=True)
        await page.screenshot(path=str(out/'preview.png'),full_page=True)
        await page.get_by_role('button',name='Rediger').click()
        await page.locator('#a-name').fill('Morgenalarm')
        await page.get_by_role('button',name='Gem alarm',exact=True).click()
        await page.get_by_text('Morgenalarm',exact=True).wait_for()
        assert await page.evaluate("calls.filter(x=>x.type==='halarm/save').length") == 1
        await page.get_by_role('button',name='Indstillinger').click()
        await page.locator('#base-url').wait_for();await page.keyboard.press('Escape')
        assert await page.get_by_role('dialog').count() == 0
        # Reconnect the same element: clicks must not acquire duplicate listeners.
        await page.evaluate("() => {const e=document.querySelector('halarm-app');e.remove();document.body.append(e)}")
        await page.get_by_role('button',name='Rediger').click()
        await page.get_by_role('button',name='Gem alarm',exact=True).click()
        assert await page.evaluate("calls.filter(x=>x.type==='halarm/save').length") == 2
        await page.set_viewport_size({'width':390,'height':844})
        await page.evaluate("document.querySelector('halarm-app')._toastText='';document.querySelector('halarm-app')._render()")
        await page.screenshot(path=str(out/'preview-mobile.png'),full_page=True)
        assert await page.evaluate("document.querySelector('halarm-app').shadowRoot.querySelector('.page').scrollWidth") <= 390
        await page.get_by_role('button',name='Rediger').click()
        await page.locator('#a-name').wait_for()
        assert await page.get_by_role('button',name='Gem alarm',exact=True).is_visible()
        await page.keyboard.press('Escape')
        await page.emulate_media(color_scheme='dark')
        assert await page.evaluate("getComputedStyle(document.querySelector('halarm-app').shadowRoot.querySelector('.page')).backgroundColor") == 'rgb(245, 247, 248)'
        await page.screenshot(path=str(out/'preview-dark.png'),full_page=True)
        assert not errors,errors
        print('Browser OK: desktop, mobile, light design with dark system theme, editing, save, Escape, reconnect; no JS errors')
        await browser.close()
asyncio.run(main())
