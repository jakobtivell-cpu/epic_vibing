# epic_vibing

Strategi
Bygg en dynamisk, företagsagnostisk pipeline som fungerar för VILKET Swedish Large Cap-bolag som helst, inte bara de tilldelade 10. Företagsprofiler är körtidskonfiguration. Pipelinen är heuristikdriven — inga webbplatsspecifika mallar.
Metodik

Deterministisk heuristik framför gissningar
Null med förklaring framför fabricerade värden
Cheerio som primär parser, Playwright som valfri fallback, allabolag som sista utväg
Utvinningsprovens spåras per fält
Validering separerad från utvinning

Steg

Scaffoldning + typer + CLI
Företagsregister med organisationsnummer och enhetsvarningar
IR-sidesupptäckt (poängsatt länkrankning, tvåspråkig)
Årsredovisnings-PDF-upptäckt (kandidatpoängsättning med negativa signaler)
PDF-nedladdning med caching
Textutvinning via pdf-parse
Fältparsning med tvåspråkiga etikettordböcker
Integration + validering + JSON-utdata

Uppkomna problem
ProblemGrundorsakLösningVolvo: inga PDF-länkar hittadesJS-renderad IR-sida (Adobe Experience Manager)Lade till 7-nivås fallback-stege; lägger till Playwright som valfri fallbackEricsson: fel intäktFörsta-nummer-heuristiken träffar segmenttabellen före resultaträkningenLösning: prioritera scoping av sektionen "Resultaträkning"pdf-parse kolumnsammanslagningTabellkolumner konkateneras till enstaka strängarLade till kommaseparerad nummerparsareAvanza/Nasdaq-fallbacks värdelösaBåda är SPA:er, osynliga för cheerioDokumenterat som återvändsgränder, Playwright löser denna klass av problemAllabolag moderbolag vs koncernStatutariska inlämningar visar moderbolaget, inte konsolideratKonfidens begränsad till 30 %, markerad som partiellKontextfönsteruttömningLånga Cursor-sessioner med stora kodbaserStrukturerade överlämningssammanfattningar mellan sessioner
