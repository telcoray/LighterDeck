<p align="center"><img src="docs/logo.svg" alt="LighterDeck" width="420"></p>

# LighterDeck

Terminale di trading personale per i perpetual di Lighter (lighter.xyz), con automazioni lato server.

[Read in English](README.md)

## Funzioni

| Area | Cosa c'è |
| --- | --- |
| Grafici | 1, 2 o 4 grafici (affiancati o sovrapposti), legenda OHLC, volumi, linee di entry, liquidazione, ordini aperti (SL/TP/limit) e dello stop gestito che si muove sul grafico, prezzo mark, eventi macro; ognuno si accende o spegne da **Elementi** |
| Mercati | Prezzi live di tutti i perpetual, mark/index, funding, open interest, order book con spread, preferiti |
| Ordini | Market e limit, post-only, reduce-only, slippage in bps, size in USD / quantità / % capitale / rischio $ allo stop; prezzo limite, SL, TP e trailing in anteprima sul grafico mentre compili il ticket |
| Protezione | SL/TP nativi inviati insieme all'entrata (OTO/OTOCO), chiusura parziale 25/50/75/100%, leva e cross/isolated |
| Rischio | Limiti per ordine, mercato, esposizione totale, leva, perdita giornaliera, numero posizioni; stop-loss obbligatorio; blocco inversioni e dati non aggiornati |
| Automazioni | Stop gestito (iniziale, breakeven, trailing) e trade su eventi macro (orario o breakout del range), con kill switch |
| Calendario | Eventi economici della settimana (Forex Factory), riunioni Fed ufficiali, aperture delle principali borse |

```
frontend/   pagina web (HTML/CSS/JS, TradingView Lightweight Charts)
backend/    FastAPI: dati Lighter, calendario, rischio, firma ordini (SDK ufficiale), motore automazioni
deploy/     servizio systemd + esempio di configurazione
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

## Sicurezza

- La API key di Lighter può aprire e chiudere posizioni e prelevare verso il **tuo** wallet,
  ma non trasferire fondi ad altri (serve la firma del wallet). Usa un indice di API key
  dedicato (es. 5), non quello usato dall'app web.
- Tetto fisso nel file env: `MAX_NOTIONAL_USD`, `MAX_ORDERS_PER_DAY`, `MAX_SLIPPAGE_PCT`.
  Sopra di esso, i limiti di rischio modificabili dalla pagina Automazioni (salvati in `data/limits.json`).
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
  Ogni entrata automatica passa dagli stessi controlli di rischio degli ordini manuali.

Il calendario gratuito (Forex Factory) ha orari, impatto, previsto e precedente, ma **non il dato effettivo**.
Le regole quindi reagiscono all'orario e al movimento del prezzo, non al numero pubblicato.

## Crediti

Formule di margine, prezzo di liquidazione e SL/TP (`frontend/formulas.js`), conversioni del
`multiplier` e validazione dei trigger SL/TP sono adattate da
[elliottech/lighter-ts](https://github.com/elliottech/lighter-ts), MIT License, Copyright (c) 2026 Elliot Technologies, Inc.
