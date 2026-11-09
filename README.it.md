<p align="center"><img src="docs/logo.svg" alt="LighterDeck" width="420"></p>

# LighterDeck

Terminale di trading per i perpetual di Lighter (lighter.xyz), con automazioni lato server.

**Provalo su [lighterdeck.xyz](https://lighterdeck.xyz)**: grafici, calendario per mercato, funding e paper trading sui prezzi veri di Lighter, senza account. Per il trading reale avvia una tua copia con la tua API key (sotto).

[Read in English](README.md)

## Funzioni

| Area | Cosa c'è |
| --- | --- |
| Grafici | 1, 2 o 4 grafici (affiancati o sovrapposti), legenda OHLC, volumi, linee di entry, liquidazione, ordini aperti (SL/TP/limit, trascinabili per spostarli) e dello stop gestito che si muove sul grafico, prezzo mark, eventi macro, i tuoi fill (frecce di acquisto e vendita, dettagli al passaggio del mouse), alert di prezzo; ognuno si accende o spegne da **Elementi**. Click destro su un prezzo per un limit, SL/TP del ticket, SL/TP della posizione o un alert; click destro su una linea per annullare quell'ordine, togliere l'alert, fermare il trailing o chiudere la posizione |
| Mercati | Prezzi live di tutti i perpetual, mark/index, funding (cliccandolo: tasso orario su settimana, mese e anno, conto alla rovescia, quanto paga la tua posizione e storico 24H/1W/1M), open interest, order book con spread, preferiti; badge di contesto nella barra del mercato e su ogni grafico: un evento ad alto impatto entro un'ora, funding insolito (e se la tua posizione lo paga), la borsa del sottostante chiusa o in chiusura, la tua posizione vicina alla liquidazione |
| Ordini | Market e limit, post-only, reduce-only, slippage in bps, size in USD / quantità / % capitale / rischio $ allo stop; prezzo limite, SL, TP e trailing in anteprima sul grafico mentre compili il ticket; ordini e chiusure totali confermati con un secondo click, senza finestre |
| Protezione | SL/TP nativi inviati insieme all'entrata (OTO/OTOCO); uscite scalari (da 2 a 5 livelli di take-profit, ognuno chiude la sua quota della posizione, stop a breakeven quando si esegue TP1); TP e SL nella tabella posizioni, da aggiungere o modificare lì; chiusura parziale 25/50/75/100%, reverse, leva e cross/isolated |
| Posizioni | Size con la sua unità, valore, margine con la leva, entry, mark, liquidazione, PnL in $ e in % del margine; il nome del mercato apre il suo grafico |
| Pair trading | Grafici spread di un mercato diviso un altro (cerca "ETH/BTC", la tab **Spread** o **÷ Spread**), con bande dello z-score; la tab Spread ordina le coppie classiche da quella più tirata. Sul grafico spread il ticket compra un mercato e vende l'altro per lo stesso valore in dollari, controlla prima entrambe le gambe e, se la seconda fallisce, propone di chiudere la prima. La coppia compare come una riga sola (sue quantità, rapporto d'entrata e attuale, PnL combinato, funding, liquidazione più vicina), si chiude con un click e ha SL/TP sul rapporto |
| Alert | Alert di prezzo dal click destro sul grafico o con il tasto A, come linee trascinabili; messaggio, suono e notifica del browser quando il prezzo li raggiunge, con LighterDeck aperto |
| Paper trading | La stessa schermata con soldi simulati sui prezzi veri: esecuzioni market e limit, SL/TP, uscite scalari, trailing stop, funding orario e liquidazione girano nel browser, e il tempo in cui eri via viene rigiocato dalle candele. Sempre attivo su lighterdeck.xyz, un interruttore sul tuo deck |
| Tastiera | B / S lato, M / L tipo di ordine, Invio per inviare, F chiude, H chiude metà, R reverse, C annulla i limit (gli ultimi quattro vanno premuti due volte), A alert al prezzo sotto il mouse, 1–4 grafici, [ ] timeframe, / cerca, ? l'elenco completo; ogni tasto compare anche sul suo bottone |
| Rischio (facoltativo) | Spenti di default, ognuno si attiva da solo: limiti per ordine, mercato ed esposizione totale in % del capitale, perdita giornaliera in % del capitale alle 00:00 UTC (posizioni aperte incluse), leva, numero posizioni, stop-loss obbligatorio, niente inversioni |
| Automazioni | Stop gestito (iniziale, breakeven, trailing, in % di PnL con la leva della posizione) e trade su eventi macro (orario o breakout del range), con kill switch |
| Calendario | Pagina dedicata con filtri per mercato, tipo (macro, energia, trimestrali, crypto, tuoi), impatto, periodo e testo, più una breve lista per il mercato selezionato accanto al ticket. Eventi economici della settimana (Forex Factory), rilasci BEA e riunioni Fed ufficiali, report sull'energia (scorte EIA di greggio e gas con il calendario festività EIA, bollettino API, rig count Baker Hughes), trimestrali delle azioni su Lighter e delle maggiori società USA (calendario Nasdaq, con stima EPS), scadenze mensili e trimestrali delle opzioni BTC/ETH su Deribit, eventi tuoi per qualsiasi mercato (uno sblocco di token, un aggiornamento), aperture delle principali borse con festività, mezze giornate e pause pranzo; calendario, punti sul grafico e trade su evento seguono il mercato selezionato (report sul petrolio per WTI e Brent, la trimestrale di ogni azione, quelle delle maggiori società per gli indici, entrambe le valute per una coppia forex) |
| Account | Equity, PnL di oggi, margine disponibile, leva e margine usato; curva del PnL senza depositi e prelievi (o dell'equity con i movimenti segnati), statistiche del periodo (rendimento, massimo drawdown, giorno migliore e peggiore, giorni verdi e rossi, volume), calendario del PnL dove un click mostra i trade del giorno, PnL realizzato e funding per mercato |
| Storico | Trade raggruppati per ordine o come singoli fill, PnL realizzato calcolato da ogni fill |
| Link | Ogni pagina ha il suo indirizzo (`/trade/WTI`, `/calendar`, `/account`…): condividi un mercato (l'anteprima del link mostra grafico, prezzo e variazione 24h di quel mercato), salva una pagina tra i preferiti, usa il tasto indietro del browser |
| Aspetto | Sei temi, italiano, inglese, cinese e coreano, layout che funziona in finestre strette e sul telefono |

```
frontend/   pagina web (HTML/CSS/JS, TradingView Lightweight Charts)
backend/    FastAPI: dati Lighter, calendario, rischio, firma ordini (SDK ufficiale), motore automazioni
deploy/     servizi systemd, sito nginx per l'istanza pubblica, esempio di configurazione
tools/      immagine di anteprima dei link (og.png), sessioni delle borse per le aperture (exchange_hours.json)
```

## In locale (sola lettura)

```
python -m venv .venv
.venv\Scripts\pip install -r backend\requirements.txt
.venv\Scripts\python backend\main.py
```
Poi apri http://127.0.0.1:8200

Per fare trading clicca **Sola lettura** in alto e collega un'API key: il server la verifica con
Lighter e la salva in `data/credentials.json` (mai inviata di nuovo al browser). Se l'API key è
nel file env del server, quella ha la precedenza e dall'interfaccia non si può cambiare.

## Su un server

Il backend ascolta solo su 127.0.0.1:8200. Non è esposto su internet e ci si arriva con un tunnel SSH:

```
ssh -N -L 8200:127.0.0.1:8200 utente@tuo-server
```
Poi apri http://127.0.0.1:8200 sul PC.

Installazione (una volta sola):

```
adduser --system --group --home /opt/lighterdeck lighterdeck
mkdir -p /var/lib/lighterdeck /etc/lighterdeck && chown lighterdeck: /var/lib/lighterdeck
# copia backend/, frontend/, deploy/ in /opt/lighterdeck
python3 -m venv /opt/lighterdeck/.venv && /opt/lighterdeck/.venv/bin/pip install -r /opt/lighterdeck/backend/requirements.txt
cp /opt/lighterdeck/deploy/lighterdeck.env.example /etc/lighterdeck/lighterdeck.env   # poi compila
chown root:lighterdeck /etc/lighterdeck/lighterdeck.env && chmod 640 /etc/lighterdeck/lighterdeck.env
cp /opt/lighterdeck/deploy/lighterdeck.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now lighterdeck
```

## Sito pubblico

Con `PUBLIC_MODE=1` nel file env il deck funziona come sito pubblico (lighterdeck.xyz): non carica mai
un'API key, rifiuta ogni richiesta di scrittura e fa girare la schermata di trading in paper trading
(soldi simulati, salvati nel browser di ogni visitatore). Accoglie chi
arriva la prima volta con una barra sottile (link a questo repository e per aprire un account Lighter,
`REFERRAL_URL`) e la conferma della residenza. Chi si collega da Stati Uniti, Regno Unito e Canada,
dove Lighter non è disponibile, vede una pagina che lo spiega (paese dall'header `CF-IPCountry` di
Cloudflare). Gli eventi personali del calendario restano nel browser di ogni visitatore. Va avviato
come istanza separata dal tuo deck personale.

Aggiungendo `BROWSER_TRADING=1` il trading reale passa al primo posto: ogni visitatore collega la propria
API key di Lighter, che resta nel suo browser (gli ordini vengono firmati lì con il firmatario ufficiale
di Lighter e vanno direttamente a Lighter; il server non riceve mai la chiave). Il paper trading diventa
una scelta, a un clic sotto il ticket, ricordata in ogni browser. `LD_VAULT_KEY` (un segreto tuo, fuori
dal repository) permette inoltre di affidare al server, cifrata, una seconda API key per le automazioni
che devono funzionare a pagina chiusa.

## Sicurezza

- La API key di Lighter può aprire e chiudere posizioni e prelevare verso il **tuo** wallet,
  ma non trasferire fondi ad altri (serve la firma del wallet). Usa un indice di API key
  dedicato (es. 5), non quello usato dall'app web.
- Tetti facoltativi nel file env: `MAX_NOTIONAL_USD`, `MAX_ORDERS_PER_DAY` (vuoti = nessun tetto).
  Anche i limiti di rischio della pagina Automazioni sono facoltativi: vale solo quello che spunti (salvati in `data/limits.json`).
- Il pulsante **AUTOMAZIONI ON/OFF** è il kill switch: con OFF il motore non invia nessun ordine.
  Gli stop già piazzati restano su Lighter.

## Automazioni

- **Stop gestito** (per mercato): stop iniziale a -X% dall'entry, breakeven quando il PnL
  raggiunge +Y%, trailing dal prezzo migliore (attivo da un PnL di +W%). La % di PnL è sul margine,
  quindi include la leva della posizione, come nella tabella posizioni. Lo stop non viene mai allargato.
  Su Lighter è un vero ordine stop-loss reduce-only, quindi resta attivo anche se il server cade.
  La distanza del trailing è in % di PnL di default, oppure in % di prezzo, in $ fissi o un multiplo dell'ATR(14) su candele da 15 minuti.
  Si attiva direttamente dal ticket (**Trailing stop**) o dal bottone **Trailing** di una posizione aperta.
- **Uscite scalari**: **+ TP** nel ticket divide il take-profit in 2-5 livelli, ognuno un ordine
  reduce-only per la sua quota della posizione. Con un'entrata market partono subito; con un limit
  partono quando viene eseguito. Con **Dopo TP1 stop a breakeven** lo stop va al prezzo d'entrata quando
  si esegue il primo livello. Queste ultime due cose richiedono Auto ON.
- **SL/TP della coppia**: stop-loss e take-profit sul rapporto di una coppia (gamba long divisa gamba short).
  Lighter non sa fare trigger su un rapporto, quindi LighterDeck lo controlla ogni 2 secondi con Auto ON e
  chiude le quantità della coppia su entrambe le gambe quando ne raggiunge uno.
- **Trade su evento**: long/short N secondi dopo l'evento, oppure breakout del range
  dei minuti precedenti. L'entrata parte con SL/TP nativi; trailing e breakeven poi stringono lo stop.
  Ogni entrata automatica passa dagli stessi controlli degli ordini manuali, compresi i limiti di rischio che hai attivato.

Il calendario gratuito (Forex Factory) ha orari, impatto, previsto e precedente, ma **non il dato effettivo**.
Le regole quindi reagiscono all'orario e al movimento del prezzo, non al numero pubblicato.

## Crediti

Le immagini di anteprima dei link usano i font Inter e JetBrains Mono (SIL Open Font License, licenze in `backend/fonts/`).

Formule di margine, prezzo di liquidazione e SL/TP (`frontend/formulas.js`), conversioni del
`multiplier` e validazione dei trigger SL/TP sono adattate da
[elliottech/lighter-ts](https://github.com/elliottech/lighter-ts), MIT License, Copyright (c) 2026 Elliot Technologies, Inc.

L'icona di traduzione del pulsante della lingua viene dai [Material Symbols](https://github.com/google/material-design-icons) di Google (Apache-2.0).

Gli ordini firmati nel browser usano il firmatario ufficiale di Lighter, compilato senza modifiche da
[elliottech/lighter-go](https://github.com/elliottech/lighter-go) (Apache-2.0) in WebAssembly, con `wasm_exec.js` di Go
(licenza in stile BSD): vedi `frontend/signer/README.md`.

## Licenza

LighterDeck è distribuito con [licenza MIT](LICENSE).
