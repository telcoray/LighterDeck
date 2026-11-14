# Wiki del pannello ordini

Inventario per progettare il ticket definitivo di LighterDeck. Le proposte di seguito sono punti da decidere prima di modificare l’interfaccia.

## Inventario

| Elemento | Cosa deve fare | Stato in LighterDeck |
| --- | --- | --- |
| **Leva** | Mostrare la leva impostata per il mercato e permettere di cambiarla. | Pulsante con rotella, tra Buy/Long e Sell/Short. |
| **Cross / Isolated** | Scegliere tra margine condiviso e margine isolato per il mercato. Se ci sono posizioni o ordini aperti su quel mercato, mostrare il modo attivo e disabilitare l’alternativa con il motivo. | Presente in cima al ticket. |
| **Unified / Simple** | Mostrare il tipo di account e aprire la gestione del collaterale. In Unified mostrare saldo, stato di abilitazione e LTV per asset. | Da progettare. È un’impostazione dell’account, separata da Cross/Isolated. |
| **Buy / Long · Sell / Short** | Selezionare il lato dell’ordine. | Presente. |
| **Market · Limit · RFQ · Advanced** | Dare accesso diretto ai primi tre e raccogliere gli altri tipi nel menu. | Market e Limit sono diretti. Oggi RFQ è in Advanced, con Conditional, TWAP, Scale, Chase Limit, Iceberg e Basket. |
| **Disponibile per il trading** | Mostrare quanto margine è disponibile, con unità esplicita. | Nella scheda Account. Da decidere se ripeterlo accanto a Size o integrare la scheda con il ticket. |
| **Posizione aperta** | Mostrare lato e quantità nell’asset del mercato corrente. | Nella scheda Account. Stessa decisione sul posizionamento del disponibile. |
| **Prezzo limite** | Impostare il prezzo dell’ordine Limit, con accesso rapido al prezzo medio del book. | Presente quando il tipo d’ordine lo richiede. |
| **Amount / Size** | Inserire l’importo in USD o in quantità dell’asset. | Presente con unità dentro il campo. Ci sono anche % del capitale e rischio in dollari allo stop. |
| **Slider e campo %** | Impostare una frazione della quantità massima e convertirla nell’unità scelta. Con Reduce Only, il massimo è la quantità riducibile nella direzione dell’ordine. | Presente sul ticket a mercato singolo. La percentuale dello slider e l’unità «% del capitale» hanno basi diverse. |
| **Spunta TP / SL** | Aprire un’unica sezione dove impostare TP, SL o entrambi. | Oggi SL e TP sono due righe sempre visibili quando il tipo d’ordine li supporta. Mostrano la variazione percentuale del prezzo rispetto all’entrata, senza leva. |
| **Reduce Only** | Limitare l’ordine alla riduzione o chiusura di una posizione esistente. | Presente. |
| **Riepilogo e invio** | Mostrare la stima dell’ordine e l’effetto sulla posizione prima della conferma. | Presente. Il layout definitivo deve conservare accesso a commissioni, slippage e liquidazione stimata. |

## TP / SL

| Campo | Significato |
| --- | --- |
| **TP / SL Trigger Price** | Prezzo soglia che attiva l’uscita quando il mark price raggiunge il livello nella direzione prevista. |
| **Gain / Loss in % o USD** | Secondo modo per scegliere o leggere il livello di uscita. Per LighterDeck resta da definire la base della percentuale e la quantità su cui stimare il risultato in dollari, soprattutto se l’ordine si aggiunge a una posizione. |
| **Esecuzione Market** | Al trigger parte un’uscita a mercato con le protezioni di prezzo applicabili. Il prezzo effettivo dipende dalla liquidità disponibile. |
| **Esecuzione Limit** | Al trigger si attiva un ordine limite. Su una vendita il limite è il prezzo minimo accettato, su un acquisto è il massimo. Se il mercato passa oltre il limite, l’uscita può restare ineseguita. |

Esempio su un long con **trigger SL a 95** e **limite a 94,50**. Quando il mark raggiunge 95, si attiva una vendita a 94,50 o meglio. Se i compratori sono già tutti sotto 94,50, l’ordine può restare in attesa. La soglia decide **quando** attivare l’uscita, il limite decide **a quali prezzi** può eseguire. Negli screenshot «Market» indica la modalità di esecuzione selezionata per quella riga. Riferimenti: [specifica del protocollo Lighter](https://assets.lighter.xyz/whitepaper.pdf) e [SDK ufficiale](https://github.com/elliottech/lighter-python).

## Unified e collaterale

Negli screenshot il conto Simple tiene separati i saldi Spot e Perpetual in USDC. Unified li consolida e permette di abilitare altri asset come collaterale. Il LTV è la quota del valore dell’asset che conta come margine. Gli screenshot mostrano USDC al 100%, ETH all’80%, XAUT e weETH al 70%. Per un’eventuale implementazione, leggere asset e parametri correnti da Lighter e verificare operazioni di cambio conto e abilitazione sul percorso server e su quello con chiave nel browser. [Documentazione Multi-Asset Margin](https://docs.lighter.xyz/trading/multi-asset-margin).

## Decisioni da prendere prima di implementare

- **Gerarchia del ticket.** Separare la configurazione dell’account (Unified/Simple) da quella del mercato (leva e Cross/Isolated). Provare una disposizione comune su desktop e telefono, usando i tre blocchi già adottati per impostazione, ordine ed esito.
- **Contesto vicino a Size.** Decidere dove leggere disponibile e posizione senza duplicare la scheda Account. Distinguere il margine disponibile dal controvalore massimo dell’ordine, che dipende anche da leva, prezzo, lato e commissioni.
- **Stati per tipo d’ordine.** Definire quali controlli sono disponibili per Market, Limit, RFQ e per ogni voce di Advanced. Verificare in particolare TP/SL e Reduce Only, oltre alla differenza tra il Basket di LighterDeck e Atomic visto su Lighter.
- **Protezioni progressive.** Decidere cosa mostra la spunta TP/SL quando è attiva, dove trovano posto uscite scalari e trailing e come indicare un’uscita Limit. Specificare quale valore guida il calcolo quando si modifica il trigger oppure il campo Gain/Loss.
- **Comportamenti da conservare.** Usare lo slider con tutte le unità supportate, mantenere le scorciatoie senza riquadri nel ticket e lasciare che la scala del grafico segua le candele mentre si impostano i livelli.

Gli screenshot sono un riferimento per funzioni e stati dell’interfaccia. L’inventario ne conserva il contenuto utile senza includere immagini con saldi o posizioni.
