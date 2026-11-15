/* HAlarm 0.9.2 beta — standalone Home Assistant sidebar panel, no npm dependencies. */
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
      <header class="topbar"><div class="brand"><div class="brand-icon">${ico("alarm", 25)}</div><div><strong>HAlarm</strong><small>Vækkealarmer til Google Nest</small></div></div>
      <div class="header-right"><span class="local-status ${active ? "is-ringing" : ""}">${active ? "Alarmen ringer" : "Kører lokalt"}</span><span class="version">0.9.2 Beta</span><button class="icon-button" data-action="settings" aria-label="Indstillinger" title="Indstillinger">${ico("tune")}</button></div></header>
      <main class="main">
        <section class="hero">
          <div class="hero-copy"><p class="eyebrow">DIT PERSONLIGE VÆKKEUR</p>
          <h1>Dine vækkealarmer</h1>
          <p class="hero-description">Vælg tidspunkt, højttaler og lyd. HAlarm sørger for resten.</p></div>
          <div class="hero-actions"><button class="primary" data-action="add">${ico("add", 19)} Tilføj alarm</button><button class="secondary" data-action="refresh">${ico("refresh", 17)} Opdater lyde</button></div>
        </section>
        <section class="overview" aria-label="Alarmoversigt">
          <div><span class="stat-icon">${ico("clock",22)}</span><div><span>Næste vækning</span><strong>${next ? ESC(next.time) : "—"}</strong><small>${next ? ESC(this._next(next).text) + " · " + ESC(next.name) : "Ingen aktive alarmer"}</small></div></div>
          <div><span class="stat-icon">${ico("alarm",22)}</span><div><span>Aktive alarmer</span><strong>${on}<small> / ${alarms.length}</small></strong><small>${active ? `${active} ringer nu` : "Klar til næste vækning"}</small></div></div>
          <div><span class="stat-icon">${ico("sound",22)}</span><div><span>Alarmlyde</span><strong>${s?.sounds?.length || 0}</strong><small>Dine gemte MP3-filer</small></div></div>
        </section>
        ${active ? `<section class="live-strip"><span class="live-dot"></span><div><b>${active} alarm${active > 1 ? "er" : ""} ringer</b><small>Sig “Hey Google, stop” eller brug Stop</small></div><button class="stop-all" data-action="stop-all">${ico("stop", 18)} Stop alle</button></section>` : ""}
        ${!s?.base_url ? `<section class="notice">${ico("info", 19)} <span>Home Assistants mediebibliotek bruges til alarmlyde. Angiv gerne en lokal IP adresse under Indstillinger som reservevej til Nest Hub.</span><button data-action="settings">Indstil</button></section>` : ""}
        ${s && !s.sounds.length ? `<section class="notice">${ico("info", 19)} <span>Ingen lydfiler endnu. Læg <code>*.mp3</code> i <code>halarm/sounds/</code>.</span><button data-action="refresh">Søg igen</button></section>` : ""}
        <section class="list-section"><div class="section-heading"><div><h2>Dine alarmer <span class="count">${alarms.length}</span></h2></div><span class="section-caption">${on} aktive</span></div>
        ${this._error ? `<div class="notice error">${ico("info")} ${ESC(this._error)}</div>` : ""}
        ${s?.last_error ? `<div class="notice error">${ico("info")} <span>Seneste afspilningsfejl: ${ESC(s.last_error)}</span></div>` : ""}
        ${!s ? `<div class="empty">Indlæser alarmcentralen…</div>` : empty ? `<div class="empty-state"><div class="empty-icon">${ico("moon", 35)}</div><h3>Ingen alarmer endnu</h3><p>Begynd med din første alarm. Vælg klokken, ugedage, lyd og højttaler.</p><button class="primary" data-action="add">${ico("add")} Opret din første alarm</button></div>` : `<div class="alarm-grid">${alarms.sort((a,b) => Number(b.enabled)-Number(a.enabled) || a.time.localeCompare(b.time)).map(a=>this._alarmCard(a)).join("")}</div>`}
        </section>
        <footer class="footer">HAlarm 0.9.2 beta · Google Cast · ${alarms.length} alarmer gemt</footer>
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
:host{display:block;min-height:100%;font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#29383b;color-scheme:light;--ink:#29383b;--muted:#718084;--line:#e2e8e9;--bg:#f5f7f8;--panel:#fff;--blue:#766020;--blue-dark:#624e17;--soft:#faf5e4;--accent:#e5cc76}
*{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer}button:disabled{opacity:.5;cursor:wait}svg{flex:none}button,input,select{touch-action:manipulation}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #c3a64c;outline-offset:3px}
.page{background:var(--bg);min-height:100vh}.topbar{height:84px;max-width:1376px;margin:auto;padding:0 42px;display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--line)}.brand{display:flex;align-items:center;gap:12px}.brand-icon{width:43px;height:43px;border-radius:12px;background:#f3eacb;color:#806b2b;display:grid;place-items:center}.brand strong{display:block;font-size:21px;font-weight:650;letter-spacing:-.6px}.brand small{display:block;font-size:11px;color:var(--muted);margin-top:2px}.header-right{display:flex;align-items:center;gap:16px}.version{font-size:11px;border:1px solid var(--line);padding:5px 8px;border-radius:5px;color:var(--muted);white-space:nowrap}.local-status{font-size:11px;color:var(--muted);white-space:nowrap}.local-status:before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:#6e9d87;margin-right:7px}.local-status.is-ringing:before{background:#bf8133}.icon-button{width:38px;height:38px;display:grid;place-items:center;background:white;border:1px solid var(--line);color:#647579;border-radius:9px}
.main{max-width:1376px;margin:auto;padding:0 42px 28px}.hero{display:flex;align-items:center;justify-content:space-between;gap:25px;padding:32px 0 27px}.eyebrow{font-size:10px;font-weight:700;letter-spacing:1.7px;color:#8a773d;margin:0 0 10px}h1{font-size:clamp(25px,3vw,34px);letter-spacing:-1px;font-weight:650;line-height:1.15;margin:0}.hero-description{font-size:13px;color:var(--muted);margin:11px 0 0}.hero-actions{display:flex;gap:8px;flex-wrap:wrap}.primary,.secondary,.subtle{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:42px;padding:10px 15px;border-radius:9px;font-size:12px;font-weight:600;white-space:nowrap}.primary{background:var(--accent);border:1px solid #d6bb60;color:#493d1d}.primary:hover{background:#ddc064}.secondary,.subtle{background:white;border:1px solid var(--line);color:#526367}.secondary:hover,.subtle:hover,.icon-button:hover{background:#f9fafb;border-color:#c7d2d4}
.overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-bottom:24px}.overview>div{display:flex;align-items:center;gap:14px;min-width:0;padding:20px;background:white;border:1px solid var(--line);border-radius:13px}.stat-icon{display:grid;place-items:center;width:44px;height:44px;flex:none;border-radius:11px;background:#faf5e6;color:#927a30}.overview>div>div{min-width:0}.overview span:not(.stat-icon){display:block;font-size:11px;color:var(--muted)}.overview strong{display:block;font-size:25px;font-weight:650;letter-spacing:-.7px;line-height:1.3;font-variant-numeric:tabular-nums}.overview small{display:block;font-size:11px;font-weight:400;color:var(--muted);overflow-wrap:anywhere}.overview strong small{display:inline;font-size:14px;letter-spacing:0}
.list-section{background:white;border:1px solid var(--line);border-radius:16px;padding:24px}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px}.section-heading h2{font-size:17px;font-weight:650;letter-spacing:-.4px;margin:0}.section-caption{font-size:11px;color:var(--muted)}.count{font-size:10px;vertical-align:middle;display:inline-block;margin-left:6px;background:#f1f4f5;color:#718084;padding:3px 7px;border-radius:5px;letter-spacing:0}.alarm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:16px}.alarm-card{background:white;border:1px solid var(--line);border-radius:12px;min-width:0;padding:20px;transition:border-color .15s}.alarm-card:hover{border-color:#c9d3d5}.alarm-card.disabled{background:#fafbfc}.alarm-card.disabled .alarm-time,.alarm-card.disabled .alarm-name{color:#829094}.alarm-card.ringing{border-color:#c6a84f;background:#fffdf6}.alarm-card-main{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.alarm-time{font-size:37px;font-weight:650;letter-spacing:-1.4px;line-height:1.1;font-variant-numeric:tabular-nums}.alarm-name{font-size:14px;font-weight:600;margin-top:8px;overflow-wrap:anywhere}.alarm-days{display:inline-block;font-size:10px;font-weight:500;background:#f4f6f7;color:#63767a;border-radius:5px;padding:4px 7px;margin-top:15px}.alarm-meta{display:grid;gap:8px;margin:18px 0 0;padding-bottom:17px;border-bottom:1px solid #edf1f2;font-size:11px;color:var(--muted)}.alarm-meta span{display:flex;align-items:center;gap:7px;overflow-wrap:anywhere}.alarm-card-footer{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:14px;flex-wrap:wrap}.next-chip{display:flex;align-items:center;gap:5px;color:var(--muted);font-size:10px}.next-chip.live{color:#98752a;font-weight:650}.card-actions{display:flex;gap:6px}.mini{display:inline-flex;align-items:center;justify-content:center;gap:5px;background:#f5f7f8;border:1px solid transparent;color:#52666b;border-radius:7px;font-size:11px;font-weight:550;padding:8px 10px;min-height:34px}.mini:hover{background:#edf1f2}.mini.edit{background:#faf5e6;color:#796323}.mini.edit:hover{background:#f3e9c9}.mini.danger{background:#fceee9;color:#a14e36;border-color:#f1d9cc}
.switch{position:relative;display:inline-flex;cursor:pointer;flex:none}.switch input{position:absolute;opacity:0;width:1px;height:1px}.switch span{display:block;width:42px;height:25px;border-radius:24px;background:#d8dfe1;position:relative}.switch span:after{content:"";position:absolute;left:3px;top:3px;width:19px;height:19px;background:white;border-radius:50%;box-shadow:0 1px 3px #0002;transition:transform .15s}.switch input:checked+span{background:#b7a05a}.switch input:checked+span:after{transform:translateX(17px)}.switch input:focus-visible+span{outline:3px solid #c3a64c;outline-offset:3px}
.live-strip{display:flex;align-items:center;gap:14px;background:#fff8e8;border:1px solid #ead7a4;border-radius:11px;padding:14px 18px;margin:0 0 18px;color:#806323}.live-dot{height:9px;width:9px;background:#bc9137;border-radius:50%;flex:none}.live-strip>div{flex:1;display:grid;gap:2px}.live-strip small{font-size:11px}.stop-all{display:flex;gap:7px;align-items:center;background:#8a622b;color:white;border:0;border-radius:8px;padding:10px 13px;font-size:12px;font-weight:600}.notice{display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:16px;background:white;color:var(--muted);font-size:12px}.notice span{flex:1;overflow-wrap:anywhere}.notice button{border:0;background:#faf5e6;border-radius:6px;color:#796323;padding:7px 10px;white-space:nowrap}.notice.error{color:#a44640;border-color:#efd0cd;background:#fff9f8}
.empty-state{display:flex;flex-direction:column;align-items:center;text-align:center;border:1px dashed var(--line);border-radius:12px;padding:38px 20px;background:#fafcfc}.empty-icon{width:60px;height:60px;border-radius:15px;background:var(--soft);color:#927a30;display:grid;place-items:center}.empty-state h3{font-size:20px;font-weight:600;margin:16px 0 0}.empty-state p{font-size:12px;color:var(--muted);max-width:330px;margin:10px 0 19px}.empty{padding:35px;text-align:center;color:var(--muted)}.footer{font-size:10px;color:#87979b;margin-top:22px;text-align:left}
.overlay{position:fixed;z-index:1000;inset:0;background:#20323766;display:flex;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(3px)}.dialog{background:white;border:1px solid var(--line);border-radius:16px;width:min(100%,635px);max-height:min(93dvh,950px);display:flex;flex-direction:column;color:var(--ink);box-shadow:0 25px 80px #20323726;overflow:hidden}.dialog-top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:23px 26px;border-bottom:1px solid var(--line)}.dialog-top h2{font-size:22px;font-weight:600;letter-spacing:-.7px;margin:0}.dialog-top .eyebrow{margin-bottom:5px}.dialog-scroll{padding:24px 26px;overflow-y:auto;overscroll-behavior:contain}.field-label{display:block;font-size:12px;font-weight:600;margin-bottom:8px;color:#52666b}.field,.time-input{display:block;width:100%;background:white;border:1px solid #d9e2e4;border-radius:8px;color:var(--ink);padding:11px 12px;min-height:44px;outline:none}.field:focus,.time-input:focus{border-color:#b49b4e}.time-input{font-size:35px;font-weight:600;letter-spacing:-1px;max-width:230px;min-height:63px;color-scheme:light}.form-gap{margin-top:20px}.quick-days{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}.quick-days button{font-size:11px;background:#f5f7f8;color:#63767a;border:1px solid var(--line);border-radius:7px;padding:8px 11px}.quick-days button:hover{background:#edf1f2}.day-picker{display:flex;gap:7px;flex-wrap:wrap}.day-chip{width:49px;min-height:42px;border:1px solid var(--line);border-radius:8px;background:white;color:var(--muted);font-size:11px}.day-chip.selected{background:#f4e9c4;border-color:#d5bd72;color:#69561e}.dialog-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.select-wrap{position:relative}.select-wrap svg{position:absolute;left:11px;top:13px;color:#88989c;pointer-events:none}.select-wrap select{padding-left:36px;max-width:100%;text-overflow:ellipsis}.volume-panel{border:1px solid var(--line);background:#f9fafb;border-radius:10px;padding:16px}.volume-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.volume-head .field-label{margin:0}.volume-head strong{color:#796323;font-size:16px}.volume-panel input[type=range]{width:100%;margin:20px 0 15px;appearance:none;height:6px;border-radius:8px;background:linear-gradient(to right,#b7a05a var(--fill),#e0e6e8 var(--fill));cursor:pointer}.volume-panel input[type=range]::-webkit-slider-thumb{appearance:none;border-radius:50%;width:19px;height:19px;background:white;border:4px solid #b7a05a}.volume-foot{display:flex;align-items:center;justify-content:space-between;font-size:10px;color:var(--muted)}.preview-link{border:0;background:transparent;color:#796323;display:flex;align-items:center;gap:5px;font-size:11px;font-weight:550}.enabled-inline{display:flex;align-items:center;justify-content:space-between;padding:16px 0 0;gap:12px}.enabled-inline div{display:grid;gap:3px}.enabled-inline b{font-size:12px;font-weight:600}.enabled-inline small{font-size:11px;color:var(--muted)}.dialog-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid var(--line);padding:16px 26px;background:white}.action-right{display:flex;align-items:center;gap:8px}.delete-button{display:flex;align-items:center;gap:6px;border:0;background:transparent;color:#ad5851;font-size:12px;padding:8px 0}.help{font-size:12px;color:var(--muted);line-height:1.65;margin:9px 0 20px}.settings-box{margin-top:16px;background:#f8fafb;border:1px solid var(--line);border-radius:10px;padding:16px;font-size:12px}.settings-box code{display:block;padding:10px;background:white;border:1px solid var(--line);border-radius:6px;margin-top:10px;color:#63767a;overflow-wrap:anywhere}.settings-box p{color:var(--muted);line-height:1.65}.diag-log{white-space:pre-wrap;max-height:190px;overflow:auto;overflow-wrap:anywhere;font:11px/1.6 ui-monospace,monospace;color:#52666b;background:white;border:1px solid var(--line);padding:10px;border-radius:7px}.toast{position:fixed;z-index:2000;left:50%;bottom:25px;max-width:min(90vw,580px);background:#34474c;color:white;padding:12px 18px;border-radius:9px;box-shadow:0 8px 30px #20323726;transform:translate(-50%,100px);opacity:0;pointer-events:none;transition:.2s;text-align:center;font-size:12px}.toast.show{transform:translate(-50%,0);opacity:1}.toast.bad{background:#a64d48}
@media(max-width:850px){.topbar{padding:0 24px}.main{padding:0 24px 24px}.hero{align-items:flex-start;flex-direction:column;gap:18px}.overview{gap:10px}.overview>div{padding:15px 12px;gap:9px}.stat-icon{width:35px;height:35px}.overview small{font-size:10px}}
@media(max-width:590px){.topbar{height:74px;padding:0 16px}.brand{gap:9px}.brand strong{font-size:19px}.brand small{font-size:10px}.brand-icon{width:37px;height:37px}.header-right{gap:8px}.local-status{display:none}.version{font-size:10px}.main{padding:0 12px 24px}.hero{padding:24px 4px 20px}.hero h1{font-size:27px}.hero-description{font-size:12px;max-width:290px}.hero-actions{width:100%}.hero-actions button{flex:1;padding:10px;font-size:11px}.overview{grid-template-columns:1fr;gap:8px;margin-bottom:16px}.overview>div{padding:13px 16px;gap:13px}.overview>div>div{display:grid;grid-template-columns:1fr auto;column-gap:14px;align-items:center;flex:1}.overview strong{grid-column:2;grid-row:1/3;font-size:23px}.overview>div>div>small{grid-column:1;grid-row:2}.overview strong small{font-size:12px}.stat-icon{width:37px;height:37px}.list-section{padding:17px 13px;border-radius:12px}.section-heading{margin-bottom:15px}.alarm-grid{grid-template-columns:1fr;gap:12px}.alarm-card{padding:17px}.alarm-time{font-size:34px}.overlay{padding:0;align-items:flex-end}.dialog{max-height:95dvh;width:100%;border-radius:16px 16px 0 0}.dialog-top,.dialog-scroll{padding:20px}.dialog-actions{padding:14px 20px}.dialog-grid{grid-template-columns:1fr}.day-picker{gap:5px}.day-chip{width:calc((100% - 30px)/7);min-width:0}.live-strip{flex-wrap:wrap}.stop-all{margin-left:auto}.footer{padding:0 4px;line-height:1.7}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;
if (!customElements.get("halarm-app")) customElements.define("halarm-app", AlarmPanel);
