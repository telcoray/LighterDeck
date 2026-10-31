"use strict";
// Interface language. Italian is the source language: every string in the code and in
// index.html is written in Italian and looked up here when English is selected.
// t("Testo {x}", { x }) translates and fills {placeholders}; translateDom() handles the
// static HTML (text, placeholder, title and aria-label). The original Italian of every node is
// remembered, so the language can be switched back and forth without reloading the page.

const LANGS = [
  { id: "it", name: "Italiano", short: "IT" },
  { id: "en", name: "English", short: "EN" },
];
let LANG = (() => {
  // first visit: follow the browser (Italian only for Italian browsers)
  const guess = (navigator.language || "").toLowerCase().startsWith("it") ? "it" : "en";
  try { return JSON.parse(localStorage.getItem("ld.lang")) || guess; } catch { return guess; }
})();
let LOCALE = LANG === "en" ? "en-GB" : "it-IT";
const I18N_ATTRS = ["placeholder", "title", "aria-label"];
const originalText = new WeakMap(); // text node -> its Italian source

const EN = {
  // ---- top bar, navigation, status ----
  "Mercati": "Markets",
  "Automazioni": "Automations",
  "Attività": "Activity",
  "Connessione…": "Connecting…",
  "Pronto": "Ready",
  "Riconnessione…": "Reconnecting…",
  "Interruttore generale delle automazioni": "Master switch for automations",
  "Sola lettura": "Read-only",
  "Account #{n}": "Account #{n}",
  "Cambia tema": "Change theme",
  "Tema": "Theme",
  "Lingua": "Language",
  "Perpetual · dati pubblici": "Perpetuals · public data",
  "Feed pubblico": "Public feed",
  "Prezzi ricevuti {ms} ms fa": "Prices received {ms} ms ago",
  "In attesa di prezzi": "Waiting for prices",
  "Token di accesso LighterDeck:": "LighterDeck access token:",
  // ---- themes ----
  "nero caldo, testo sabbia e oro": "warm black, sand and gold text",
  "blu notte, testo azzurro ghiaccio": "midnight blue, ice-blue text",
  "il tema originale, grigi neutri": "the original theme, neutral greys",
  "Ghiaccio": "Ice",
  "Grafite": "Graphite",
  "Fosforo": "Phosphor",
  "sfondo grafite, testo verde da terminale": "graphite background, terminal-green text",
  // ---- toolbar / charts ----
  "Altri": "More",
  "Altri timeframe": "More timeframes",
  "Mostra nella barra": "Show in toolbar",
  "Ripristina": "Reset",
  "Tutti i timeframe sono nella barra.": "All timeframes are in the toolbar.",
  "3m, 2h, 8h, 3D, 1W e 1M sono costruiti unendo candele più piccole, come fa Lighter.":
    "3m, 2h, 8h, 3D, 1W and 1M are built by merging smaller candles, like Lighter does.",
  "1 grafico": "1 chart",
  "2 affiancati": "2 side by side",
  "2 sovrapposti": "2 stacked",
  "4 grafici": "4 charts",
  "Candela {tf}: {move} · chiusura {close}": "{tf} candle: {move} · close {close}",
  "prev. {f} · prec. {p}": "fcst. {f} · prev. {p}",
  // ---- order book ----
  "Prezzo": "Price",
  "Totale": "Total",
  "spread {bps} bps · live": "spread {bps} bps · live",
  // ---- bottom tables ----
  "Posizioni": "Positions",
  "Ordini aperti": "Open orders",
  "Storico trade": "Trade history",
  "Esecuzioni": "Executions",
  "Nessuna posizione aperta.": "No open positions.",
  "Sola lettura: collega un'API key per vedere posizioni e ordini.":
    "Read-only: connect an API key to see positions and orders.",
  "Sola lettura.": "Read-only.",
  "Mercato": "Market",
  "Valore": "Value",
  "Liquidazione": "Liquidation",
  "PnL non realizzato": "Unrealized PnL",
  "Chiudi · un click": "Close · one click",
  "Nessun ordine aperto sui mercati in uso.": "No open orders on the markets in use.",
  "Tipo": "Type",
  "Lato": "Side",
  "Size residua": "Remaining size",
  "sì": "yes",
  "Annulla": "Cancel",
  "Nessun trade recente.": "No recent trades.",
  "Ora": "Time",
  "Ruolo": "Role",
  "PnL realizzato": "Realized PnL",
  "Nessuna attività.": "No activity yet.",
  "Chiudere tutta la posizione {sym} a mercato?": "Close the whole {sym} position at market?",
  "Chiusura {f}% inviata": "{f}% close sent",
  "Ordine annullato": "Order cancelled",
  // ---- ticket ----
  "Leva e margine": "Leverage and margin",
  "Leva": "Leverage",
  "Applica leva": "Apply leverage",
  "Disponibile": "Available",
  "Posizione": "Position",
  "Valore USD": "USD value",
  "Quantità": "Quantity",
  "% capitale": "% of equity",
  "Rischio $ allo stop": "$ risk to stop",
  "Prezzo limite": "Limit price",
  "Stop-loss · prezzo": "Stop-loss · price",
  "Take-profit · prezzo": "Take-profit · price",
  "Opzionale": "Optional",
  "Opzioni di esecuzione": "Execution options",
  "Slippage massimo · bps": "Max slippage · bps",
  "Valore ordine": "Order value",
  "Margine richiesto": "Required margin",
  "Commissioni stimate": "Estimated fees",
  "Liquidazione stimata": "Estimated liquidation",
  "Esegui": "Execute",
  "Sola lettura · nessuna API key": "Read-only · no API key",
  "serve l'account": "needs the account",
  "lato sbagliato": "wrong side",
  "oltre la liquidazione": "beyond liquidation",
  "Inserisci una size valida.": "Enter a valid size.",
  "Inserisci il prezzo limite.": "Enter the limit price.",
  "Confermi l'ordine?": "Confirm the order?",
  "Eseguito: {side} {size} {sym}. Controlla posizioni e ordini per i fill.":
    "Executed: {side} {size} {sym}. Check positions and orders for fills.",
  "Sola lettura: nessuna API key": "Read-only: no API key",
  "{sym}: leva {lev}x {mode} inviata": "{sym}: {lev}x {mode} leverage sent",
  "{sym}: massimo dell'exchange {max}x, tuo limite {cap}x.": "{sym}: exchange maximum {max}x, your limit {cap}x.",
  // ---- account ----
  "Margine disponibile": "Available margin",
  "Limite per ordine": "Per-order limit",
  // ---- calendar ----
  "Calendario": "Calendar",
  "Aperture mercati": "Market hours",
  "Economia": "Economy",
  "Alto + medio": "High + medium",
  "Solo alto": "High only",
  "Solo USD": "USD only",
  "Nessun evento.": "No events.",
  "aperto · {d}": "open · {d}",
  "tra {d}": "in {d}",
  "chiude": "closes",
  "apre": "opens",
  "Stati Uniti": "United States",
  "Regno Unito": "United Kingdom",
  "Germania": "Germany",
  "Giappone": "Japan",
  "Hong Kong": "Hong Kong",
  "Australia": "Australia",
  // ---- markets page ----
  "Cerca simbolo…": "Search symbol…",
  "Apri nel grafico →": "Open in chart →",
  // ---- automations ----
  "Stop gestito": "Managed stop",
  "stop iniziale → breakeven → trailing": "initial stop → breakeven → trailing",
  "Stop iniziale": "Initial stop",
  "Breakeven a": "Breakeven at",
  "Trailing attivo da": "Trailing active from",
  "Aggiungi stop gestito": "Add managed stop",
  "Trade su evento": "Event trade",
  "dal calendario economico": "from the economic calendar",
  "Evento": "Event",
  "Modalità": "Mode",
  "Breakout del range": "Range breakout",
  "Long all'orario": "Long at release time",
  "Short all'orario": "Short at release time",
  "Range prima": "Range before",
  "Finestra": "Window",
  "Ritardo": "Delay",
  "Aggiungi trade su evento": "Add event trade",
  "Regole": "Rules",
  "{n} regola": "{n} rule",
  "{n} regole": "{n} rules",
  "Nessuna regola. Crea uno stop gestito o un trade su evento.": "No rules yet. Create a managed stop or an event trade.",
  "in attesa": "waiting",
  "attiva": "active",
  "in pausa": "paused",
  "Pausa": "Pause",
  "Riattiva": "Resume",
  "Elimina": "Delete",
  "Eliminare la regola?\nUn ordine stop già piazzato resta su Lighter.": "Delete this rule?\nA stop order already placed stays on Lighter.",
  "Regola aggiunta": "Rule added",
  "Limiti di rischio": "Risk limits",
  "Max per ordine": "Max per order",
  "Max per mercato": "Max per market",
  "Esposizione totale": "Total exposure",
  "Perdita giornaliera": "Daily loss",
  "Leva max": "Max leverage",
  "Stop-loss obbligatorio su ogni nuova posizione": "Stop-loss required on every new position",
  "Salva limiti": "Save limits",
  "Limiti salvati": "Limits saved",
  "Tetto fisso del server: ${cap} per ordine (MAX_NOTIONAL_USD). Le automazioni rispettano gli stessi limiti.":
    "Server hard cap: ${cap} per order (MAX_NOTIONAL_USD). Automations follow the same limits.",
  "PnL di oggi non disponibile": "Today's PnL unavailable",
  "PnL realizzato oggi {pnl}": "Realized PnL today {pnl}",
  "Le automazioni sono attive: il server può inviare ordini.": "Automations are on: the server can send orders.",
  "Interruttore generale spento: nessuna regola invia ordini.": "Master switch off: no rule sends orders.",
  "Attivare le automazioni?\n\nDa ora il server può inviare ordini reali secondo le regole.":
    "Turn automations on?\n\nFrom now on the server can send real orders according to the rules.",
  // ---- market picker ----
  "Seleziona mercato": "Select market",
  "Cerca mercato o nome…": "Search market or name…",
  "Chiudi (Esc)": "Close (Esc)",
  "Recenti": "Recent",
  "Rimuovi": "Remove",
  "Lista": "List",
  "Griglia": "Grid",
  "Ordina": "Sort",
  "Inverti ordine": "Reverse order",
  "Naviga": "Navigate",
  "Apri": "Open",
  "Vai alla lista": "Go to list",
  "Preferito": "Favourite",
  "Cerca": "Search",
  "Chiudi": "Close",
  "Apri ovunque": "Open anywhere",
  "Tutti": "All",
  "Tutte": "All",
  "Preferiti": "Favourites",
  "Nuovi": "New",
  "Azioni": "Stocks",
  "ETF / Indici": "ETFs / Indices",
  "Materie prime": "Commodities",
  "Bond": "Bonds",
  "Variazione 24h": "24h change",
  "Nome": "Name",
  "Più recenti": "Newest",
  "{n} mercati": "{n} markets",
  "Nessun mercato trovato.": "No markets found.",
  // API key dialog
  "Collega un'API key": "Connect an API key",
  "API key collegata": "API key connected",
  "Chiudi (Esc)": "Close (Esc)",
  "La chiave è impostata nel file env del server: per cambiarla modifica quel file.":
    "The key is set in the server env file: edit that file to change it.",
  "Apri la pagina API keys di Lighter": "Open Lighter's API keys page",
  "e crea una nuova chiave.": "and create a new key.",
  "Copia la chiave privata e il suo indice (da 3 in su: 0–2 sono riservati all'app di Lighter).":
    "Copy the private key and its index (3 or higher: 0–2 are reserved for the Lighter app).",
  "Incollali qui: LighterDeck controlla la chiave con Lighter prima di salvarla.":
    "Paste them here: LighterDeck checks the key with Lighter before saving it.",
  "Indirizzo del wallet (facoltativo, per trovare l'account)": "Wallet address (optional, to find the account)",
  "Trova": "Find",
  "Indice account": "Account index",
  "Indice API key": "API key index",
  "Chiave privata dell'API key": "API key private key",
  "La chiave resta solo sul server, in data/credentials.json, e non viene mai rimandata al browser. Un'API key firma ordini e può prelevare solo verso il tuo wallet: non può mandare fondi ad altri indirizzi.":
    "The key stays on the server only, in data/credentials.json, and is never sent back to the browser. An API key signs orders and can withdraw only to your own wallet: it cannot send funds to other addresses.",
  "Verifica e collega": "Verify and connect",
  "Verifica in corso…": "Verifying…",
  "Scollegare l'API key? Le automazioni si spengono e LighterDeck torna in sola lettura.":
    "Disconnect the API key? Automations turn off and LighterDeck goes back to read-only.",
  "Collegata con successo": "Connected successfully",
  "Lighter ha accettato la chiave: ora puoi fare trading da LighterDeck.": "Lighter accepted the key: you can now trade from LighterDeck.",
  "Valore account": "Account value",
  "Salvata in": "Saved in",
  "file env del server": "server env file",
  "caricamento…": "loading…",
  "Scollega": "Disconnect",
  "Fatto": "Done",
  "es. 4": "e.g. 4",
  "Aggregati": "Aggregated",
  "Trascina per ridimensionare · doppio clic per ripristinare": "Drag to resize · double-click to reset",
  "Fill singoli": "Single fills",
  "{n} fill": "{n} fills",
  "{n} ordini da {f} fill": "{n} orders from {f} fills",
  "Prezzo medio": "Avg price",
  "Primo fill: {t}": "First fill: {t}",
  "API key scollegata: sola lettura": "API key disconnected: read-only",
  "Sola lettura · collega un'API key": "Read-only · connect an API key",
  "Prendi l'indirizzo dal wallet del browser (solo lettura, nessuna firma)": "Take the address from your browser wallet (read-only, no signature)",
  "Il wallet non ha condiviso nessun indirizzo": "The wallet didn't share an address",
  "Richiesta rifiutata nel wallet": "Request rejected in the wallet",
};

