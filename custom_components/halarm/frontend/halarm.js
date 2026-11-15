/* HAlarm 0.9.1 beta — standalone Home Assistant sidebar panel, no npm dependencies. */
const DAY_LABELS = ["Man", "Tir", "Ons", "Tor", "Fre", "Lør", "Søn"];
const DAY_FULL = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"];
const ESC = (x) => String(x ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c]);

const ICONS = {
  alarm: '<path d="M12 6a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 4v4l3 2M5 2 2 5m14-3 3 3M9 2h6"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  tune: '<path d="M4 7h16M4 17h16M9 4v6m6 4v6"/>',
  close: '<path d="m5 5 14 14M19 5 5 19"/>',
  sound: '<path d="M5 9v6h4l5 4V5l-5 4H5Zm12-1a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14"/>',
  speaker: '<rect x="6" y="3" width="12" height="18" rx="2"/><circle cx="12" cy="14.5" r="3"/><path d="M11.99 7h.02"/>',
  edit: '<path d="m4 20 4.5-.9L20 7.6 16.4 4 4.9 15.5 4 20ZM14.7 5.7l3.6 3.6"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"/>',
  play: '<path d="m8 5 11 7-11 7V5Z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  refresh: '<path d="M20 7V3l-4 4 4 4V7a8 8 0 1 0 2 5"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 11v6m0-10v.1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  moon: '<path d="M20 16.5A8.5 8.5 0 0 1 7.5 4 8.5 8.5 0 1 0 20 16.5Z"/>',
};
const ico = (name, size=20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;

class AlarmPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode: "open"});
    this._snapshot = null;
    this._editing = null;
    this._settingsOpen = false;
    this._error = "";
    this._busy = false;
    this._loading = false;
    this._toastText = "";
    this._toastIsError = false;
    this._mounted = false;
    this._unsub = null;
    this._interval = null;
    this._preview = null;
  }
  set hass(value) {
    this._hass = value;
    if (this.isConnected && !this._mounted) this._init();
  }
  get hass() { return this._hass; }
  set panel(value) { this._panel = value; }
  set narrow(value) { this._narrow = value; }
  connectedCallback() {
    if (this._hass && !this._mounted) this._init();
  }
  disconnectedCallback() {
    clearInterval(this._interval);
    this._interval = null;
    if (this._unsub) { this._unsub(); this._unsub = null; }
    this._stopPreview();
    this._mounted = false;
  }
  async _init() {
    if (this._mounted) return;
    this._mounted = true;
    if (!this._listenersInstalled) {
    this._listenersInstalled = true;
    this.shadowRoot.addEventListener("click", this._onClick.bind(this));
    this.shadowRoot.addEventListener("input", this._onInput.bind(this));
    this.shadowRoot.addEventListener("change", this._onChange.bind(this));
    this.shadowRoot.addEventListener("keydown", e => { if (e.key === "Escape") { if (this._editing) this._closeEditor(); else if (this._settingsOpen) { this._settingsOpen=false; this._shadowModal(""); } } });
    }
    await this._load();
    try {
      this._unsub = await this._hass.connection.subscribeEvents(() => {
        if (!this._editing && !this._settingsOpen) this._load();
      }, "halarm_updated");
    } catch (e) { console.warn("HAlarm event subscription", e); }
    this._interval = setInterval(() => {
      if (this.isConnected && !this._editing && !this._settingsOpen && !document.hidden) this._load();
    }, 30000);
  }
  async _ws(type, extras = {}) {
    const payload = {type: `halarm/${type}`, ...extras};
    // Home Assistant owns the transport 'id'. Alarm identifiers live in alarm_id.
    if ("alarm_id" in payload) {
      if (payload.alarm_id === null || payload.alarm_id === undefined || payload.alarm_id === "") {
        throw new Error("Alarm-ID mangler. Genindlæs siden og prøv igen.");
      }
      payload.alarm_id = String(payload.alarm_id);
    }
    return this._hass.connection.sendMessagePromise(payload);
  }
  async _load(refresh = false) {
    if (this._loading || this._editing || this._settingsOpen) return;
    this._loading = true;
    try {
      this._snapshot = await this._ws(refresh ? "refresh" : "get");
      this._error = "";
    } catch (e) { this._error = this._getError(e); }
    this._loading = false;
    this._render();
  }
  _getError(e) { return String(e?.message || e?.error?.message || e?.error || e || "Ukendt fejl"); }
  _toast(message, error = false) {
    const bar = this.shadowRoot.querySelector(".toast");
    if (!bar) return;
    this._toastText = message;
    this._toastIsError = error;
    bar.textContent = message;
    bar.className = `toast show ${error ? "bad" : ""}`;
    clearTimeout(this._toastHandle);
    this._toastHandle = setTimeout(() => { this._toastText = ""; const current = this.shadowRoot.querySelector(".toast"); if(current) current.className = "toast"; }, 4300);
  }
  _device(id) {
    return this._snapshot?.devices?.find(item => item.entity_id === id)?.name || id?.split(".").pop()?.replaceAll("_", " ") || "Vælg enhed";
  }
  _sound(file) {
    return this._snapshot?.sounds?.find(item => item.file === file)?.label || file?.replace(/^Alarm_/i, "").replace(/\.mp3$/i, "").replaceAll("_", " ") || "Vælg lyd";
  }
  _daySummary(days) {
    if (!days?.length) return "Ingen dage";
    if (days.length === 7) return "Hver dag";
    if (days.join(",") === "0,1,2,3,4") return "Hverdage";
    if (days.join(",") === "5,6") return "Weekend";
    return days.map(i => DAY_LABELS[i]).join(" · ");
  }
  _next(alarm) {
    if (!alarm.enabled || !alarm.days?.length) return {sort: 99999999, text: "Deaktiveret"};
    const now = new Date(this._snapshot?.local_time || Date.now());
    const dayIdx = (now.getDay()+6)%7;
    const [hour, minute] = alarm.time.split(":").map(Number);
    for (let delta=0; delta<8; delta++) {
      if (!alarm.days.includes((dayIdx+delta)%7)) continue;
      const time = new Date(now.getTime());
      time.setHours(hour, minute, 0, 0);
      time.setDate(now.getDate()+delta);
      if (time <= now) continue;
      return {sort: time.getTime(), text: delta === 0 ? "I dag" : delta === 1 ? "I morgen" : DAY_FULL[(dayIdx+delta)%7]};
    }
    return {sort: 99999999, text: "Ingen kommende alarm"};
  }
  _alarmCard(alarm) {
    const ringing = this._snapshot.ringing.some(x => x.id === alarm.id);
    const next = this._next(alarm);
    return `<article class="alarm-card ${alarm.enabled ? "" : "disabled"} ${ringing ? "ringing" : ""}">
      <div class="alarm-card-main">
        <div class="alarm-time-block"><div class="alarm-time">${ESC(alarm.time)}</div><div class="alarm-name">${ESC(alarm.name)}</div></div>
        <label class="switch" title="${alarm.enabled ? "Deaktiver" : "Aktiver"}"><input aria-label="${alarm.enabled ? "Deaktiver" : "Aktiver"} ${ESC(alarm.name)}" type="checkbox" data-action="toggle" data-id="${ESC(alarm.id)}" ${alarm.enabled ? "checked" : ""}><span></span></label>
      </div>
      <div class="alarm-days">${this._daySummary(alarm.days)}</div>
      <div class="alarm-meta">
        <span title="Højttaler">${ico("speaker", 16)} ${ESC(this._device(alarm.device))}</span>
        <span title="Alarmlyd">${ico("sound", 16)} ${ESC(this._sound(alarm.sound))}</span>
        <span title="Lydstyrke">${ico("tune", 16)} ${ESC(alarm.volume)}%</span>
      </div>
      <div class="alarm-card-footer">
        <span class="next-chip ${ringing ? "live" : ""}">${ringing ? "● Ringer nu" : alarm.enabled ? `${ico("clock", 15)} ${ESC(next.text)}` : "Slået fra"}</span>
        <div class="card-actions">
        ${ringing ? `<button class="mini danger" data-action="stop" data-id="${ESC(alarm.id)}">${ico("stop", 16)} Stop</button>` : `<button class="mini" data-action="test" data-id="${ESC(alarm.id)}" title="Start denne alarm nu">${ico("play", 16)} Test</button>`}
        <button class="mini edit" data-action="edit" data-id="${ESC(alarm.id)}">${ico("edit", 16)} Rediger</button>
        </div>
      </div>
    </article>`;
  }
  _render() {
    if (!this.isConnected) return;
    const s = this._snapshot;
    const alarms = [...(s?.alarms || [])];
    const active = (s?.ringing || []).length;
    const on = alarms.filter(a => a.enabled).length;
    const next = alarms.filter(a=>a.enabled).sort((a,b) => this._next(a).sort - this._next(b).sort)[0];
    const empty = alarms.length === 0;
    this.shadowRoot.innerHTML = `<style>${STYLE}</style>
    <div class="page">
      <header class="topbar"><div class="brand"><div class="brand-icon">${ico("alarm", 24)}</div><span>HALARM</span></div>
      <button class="icon-button" data-action="settings" aria-label="Indstillinger" title="Indstillinger">${ico("tune")}</button></header>
      <main class="main">
        <section class="overview" aria-label="Alarmoversigt">
          <div><span>Aktive alarmer</span><strong>${on}<small> / ${alarms.length}</small></strong></div>
          <div><span>Højttalere online</span><strong>${s?.devices?.filter(d=>d.available).length || 0}</strong></div>
          <div><span>Afspilning</span><strong class="status-value">${active ? `${active} ringer nu` : "Klar til vækning"}</strong></div>
        </section>
        <section class="hero">
          <div class="hero-copy"><p class="eyebrow">DIT PERSONLIGE VÆKKEUR</p>
          <h1>Godmorgen starter her<span class="period">.</span></h1>
          <p class="hero-description">Alle dine vækkealarmer. Alle dine Nest enheder. Ét enkelt sted.</p>
          <div class="hero-actions"><button class="primary" data-action="add">${ico("add", 21)} Tilføj alarm</button>
          <button class="subtle" data-action="refresh">${ico("refresh", 18)} Opdater lyde</button></div></div>
          <div class="hero-widget"><div class="widget-orbit"></div><div class="widget-glyph">${ico("alarm", 53)}</div>
          <p class="widget-label">NÆSTE VÆKNING</p><div class="widget-time">${next ? ESC(next.time) : "--:--"}</div>
          <div class="widget-caption">${next ? ESC(this._next(next).text) + " · " + ESC(next.name) : "Ingen aktive alarmer"}</div></div>
        </section>
        ${active ? `<section class="live-strip"><span class="live-dot"></span><div><b>${active} alarm${active > 1 ? "er" : ""} ringer</b><small>Sig “Hey Google, stop” eller brug Stop</small></div><button class="stop-all" data-action="stop-all">${ico("stop", 18)} Stop alle</button></section>` : ""}
        ${!s?.base_url ? `<section class="notice">${ico("info", 19)} <span>Home Assistants mediebibliotek bruges til alarmlyde. Angiv gerne en lokal IP adresse under Indstillinger som reservevej til Nest Hub.</span><button data-action="settings">Indstil</button></section>` : ""}
        ${s && !s.sounds.length ? `<section class="notice">${ico("info", 19)} <span>Ingen lydfiler endnu. Læg <code>*.mp3</code> i <code>halarm/sounds/</code>.</span><button data-action="refresh">Søg igen</button></section>` : ""}
        <section class="list-section"><div class="section-heading"><div><p class="eyebrow dark">OVERSIGT</p><h2>Dine alarmer <span class="count">${alarms.length}</span></h2></div><span class="section-caption">${on} aktive</span></div>
        ${this._error ? `<div class="notice error">${ico("info")} ${ESC(this._error)}</div>` : ""}
        ${s?.last_error ? `<div class="notice error">${ico("info")} <span>Seneste afspilningsfejl: ${ESC(s.last_error)}</span></div>` : ""}
        ${!s ? `<div class="empty">Indlæser alarmcentralen…</div>` : empty ? `<div class="empty-state"><div class="empty-icon">${ico("moon", 35)}</div><h3>Ingen alarmer endnu</h3><p>Begynd med din første alarm. Vælg klokken, ugedage, lyd og højttaler.</p><button class="primary" data-action="add">${ico("add")} Opret din første alarm</button></div>` : `<div class="alarm-grid">${alarms.sort((a,b) => Number(b.enabled)-Number(a.enabled) || a.time.localeCompare(b.time)).map(a=>this._alarmCard(a)).join("")}</div>`}
        </section>
        <footer class="footer">HAlarm 0.9.1 beta · Google Cast · ${alarms.length} alarmer gemt</footer>
      </main>
    </div>
    <div class="modal-layer" id="modal-layer"></div><div class="toast ${this._toastText ? `show ${this._toastIsError ? "bad" : ""}` : ""}" role="status" aria-live="polite">${ESC(this._toastText)}</div>`;
    if (this._editing) this._showEditor();
    if (this._settingsOpen) this._showSettings();
  }
  _defaultAlarm() {
    const tomorrow = "07:00";
    return {name: "Morgenalarm", time: tomorrow, days: [0,1,2,3,4], volume: 60,
      sound: this._snapshot?.sounds?.[0]?.file || "",
      device: this._snapshot?.devices?.[0]?.entity_id || "",
      enabled: true};
  }
  _openEditor(id) {
    this._editing = id ? {...this._snapshot.alarms.find(a => a.id === id)} : this._defaultAlarm();
    this._showEditor();
  }
  _stopPreview() { if(this._preview){ this._preview.pause();this._preview.currentTime=0;this._preview=null; } }
  _closeEditor() {this._stopPreview(); this._editing = null;this._shadowModal("");}
  _shadowModal(html) { const layer=this.shadowRoot.querySelector("#modal-layer"); if(layer)layer.innerHTML=html; }
  _showEditor() {
    const item = this._editing; if (!item) return;
    const sounds=this._snapshot?.sounds || [], devices=this._snapshot?.devices || [];
    const options = (items,value,key,label) => items.map(x=>`<option value="${ESC(x[key])}" ${x[key]===value ? "selected" : ""}>${ESC(x[label])}</option>`).join("");
    this._shadowModal(`<div class="overlay" data-action="dismiss"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="edit-title">
      <div class="dialog-top"><div><p class="eyebrow dark">ALARMINDSTILLINGER</p><h2 id="edit-title">${item.id ? "Rediger alarm" : "Ny alarm"}</h2></div><button class="icon-button" data-action="dismiss" aria-label="Luk">${ico("close")}</button></div>
      <div class="dialog-scroll"><label class="field-label" for="a-name">Navn på alarmen</label><input id="a-name" class="field" type="text" maxlength="70" value="${ESC(item.name)}" placeholder="F.eks. Arbejdsdag" />
      <div class="form-gap"><label class="field-label" for="a-time">Hvornår skal alarmen ringe?</label>
      <input id="a-time" class="time-input" type="time" value="${ESC(item.time)}" required /></div>
      <div class="form-gap"><div class="field-label">Hvilke dage?</div>
      <div class="quick-days"><button data-action="preset" data-days="0,1,2,3,4,5,6">Hver dag</button><button data-action="preset" data-days="0,1,2,3,4">Hverdage</button><button data-action="preset" data-days="5,6">Weekend</button></div>
      <div class="day-picker">${DAY_LABELS.map((txt,n)=>`<button class="day-chip ${item.days.includes(n)?"selected":""}" aria-pressed="${item.days.includes(n)}" data-action="day" data-day="${n}">${txt}</button>`).join("")}</div></div>
      <div class="dialog-grid form-gap"><div><label class="field-label" for="a-device">Afspil på</label><div class="select-wrap">${ico("speaker", 18)}<select id="a-device" class="field"><option value="">Vælg højttaler</option>${options(devices,item.device,"entity_id","name")}</select></div></div>
      <div><label class="field-label" for="a-sound">Vælg alarmlyd</label><div class="select-wrap">${ico("sound", 18)}<select id="a-sound" class="field"><option value="">Vælg lyd</option>${options(sounds,item.sound,"file","label")}</select></div></div></div>
      <div class="form-gap volume-panel"><div class="volume-head"><label class="field-label" for="a-volume">Lydstyrke når alarmen starter</label><strong id="volume-value">${item.volume}%</strong></div>
      <input id="a-volume" type="range" min="10" max="100" step="5" value="${item.volume}" style="--fill:${(item.volume-10)/90*100}%" />
      <div class="volume-foot"><span>Stille</span><button class="preview-link" data-action="preview">${ico("play", 15)} Hør valgt lyd</button><span>Højt</span></div></div>
      <div class="enabled-inline"><div><b>Aktiv alarm</b><small>Slå fra uden at slette alarmen</small></div><label class="switch"><input id="a-enabled" type="checkbox" ${item.enabled?"checked":""}><span></span></label></div>
      </div>
      <div class="dialog-actions">${item.id ? `<button class="delete-button" data-action="delete" data-id="${ESC(item.id)}">${ico("trash", 18)} Slet</button>` : "<span></span>"}
      <div class="action-right"><button class="secondary" data-action="dismiss">Annuller</button><button class="primary" data-action="save">${ico("check", 18)} Gem alarm</button></div></div>
      </section></div>`);
    this.shadowRoot.querySelector("#a-name")?.focus();
  }
  _showSettings() {
    this._shadowModal(`<div class="overlay" data-action="settings-dismiss"><section class="dialog settings-dialog" role="dialog" aria-modal="true"><div class="dialog-top"><div><p class="eyebrow dark">INDSTILLINGER</p><h2>Forbindelse og lydfiler</h2></div><button class="icon-button" data-action="settings-dismiss" aria-label="Luk">${ico("close")}</button></div>
    <div class="dialog-scroll"><label for="base-url" class="field-label">Home Assistants interne adresse</label>
    <input class="field" id="base-url" type="url" placeholder="http://192.168.1.20:8123" value="${ESC(this._snapshot?.base_url || this._snapshot?.suggested_url || "")}">
    <p class="help">HAlarmen forsøger først via Home Assistants mediebibliotek og derefter denne URL. Brug en direkte LAN IP adresse såsom <b>http://192.168.1.20:8123</b>, ikke <b>homeassistant.local</b>, localhost eller Nabu Casa. Nest Hub skal selv kunne hente MP3 filen.</p>
    <div class="settings-box"><b>Seneste stop og afspilningstilstande</b><p>Brug dette ved fejl på Google Nest og Nest Mini. En almindelig afslutning vises som "naturlig afslutning".</p><pre class="diag-log">${ESC((this._snapshot?.transitions || []).slice(-15).map(x => `${x.at} ${this._device(x.device)}: ${x.from} → ${x.to} (${x.note})`).join("\n") || "Ingen registrerede ændringer endnu")}</pre></div>
    <div class="settings-box"><b>Hvor ligger alarmlydene?</b><code>/config/halarm/sounds/</code><p>Alle MP3 filer i mappen vises automatisk, eksempelvis <b>Morning.mp3</b> som <b>Morning</b>. Tidligere navne som <b>Alarm_Morning.mp3</b> virker stadig og vises også som <b>Morning</b>. Tryk på “Opdater lyde” efter at have lagt nye filer i mappen.</p></div></div>
    <div class="dialog-actions"><span></span><div class="action-right"><button class="secondary" data-action="settings-dismiss">Luk</button><button class="primary" data-action="settings-save">${ico("check",18)} Gem</button></div></div></section></div>`);
    this.shadowRoot.querySelector("#base-url")?.focus();
  }
  async _execute(work, ok) {
    if (this._busy) return;
    this._busy = true;
    try { await work(); this._toast(ok || "Gemt"); return true; }
    catch(e) { this._toast(this._getError(e), true); return false; }
    finally { this._busy = false; }
  }
  async _onClick(event) {
    const el = event.target.closest("[data-action]"); if (!el) return;
    const action=el.dataset.action, id=el.dataset.id;
    // Clicking inside a dialog must not count as an overlay click.
    if ((action === "dismiss" || action === "settings-dismiss") && el.classList.contains("overlay") && event.target !== el) return;
    if (action === "add") { this._openEditor(null); return; }
    if (action === "edit") { this._openEditor(id); return; }
    if (action === "dismiss") { this._closeEditor(); return; }
    if (action === "settings-dismiss") { this._settingsOpen=false; this._shadowModal(""); return; }
    if (action === "settings") { this._settingsOpen=true; this._showSettings(); return; }
    if (action === "refresh") { await this._load(true); this._toast("Lydfiler opdateret"); return; }
    if (action === "day") { const active=el.getAttribute("aria-pressed") !== "true";el.setAttribute("aria-pressed",String(active));el.classList.toggle("selected",active);return; }
    if (action === "preset") {
      const selection = el.dataset.days.split(",").map(Number);
      this.shadowRoot.querySelectorAll(".day-chip").forEach(chip=>{
        const active=selection.includes(Number(chip.dataset.day));chip.setAttribute("aria-pressed",String(active));chip.classList.toggle("selected",active);
      });return;
    }
    if (action === "preview") {
      const file=this.shadowRoot.querySelector("#a-sound")?.value;
      if (!file) return this._toast("Vælg først en lydfil", true);
      if (this._preview && !this._preview.paused) {this._stopPreview();el.innerHTML=`${ico("play",15)} Hør valgt lyd`;return;}
      this._stopPreview();this._preview=new Audio(`/local/halarm/${encodeURIComponent(file)}`);
      this._preview.volume = Math.min(1,Number(this.shadowRoot.querySelector("#a-volume")?.value || 60)/100);
      this._preview.play().catch(()=>this._toast("Lyden kunne ikke afspilles i browseren",true));
      el.textContent="Stop lydprøve";this._preview.onended=()=>{el.innerHTML=`${ico("play",15)} Hør valgt lyd`;};return;
    }
    if (action === "save") {
      const val = sel=>this.shadowRoot.querySelector(sel)?.value;
      const days=Array.from(this.shadowRoot.querySelectorAll(".day-chip[aria-pressed='true']")).map(e=>Number(e.dataset.day)).sort();
      const data={...this._editing,name:val("#a-name"),time:val("#a-time"),days,device:val("#a-device"),sound:val("#a-sound"),volume:Number(val("#a-volume")),enabled:this.shadowRoot.querySelector("#a-enabled")?.checked};
      if (!days.length) return this._toast("Vælg mindst én ugedag",true);
      if (!data.device || !data.sound) return this._toast("Vælg både enhed og lydfil",true);
      const success=await this._execute(()=>this._ws("save",{alarm:data}),"Alarm gemt");
      if(success){this._closeEditor();await this._load();}return;
    }
    if (action === "delete") {
      if(!confirm("Vil du slette alarmen?"))return;
      const alarmId = id || this._editing?.id;
      if (!alarmId) return this._toast("Alarm-ID mangler. Genindlæs siden.", true);
      if(await this._execute(()=>this._ws("delete",{alarm_id:String(alarmId)}),"Alarm slettet")){this._closeEditor();await this._load();}return;
    }
    if (action === "settings-save") {
      const base_url=this.shadowRoot.querySelector("#base-url")?.value || "";
      if(await this._execute(()=>this._ws("settings",{base_url}),"Indstillinger gemt")){this._settingsOpen=false;this._shadowModal("");await this._load();}return;
    }
    if (action === "test") {if(await this._execute(()=>this._ws("start",{alarm_id:id}),"Alarmen tester nu – stop den med stemmen eller knappen")) await this._load();return;}
    if (action === "stop") {if(await this._execute(()=>this._ws("stop",{alarm_id:id}),"Alarm stoppet"))await this._load();return;}
    if (action === "stop-all") {
      await this._execute(()=>this._ws("stop_all"),"Alle alarmer stoppet");await this._load();return;
    }
  }
  async _onChange(event) {
    const el=event.target;
    if (el.dataset.action === "toggle") {
      const id=el.dataset.id, enabled=el.checked;
      if(await this._execute(()=>this._ws("toggle",{alarm_id:id,enabled}),enabled?"Alarm aktiveret":"Alarm deaktiveret"))await this._load();
      else el.checked=!enabled;
    }
    if(el.id === "a-sound") {this._stopPreview();const btn=this.shadowRoot.querySelector(".preview-link");if(btn)btn.innerHTML=`${ico("play",15)} Hør valgt lyd`;}
  }
  _onInput(event) {
    if(event.target.id === "a-volume") {
      this.shadowRoot.querySelector("#volume-value").textContent=`${event.target.value}%`;
      event.target.style.setProperty("--fill",`${(event.target.value-10)/90*100}%`);
    }
  }
}

