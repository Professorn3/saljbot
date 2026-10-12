# Volttage Säljbot ⚡

En automatiserad bot för att övervaka offerter i Oneflow. Boten kontrollerar regelbundet dina aktiva offerter och skickar omedelbara push-notiser till din mobil via **ntfy** så fort en kund öppnar en offert eller om statusen ändras.

---

## 📱 Vad gör boten?
- **Notis vid visning:** Skickar en push-notis med kundens namn som rubrik, antalet visningar, när de senast tittade och hur många dagar det gått sedan förra visningen.
- **Notis vid statusändring:** Meddelar om en offert signeras, avvisas etc.
- **Automatisk schemaläggning:** Körs automatiskt var 15:e minut i bakgrunden.
- **Flersidig avsökning:** Bläddrar automatiskt igenom alla dina offertsidor i Oneflow.

---

## 🚀 Snabbstart (För kollegor)

Följ dessa enkla steg för att komma igång på 2 minuter:

### 1. Förutsättningar
Du behöver ha **Node.js** installerat på datorn. 
Om du inte har det, ladda ner LTS-versionen från [nodejs.org](https://nodejs.org/).

### 2. Ladda ner koden & installera
Öppna din terminal, gå till projektmappen och kör:
```bash
npm install
```

### 3. Kör den automatiska installationsguiden
Kör följande kommando i terminalen:
```bash
npm run setup
```
Installationsguiden ställer några snabba frågor:
1. **Oneflow e-post:** Din vanliga e-postadress till Oneflow.
2. **Oneflow lösenord:** Ditt lösenord till Oneflow.
3. **Notis-kanal (ntfy topic):** Välj ett unikt namn för dina mobilnotiser (t.ex. `johan-offerter-24` eller `anna-volttage`).
4. **Arbetsyte-ID:** Tryck bara **Enter** för att använda standard (`553051`).

*Guiden skapar automatiskt din lokala inställningsfil (`.env`). Dina lösenord sparas endast lokalt på din egen dator och laddas aldrig upp till GitHub.*

### 4. Ladda ner Ntfy i mobilen
1. Ladda ner gratisappen **ntfy** från [App Store (iOS)](https://apps.apple.com/app/ntfy/id1625396347) eller [Google Play (Android)](https://play.google.com/store/apps/details?id=io.heckel.ntfy).
2. Öppna appen och tryck på **+** (Lägg till ämne).
3. Skriv in det unika kanalnamnet du valde i steget ovan (t.ex. `johan-offerter-24`).
4. *(Frivilligt)* Du kan även se notiserna direkt i webbläsaren på: `https://ntfy.sh/ditt-kanalnamn`

---

## 🏃‍♂️ Hur man kör boten

### Starta i bakgrunden (Standard):
```bash
npm start
```
Boten körs nu tyst och gör en kontroll var 15:e minut.

### Starta med synlig webbläsare (För felsökning/test):
```bash
npm run show
```
Detta öppnar webbläsaren så att du kan se boten logga in och bläddra första gången. Efter första körningen fortsätter den automatiskt i dolt läge.

### Avsluta boten:
Tryck `Ctrl + C` i terminalen när som helst för att stoppa boten.
