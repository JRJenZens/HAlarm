# Ændringslog

## 0.9.1 beta

- Stemmestop efter bekræftet afspilning stopper straks ved pause/slukning, også under de første sekunder og ved lydens slutning.
- Cast-opstartstid tæller ikke længere som afspilningstid; idle efterfulgt af off annullerer gentagelse.
- Mindre slutmargin ved idle; forbindelsesfejl og timeout stopper med diagnostik.
- Kompakt oversigt inspireret af ESPHealth, gul accent, mørk visning og bedre tastaturbetjening.
- MP3-filer kopieres til /config/halarm/sounds/ og bevares ved HACS-opdatering.
- Samme lagerformat; eksisterende indstillinger bevares og gammel Alarmcentral migreres læsende.
- Undgår dobbeltstart af samme planlagte minut og dobbelte frontend-lyttere efter genåbning.
- Home Assistant 2026.11.1 integrationstests og desktop/mobil-browsertest.

## 0.9.0 beta

- Første selvstændige HAlarm-pakke med Cast-afspilning, alarmprofiler, diagnostik og Alarmcentral-import.