const STYLE = `
:host{display:block;min-height:100%;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--primary-text-color,#26313a);--ink:var(--primary-text-color,#403a2e);--muted:var(--secondary-text-color,#766e60);--line:rgba(142,121,80,.20);--bg:var(--primary-background-color,#f7f4ed);--panel:var(--card-background-color,#fffdf8);--blue:#98782e;--blue-dark:#795e22;--soft:#f3eddb;}
*{box-sizing:border-box} button,input,select{font:inherit} button{cursor:pointer} button:disabled{opacity:.5;cursor:wait} svg{flex:none}.page{background:var(--bg);min-height:100vh}.topbar{height:77px;padding:0 clamp(20px,5vw,76px);background:var(--panel);border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between}.brand{display:flex;align-items:center;gap:12px;font-size:12px;font-weight:850;letter-spacing:.18em}.brand-icon{width:39px;height:39px;border-radius:12px;background:#eaeefe;color:var(--blue);display:grid;place-items:center}.icon-button{width:40px;height:40px;display:grid;place-items:center;border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--muted);transition:.2s}.icon-button:hover{color:var(--blue);border-color:var(--blue)}.main{max-width:1240px;margin:auto;padding:32px clamp(18px,4vw,42px) 50px}.hero{background:linear-gradient(118deg,#1f2b59 0%,#3245a0 58%,#586ae2 100%);color:white;border-radius:27px;min-height:288px;display:flex;position:relative;overflow:hidden;justify-content:space-between;gap:24px;align-items:center;padding:46px clamp(30px,5vw,66px);box-shadow:0 22px 55px #23377921}.hero::after{content:"";width:420px;height:420px;position:absolute;right:-180px;top:-220px;border:1px solid #ffffff2b;border-radius:50%}.eyebrow{font-size:11px;letter-spacing:.16em;font-weight:800;margin:0 0 13px;color:#bacaff}.eyebrow.dark{color:var(--blue);margin-bottom:8px}.hero-copy{position:relative;z-index:1}.hero h1{font-size:clamp(29px,3.6vw,45px);letter-spacing:-.045em;line-height:1.12;margin:0;font-weight:760;max-width:520px}.period{color:#97b5ff}.hero-description{color:#dae2ff;margin:18px 0 25px;line-height:1.6;max-width:420px;font-size:14px}.hero-actions{display:flex;gap:10px;flex-wrap:wrap}.primary{display:inline-flex;gap:10px;align-items:center;justify-content:center;border:0;color:#fff;background:var(--blue);font-weight:750;border-radius:12px;padding:12px 20px;transition:.15s;white-space:nowrap;min-height:46px}.primary:hover{background:var(--blue-dark);transform:translateY(-1px)}.hero .primary{background:white;color:#3044a2}.hero .primary:hover{background:#e9efff}.subtle{background:#ffffff1a;color:#fff;border:1px solid #ffffff45;display:inline-flex;align-items:center;gap:8px;border-radius:12px;padding:12px 16px;font-weight:650}.subtle:hover{background:#ffffff33}.hero-widget{z-index:1;position:relative;text-align:center;min-width:215px;max-width:240px;padding:17px 4px}.widget-orbit{width:198px;height:198px;position:absolute;border:1px solid #ffffff30;border-radius:50%;inset:-12px 10px auto;pointer-events:none}.widget-glyph{color:#c1ceff;margin-bottom:7px}.widget-label{font-size:10px;letter-spacing:.17em;color:#c1ceff;font-weight:800;margin:4px 0 4px}.widget-time{font-size:48px;font-weight:800;letter-spacing:-.06em;line-height:1.1}.widget-caption{font-size:12px;color:#e1e7ff;margin-top:11px;line-height:1.5}.list-section{padding-top:41px}.section-heading{display:flex;align-items:end;justify-content:space-between;margin-bottom:21px}.section-heading h2{font-size:25px;letter-spacing:-.035em;margin:0;font-weight:760}.section-caption{color:var(--muted);font-size:13px;padding-bottom:4px}.count{font-size:12px;background:var(--soft);color:var(--blue);padding:5px 9px;border-radius:10px;vertical-align:middle;letter-spacing:0;margin-left:6px}.alarm-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:17px}.alarm-card{background:var(--panel);border:1px solid var(--line);border-radius:22px;padding:25px;min-width:0;box-shadow:0 5px 16px #31435b08;transition:transform .15s,border .15s}.alarm-card:hover{transform:translateY(-2px);border-color:#bfc6ef}.alarm-card.disabled{opacity:.62}.alarm-card.ringing{border-color:#f4a15c;box-shadow:0 0 0 3px #ffba722e}.alarm-card-main{display:flex;justify-content:space-between;gap:15px;align-items:start}.alarm-time{font-size:48px;letter-spacing:-.065em;font-weight:760;line-height:1}.alarm-name{font-size:15px;font-weight:700;margin-top:11px}.alarm-days{font-size:12px;font-weight:650;color:var(--blue);margin-top:17px;background:var(--soft);border-radius:9px;padding:6px 10px;display:inline-block;min-height:28px}.alarm-meta{display:flex;flex-wrap:wrap;gap:8px 15px;margin-top:24px;color:var(--muted);font-size:12px;border-bottom:1px solid var(--line);padding-bottom:20px}.alarm-meta span{display:inline-flex;align-items:center;gap:5px;overflow-wrap:anywhere}.alarm-card-footer{display:flex;align-items:center;justify-content:space-between;margin-top:16px;gap:8px}.next-chip{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px}.next-chip.live{color:#e8802c;font-weight:800}.card-actions{display:flex;gap:7px}.mini{display:flex;gap:5px;align-items:center;justify-content:center;border:1px solid var(--line);background:transparent;color:var(--ink);padding:9px 11px;border-radius:10px;font-size:12px;font-weight:700}.mini:hover{background:var(--soft);border-color:#c9ceef}.mini.edit{color:var(--blue)}.mini.danger{background:#fff0eb;color:#b6482a;border-color:#ffc8b3}.switch{position:relative;display:inline-flex;align-items:center;flex:none;cursor:pointer}.switch input{position:absolute;opacity:0;width:1px;height:1px}.switch span{display:inline-block;width:47px;height:28px;border-radius:28px;background:#c6cdd6;position:relative;transition:.2s}.switch span:after{content:"";background:#fff;width:22px;height:22px;border-radius:100%;position:absolute;top:3px;left:3px;box-shadow:0 2px 4px #0002;transition:.2s}.switch input:checked+span{background:var(--blue)}.switch input:checked+span:after{transform:translateX(19px)}.switch input:focus-visible+span{outline:3px solid #9caeff}.live-strip{background:#fff5ed;border:1px solid #f9d5b9;color:#a25427;border-radius:15px;display:flex;align-items:center;gap:14px;padding:14px 18px;margin-top:19px}.live-dot{width:13px;height:13px;background:#ed7a2e;border-radius:50%;box-shadow:0 0 0 6px #ffd6b7;animation:pulse 1.2s infinite}.live-strip div{flex:1;display:grid;gap:2px}.live-strip small{font-size:12px}.stop-all{border:0;border-radius:9px;background:#ad4a26;color:white;padding:10px 13px;display:flex;align-items:center;gap:8px;font-weight:700}.notice{margin-top:18px;display:flex;align-items:center;gap:12px;border:1px solid #dde2f7;border-radius:14px;padding:13px 16px;background:var(--panel);font-size:13px;color:var(--muted)}.notice span{flex:1}.notice button{color:var(--blue);border:0;background:transparent;font-weight:700}.notice.error{color:#b32742;border-color:#f8baca}.empty-state{display:flex;flex-direction:column;align-items:center;text-align:center;padding:57px 20px;background:var(--panel);border:1px dashed #bbc7dc;border-radius:19px}.empty-icon{display:grid;place-items:center;border-radius:20px;width:72px;height:72px;color:var(--blue);background:var(--soft)}.empty-state h3{font-size:22px;margin:20px 0 2px}.empty-state p{color:var(--muted);max-width:330px;font-size:14px;line-height:1.6;margin-bottom:22px}.empty{background:var(--panel);border-radius:16px;padding:38px;text-align:center;color:var(--muted)}.footer{text-align:center;color:var(--muted);font-size:12px;margin-top:35px;opacity:.7}.overlay{position:fixed;z-index:1000;inset:0;background:#1721399e;display:flex;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(5px)}.dialog{background:var(--panel);border-radius:22px;width:min(100%,635px);max-height:min(93vh,950px);display:flex;flex-direction:column;color:var(--ink);box-shadow:0 30px 100px #0003;overflow:hidden}.dialog-top{display:flex;align-items:center;justify-content:space-between;padding:25px 29px;border-bottom:1px solid var(--line)}.dialog-top h2{font-size:24px;letter-spacing:-.035em;margin:0}.dialog-scroll{padding:26px 30px 23px;overflow-y:auto;overscroll-behavior:contain}.field-label{display:block;font-size:13px;font-weight:760;margin-bottom:10px;color:var(--ink)}.field{background:var(--panel);border:1px solid #cbd3de;color:var(--ink);border-radius:11px;padding:12px 13px;width:100%;min-height:46px;outline:0}.field:focus,.time-input:focus{border-color:var(--blue);box-shadow:0 0 0 3px #526ee823}.time-input{font-size:43px;letter-spacing:-.035em;font-weight:750;max-width:255px;width:100%;border:1px solid #cbd3de;border-radius:13px;background:var(--panel);color:var(--ink);padding:9px 14px;outline:0;min-height:73px;color-scheme:light}.form-gap{margin-top:22px}.quick-days{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}.quick-days button{font-size:12px;font-weight:720;color:var(--blue);background:var(--soft);border:1px solid #dfe3fb;padding:8px 12px;border-radius:9px}.quick-days button:hover{background:#dce4ff}.day-picker{display:flex;gap:8px;flex-wrap:wrap}.day-chip{width:49px;height:46px;border:1px solid #d5dbe3;border-radius:11px;background:var(--panel);color:var(--muted);font-size:12px;font-weight:760}.day-chip.selected{background:var(--blue);border-color:var(--blue);color:#fff;box-shadow:0 3px 10px #526ee828}.dialog-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.select-wrap{position:relative}.select-wrap svg{position:absolute;left:12px;top:15px;color:var(--blue);pointer-events:none}.select-wrap select{padding-left:37px;max-width:100%;text-overflow:ellipsis;appearance:auto}.volume-panel{padding:19px 19px 16px;background:var(--soft);border-radius:16px}.volume-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.volume-head .field-label{margin:0}.volume-head strong{color:var(--blue);font-size:18px}.volume-panel input[type=range]{width:100%;margin:22px 0 16px;appearance:none;height:7px;border-radius:10px;background:linear-gradient(to right,var(--blue) var(--fill),#d0d7e8 var(--fill));cursor:pointer}.volume-panel input[type=range]::-webkit-slider-thumb{appearance:none;border-radius:50%;width:20px;height:20px;background:#fff;border:5px solid var(--blue);box-shadow:0 2px 7px #0002}.volume-foot{display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--muted)}.preview-link{border:0;background:transparent;color:var(--blue);display:flex;align-items:center;gap:5px;font-weight:750;font-size:12px}.enabled-inline{display:flex;align-items:center;justify-content:space-between;padding:17px 0 2px}.enabled-inline div{display:flex;flex-direction:column;gap:4px}.enabled-inline b{font-size:13px}.enabled-inline small{font-size:12px;color:var(--muted)}.dialog-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid var(--line);padding:17px 29px;background:var(--panel)}.action-right{display:flex;align-items:center;gap:9px}.secondary{border:1px solid var(--line);background:var(--panel);border-radius:11px;padding:12px 16px;color:var(--ink);font-weight:700}.delete-button{border:0;color:#d14b53;background:transparent;display:flex;align-items:center;gap:6px;font-size:13px;font-weight:760}.toast{position:fixed;z-index:2000;left:50%;bottom:30px;max-width:min(90vw,580px);background:#263f43;color:#fff;padding:13px 19px;border-radius:12px;box-shadow:0 15px 40px #0004;transform:translate(-50%,100px);opacity:0;pointer-events:none;transition:.24s;text-align:center;font-size:13px}.toast.show{transform:translate(-50%,0);opacity:1}.toast.bad{background:#bb4050}.help{line-height:1.6;color:var(--muted);font-size:12px;margin:8px 0 19px}.settings-box{background:var(--soft);border-radius:15px;padding:18px;font-size:13px}.settings-box code{display:block;overflow-wrap:anywhere;margin-top:13px;padding:10px;background:var(--panel);border-radius:8px;color:var(--blue)}.settings-box p{line-height:1.6;color:var(--muted)}
@keyframes pulse{50%{box-shadow:0 0 0 10px #ffd6b700}}
@media(max-width:840px){.hero{padding:34px 29px}.hero-widget{min-width:160px}.widget-time{font-size:40px}.alarm-grid{grid-template-columns:1fr}}@media(max-width:590px){.topbar{height:64px;padding:0 20px}.main{padding:19px 14px 30px}.hero{display:block;padding:29px 24px}.hero h1{font-size:31px}.hero-widget{margin:28px auto 0;padding:0;max-width:100%;display:flex;align-items:center;gap:11px;flex-wrap:wrap;text-align:left}.widget-orbit,.widget-glyph{display:none}.widget-label{width:100%;margin:0}.widget-time{font-size:35px}.widget-caption{margin:0}.list-section{padding-top:29px}.alarm-card{padding:20px}.alarm-time{font-size:43px}.alarm-meta{margin-top:17px}.alarm-card-footer{flex-wrap:wrap}.overlay{padding:0;align-items:end}.dialog{max-height:95dvh;border-radius:22px 22px 0 0;width:100%}.dialog-top{padding:20px}.dialog-scroll{padding:20px}.dialog-grid{grid-template-columns:1fr}.dialog-actions{padding:15px 20px}.day-picker{gap:5px}.day-chip{width:calc((100% - 6*5px)/7);min-width:0}.live-strip{flex-wrap:wrap}.stop-all{margin-left:auto}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}


/* HAlarm warm muted-yellow design: follows ESPHealth's clear, calm dashboard language. */
:host{--ink:#473f30;--muted:#79705f;--line:#e8dfcc;--bg:#f7f4ed;--panel:#fffdf8;--blue:#96742b;--blue-dark:#795b1c;--soft:#f3ebd7;}
.page{background:var(--bg)}
.topbar{height:70px;max-width:1540px;margin:auto;background:transparent;border-bottom:1px solid var(--line);padding:0 32px}
.brand{font-size:16px;letter-spacing:-.03em;font-weight:700;color:#544631}
.brand-icon{background:#eee0bb;color:#856823;border-radius:10px}
.main{max-width:1340px;padding:24px 32px 45px}
.hero{background:#eee4cc;border:1px solid #dfd1ae;box-shadow:none;min-height:246px;border-radius:17px;color:#453b2c;padding:32px 43px}
.hero::after{border-color:#cdbb8a66}
.hero h1{font-size:clamp(28px,3vw,40px)}
.hero .eyebrow,.eyebrow.dark{color:#896d30}
.hero-description{color:#71634c;margin:14px 0 24px}
.period{color:#ad8839}
.hero .primary{background:#92712d;color:#fff}
.hero .primary:hover{background:#775a24}
.hero .subtle{background:#f9f3e4;color:#665534;border-color:#d3c098}
.hero .subtle:hover{background:#fff9e9}
.widget-label,.widget-glyph{color:#987931}
.widget-caption{color:#7b694c}
.widget-orbit{border-color:#cfbd9566}
.alarm-card{border-radius:15px;box-shadow:none;padding:22px}
.alarm-card:hover{border-color:#c9b57e;transform:translateY(-1px)}
.alarm-card.ringing{border-color:#caa45a;box-shadow:0 0 0 3px #e9ce8a55}
.alarm-days{color:#73591f}
.count{border-radius:8px}
.mini,.icon-button,.secondary{background:#fffdfa;border-color:#e1d7c6}
.mini.edit{color:#88691f}
.mini:hover,.icon-button:hover{background:#f6edda;border-color:#c9b57e}
.switch input:checked+span{background:#9f7d35}
.switch input:focus-visible+span{outline:3px solid #e0c37d}
.volume-panel{background:#f6f0e1;border:1px solid #eadbbd}
.day-chip.selected{background:#92712d;border-color:#92712d;box-shadow:none}
.quick-days button{border-color:#e1d4b8;color:#7b6127;background:#f6eeda}
.quick-days button:hover{background:#ecdfbd}
.dialog{border-radius:18px}
.field,.time-input{border-color:#d8cdba}
.field:focus,.time-input:focus{border-color:#a18a50;box-shadow:0 0 0 3px #dccb9d55}
.volume-panel input[type=range]{background:linear-gradient(to right,#9e7f3c var(--fill),#ddd2b8 var(--fill))}
.volume-panel input[type=range]::-webkit-slider-thumb{border-color:#9e7f3c}
.notice{background:#fffdf8;border-color:#e9dfcc}
.empty-state{border-color:#d9cda9}
.toast{background:#4b4536}
.settings-box{margin-top:14px;background:#f5efdf}
.diag-log{white-space:pre-wrap;max-height:190px;overflow:auto;overflow-wrap:anywhere;font:11px/1.5 ui-monospace,monospace;color:#62563d;background:#fffbf2;border:1px solid #e7ddc4;padding:10px;border-radius:8px}
button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #b99a50;outline-offset:3px}
.overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:18px}
.overview>div{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:17px 20px;display:grid;gap:9px}
.overview span{font-size:12px;color:var(--muted)}.overview strong{font-size:27px;font-variant-numeric:tabular-nums;font-weight:650}.overview small{font-size:15px;color:var(--muted);font-weight:400}.overview .status-value{font-size:18px;align-self:center;color:var(--blue)}
.widget-orbit,.hero::after{display:none}.hero-widget{border-left:1px solid #d7c9a7;padding-left:30px}.alarm-time,.widget-time{font-variant-numeric:tabular-nums}
@media(prefers-color-scheme:dark){:host{--ink:#ede6d7;--muted:#bdb39f;--line:#484231;--bg:#211f19;--panel:#2b2820;--soft:#393222;--blue:#d5b765;--blue-dark:#b69a4d;color:var(--ink)}.hero{background:#383121;color:#f1e6cb;border-color:#605237}.hero-description,.widget-caption{color:#d3c5a5}.hero .eyebrow,.widget-label,.widget-glyph,.brand,.alarm-days,.mini.edit{color:#d5b765}.mini,.icon-button,.secondary,.notice{background:var(--panel);color:var(--ink);border-color:var(--line)}.settings-box,.volume-panel{background:var(--soft)}.diag-log{background:var(--panel);color:var(--ink);border-color:var(--line)}.primary,.day-chip.selected{color:#241f14;background:#d5b765}.time-input{color-scheme:dark}}
@media(max-width:590px){.overview{gap:7px}.overview>div{padding:12px 9px}.overview span{font-size:10px}.overview strong{font-size:24px}.overview .status-value{font-size:13px}.hero-widget{border-left:0;border-top:1px solid #d7c9a7;padding-top:17px}.topbar{padding:0 18px}.main{padding:15px 12px 28px}.hero{padding:25px 21px;border-radius:15px}}
`;
if (!customElements.get("halarm-app")) customElements.define("halarm-app", AlarmPanel);
