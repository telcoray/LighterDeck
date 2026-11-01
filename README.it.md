<p align="center"><img src="docs/logo.svg" alt="LighterDeck" width="420"></p>

# LighterDeck

Terminale di trading per i perpetual di Lighter (lighter.xyz), con automazioni lato server.

**Provalo in sola lettura su [lighterdeck.xyz](https://lighterdeck.xyz)**: grafici, calendario per mercato e funding, senza account. Per fare trading avvia una tua copia con la tua API key (sotto).

[Read in English](README.md)

## Funzioni

| Area | Cosa c'è |
| --- | --- |
| Grafici | 1, 2 o 4 grafici (affiancati o sovrapposti), legenda OHLC, volumi, linee di entry, liquidazione, ordini aperti (SL/TP/limit, trascinabili per spostarli) e dello stop gestito che si muove sul grafico, prezzo mark, eventi macro; ognuno si accende o spegne da **Elementi** |
| Mercati | Prezzi live di tutti i perpetual, mark/index, funding (cliccandolo: tasso orario su settimana, mese e anno, conto alla rovescia, quanto paga la tua posizione e storico 24H/1W/1M), open interest, order book con spread, preferiti |
| Ordini | Market e limit, post-only, reduce-only, slippage in bps, size in USD / quantità / % capitale / rischio $ allo stop; prezzo limite, SL, TP e trailing in anteprima sul grafico mentre compili il ticket; ordini e chiusure totali confermati con un secondo click, senza finestre |
| Protezione | SL/TP nativi inviati insieme all'entrata (OTO/OTOCO), TP e SL nella tabella posizioni, da aggiungere o modificare lì, chiusura parziale 25/50/75/100%, leva e cross/isolated |
| Rischio (facoltativo) | Spenti di default, ognuno si attiva da solo: limiti per ordine, mercato ed esposizione totale in % del capitale, perdita giornaliera in % del capitale alle 00:00 UTC (posizioni aperte incluse), leva, numero posizioni, stop-loss obbligatorio, niente inversioni |
| Automazioni | Stop gestito (iniziale, breakeven, trailing) e trade su eventi macro (orario o breakout del range), con kill switch |
| Calendario | Pagina dedicata con filtri per mercato, tipo (macro, energia, trimestrali, crypto, tuoi), impatto, periodo e testo, più una breve lista per il mercato selezionato accanto al ticket. Eventi economici della settimana (Forex Factory), rilasci BEA e riunioni Fed ufficiali, report sull'energia (scorte EIA di greggio e gas con il calendario festività EIA, bollettino API, rig count Baker Hughes), trimestrali delle azioni su Lighter e delle maggiori società USA (calendario Nasdaq, con stima EPS), scadenze mensili e trimestrali delle opzioni BTC/ETH su Deribit, eventi tuoi per qualsiasi mercato (uno sblocco di token, un aggiornamento), aperture delle principali borse; calendario, punti sul grafico e trade su evento seguono il mercato selezionato (report sul petrolio per WTI e Brent, la trimestrale di ogni azione, quelle delle maggiori società per gli indici, entrambe le valute per una coppia forex) |
| Storico | Trade raggruppati per ordine o come singoli fill, PnL realizzato calcolato da ogni fill |
| Aspetto | Cinque temi, italiano e inglese, layout che funziona in finestre strette e sul telefono |

```
frontend/   pagina web (HTML/CSS/JS, TradingView Lightweight Charts)
backend/    FastAPI: dati Lighter, calendario, rischio, firma ordini (SDK ufficiale), motore automazioni
deploy/     servizi systemd, sito nginx per l'istanza pubblica, esempio di configurazione
tools/      immagine di anteprima dei link (og.png)
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

## Sito pubblico in sola lettura

Con `PUBLIC_MODE=1` nel file env il deck funziona come sito pubblico (lighterdeck.xyz): non carica mai
un'API key, rifiuta ogni richiesta di scrittura, nasconde automazioni e posizioni, e accoglie chi
arriva la prima volta con una barra sottile (link a questo repository e per aprire un account Lighter,
`REFERRAL_URL`) e la conferma della residenza. Chi si collega da Stati Uniti, Regno Unito e Canada,
dove Lighter non è disponibile, vede una pagina che lo spiega (paese dall'header `CF-IPCountry` di
Cloudflare). Gli eventi personali del calendario restano nel browser di ogni visitatore. Va avviato
come istanza separata dal tuo deck personale.

## Sicurezza

- La API key di Lighter può aprire e chiudere posizioni e prelevare verso il **tuo** wallet,
  ma non trasferire fondi ad altri (serve la firma del wallet). Usa un indice di API key
  dedicato (es. 5), non quello usato dall'app web.
- Tetti facoltativi nel file env: `MAX_NOTIONAL_USD`, `MAX_ORDERS_PER_DAY` (vuoti = nessun tetto).
  Anche i limiti di rischio della pagina Automazioni sono facoltativi: vale solo quello che spunti (salvati in `data/limits.json`).
- Il pulsante **AUTOMAZIONI ON/OFF** è il kill switch: con OFF il motore non invia nessun ordine.
  Gli stop già piazzati restano su Lighter.

## Automazioni

- **Stop gestito** (per mercato): stop iniziale a -X% dall'entry, breakeven quando il profitto
  raggiunge +Y%, trailing a Z% dal massimo raggiunto (attivo da +W%). Lo stop non viene mai allargato.
  Su Lighter è un vero ordine stop-loss reduce-only, quindi resta attivo anche se il server cade.
  La distanza del trailing può essere in %, in $ fissi o un multiplo dell'ATR(14) su candele da 15 minuti.
  Si attiva direttamente dal ticket (**Trailing stop**) o dal bottone **Trailing** di una posizione aperta.
- **Trade su evento**: long/short N secondi dopo l'evento, oppure breakout del range
  dei minuti precedenti. L'entrata parte con SL/TP nativi; trailing e breakeven poi stringono lo stop.
  Ogni entrata automatica passa dagli stessi controlli degli ordini manuali, compresi i limiti di rischio che hai attivato.

Il calendario gratuito (Forex Factory) ha orari, impatto, previsto e precedente, ma **non il dato effettivo**.
Le regole quindi reagiscono all'orario e al movimento del prezzo, non al numero pubblicato.

## Crediti

Formule di margine, prezzo di liquidazione e SL/TP (`frontend/formulas.js`), conversioni del
`multiplier` e validazione dei trigger SL/TP sono adattate da
[elliottech/lighter-ts](https://github.com/elliottech/lighter-ts), MIT License, Copyright (c) 2026 Elliot Technologies, Inc.
