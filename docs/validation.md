# Validering af HAlarm 0.9.1 beta

## Miljø

- Lokal isoleret Home Assistant Core 2026.11.1 / Python 3.14.10.
- Den tilsluttede installation rapporterer samme Core-version; produktionsfiler er ikke ændret.
- Chromium via Playwright; simuleret HA-websocket til frontendtesten.

## Automatiske kontroller

- Stop ved idle, off og paused, forsinket Cast-opstart og tidligt stop efter bekræftet playing.
- Naturlig idle-afslutning, idle → off før gentagelse og ingen genstart efter stop.
- Gem/genindlæs af eksisterende alarmindstillinger; læsende migration fra Alarmcentral.
- Persistente MP3-filer og spejling til Cast/mediebibliotek.
- Samme planlagte minut starter kun én gang ved samtidige scheduler-kald.
- Desktop 1280 px, mobil 390 px, mørk visning, redigering/gem, Escape og genåbning uden dobbelte lyttere.
- Ingen JavaScript-fejl eller vandret overløb ved testet mobilbredde.

Tests bruger syntetiske alarmer, ikke brugerens gemte data. Ingen fysisk Nest
eller Nest Mini er aktiveret under disse tests. Resultaterne beviser ikke
firmwareafhængigt stemmestop eller faktisk lydlevering på produktionsnetværket.

## Fysisk test efter installation

1. Kontrollér at eksisterende alarmer har samme tider, ugedage, højttalere, lyde, volumen og aktivering.
2. Test en MP3 på mindst 30 sekunder på én Nest og én Nest Mini.
3. Sig »Hey Google, stop« efter få sekunder og igen efter mindst 15 sekunder.
4. Vent mindst én hel lydlængde; alarmen skal forblive stoppet og profilen fortsat være aktiveret.
5. Start igen uden stemmestop: naturlig idle-afslutning skal gentage lyden.
6. Test dashboardets Stop og Stop alle. Se diagnostik ved afvigelser.

Cast rapporterer ikke årsagen til stop. Idle helt tæt på lydens slutning kan ikke
skelnes entydigt; off ved naturlig afslutning afslutter alarmkørslen.