function t(text, vars) {
  let out = LANG === "en" && EN[text] !== undefined ? EN[text] : text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v);
  return out;
}

// static HTML: swap whole text nodes and a few attributes that match a dictionary entry
function translateDom(root = document.body) {
  document.documentElement.lang = LANG;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!originalText.has(n)) originalText.set(n, n.nodeValue);
    const orig = originalText.get(n), key = orig.trim();
    if (!key || EN[key] === undefined) continue;
    const next = LANG === "en" ? orig.replace(key, EN[key]) : orig;
    if (n.nodeValue !== next) n.nodeValue = next;
  }
  for (const attr of I18N_ATTRS) {
    const store = "i18n" + attr.replace(/-./g, (c) => c[1].toUpperCase()).replace(/^./, (c) => c.toUpperCase());
    root.querySelectorAll(`[${attr}]`).forEach((el) => {
      if (el.dataset[store] === undefined) el.dataset[store] = el.getAttribute(attr);
      const orig = el.dataset[store];
      if (EN[orig] === undefined) return;
      el.setAttribute(attr, LANG === "en" ? EN[orig] : orig);
    });
  }
  document.documentElement.classList.remove("i18n-pending"); // reveal the page (see index.html)
}

// switch language in place: static text is re-translated, dynamic parts re-render via the hook
let onLangChange = () => {};
function setLang(id) {
  if (id === LANG) return;
  LANG = id;
  LOCALE = LANG === "en" ? "en-GB" : "it-IT";
  try { localStorage.setItem("ld.lang", JSON.stringify(id)); } catch {}
  translateDom();
  onLangChange();
}
