require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const NTFY_TOPIC = process.env.NTFY_TOPIC || 'volttage-offerter-adam-99';
const HISTORIK_FIL = path.join(__dirname, 'historik.json');
async function skickaNotis(titel, meddelande) {
    try {
        // För att ntfy ska klara ÅÄÖ i titeln på mobilen, encodar vi den via RFC 2047 (Base64)
        const rfc2047Titel = `=?utf-8?B?${Buffer.from(titel).toString('base64')}?=`;
        
        await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
            method: 'POST',
            body: meddelande,
            headers: {
                'Title': rfc2047Titel,
                'Priority': 'high'
            }
        });
        console.log('Notis skickad till ntfy!');
    } catch (err) {
        console.error('Kunde inte skicka notis:', err);
    }
}

let forstaKorningen = true;

async function kollaOfferter() {
    console.log(`[${new Date().toLocaleTimeString()}] Startar schemalagd kontroll av offerter...`);
    
    // Starta webbläsaren. Om "--show" skickas med startas den synligt ENBART första gången.
    const visaFönster = process.argv.includes('--show') && forstaKorningen;
    forstaKorningen = false; // De framtida körningarna var 15:e minut blir automatiskt osynliga

    const browser = await chromium.launch({ 
        headless: !visaFönster,
        slowMo: visaFönster ? 500 : 0 // Kör lite långsammare första gången så du hinner se
    });
    // Sätt en väldigt hög skärmupplösning (5000px hög) 
    // så att Oneflow tvingas ladda in alla 50 rader direkt, även i dolt läge!
    const page = await browser.newPage({ viewport: { width: 1920, height: 5000 } });
    
    try {
        await page.goto("https://app.oneflow.com/login", { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.fill('input[name="email"]', process.env.ONEFLOW_EMAIL);
        await page.click('button:has-text("Continue")');
        await page.waitForSelector('input[name="password"]', { timeout: 5000 });
        await page.fill('input[name="password"]', process.env.ONEFLOW_PASSWORD);
        
        // Klicka på logga in och vänta tills vi försvinner från login-URL:en
        await Promise.all([
            page.waitForURL(url => !url.href.includes('login'), { waitUntil: 'commit', timeout: 30000 }),
            page.click('button[type="submit"]')
        ]);
        
        // Ge Oneflow en extra sekund att sätta sin session-cookie innan vi går till länkarna
        await page.waitForTimeout(2000);
        
        // Läs in gammal historik redan här så vi kan kolla ändringar direkt på sidan
        let gamlaOfferter = {};
        if (fs.existsSync(HISTORIK_FIL)) {
            try {
                gamlaOfferter = JSON.parse(fs.readFileSync(HISTORIK_FIL, 'utf8'));
            } catch (err) {}
        }

        let nuvarandeOfferter = {};
        
        // Gå igenom alla sidor dynamiskt tills det inte finns fler offerter
        const workspaceId = process.env.ONEFLOW_WORKSPACE_ID || '553051';
        const MAX_SIDOR = 20; // Säkerhetsgräns
        
        for (let sidan = 1; sidan <= MAX_SIDOR; sidan++) {
            const url = `https://app.oneflow.com/c/${workspaceId}/contracts/all?noTag%5B%5D=1&page=${sidan}`;
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForSelector('table', { timeout: 10000 }).catch(() => null);
            await page.waitForTimeout(1000);
            
            // Kolla direkt om sidan visar tomt resultat ("Inga resultat hittades" eller tom tabell)
            const isEmpty = await page.locator('[data-slot="empty"], td[colspan]').count() > 0 
                         || await page.locator('text="Inga resultat hittades"').count() > 0;
            if (isEmpty) {
                break;
            }

            // Smart auto-skroll: Tvinga Oneflow att ladda in alla gömda rader!
            let prevCount = 0;
            let scrollAttempts = 0;
            while (scrollAttempts < 10) {
                const currentCount = await page.locator('table tbody tr:not(:has(td[colspan]))').count();
                if (currentCount === 0 || currentCount === prevCount) break;
                prevCount = currentCount;
                
                // Skrolla ner till den sista synliga raden för att trigga fram fler
                await page.locator('table tbody tr:not(:has(td[colspan]))').nth(currentCount - 1).scrollIntoViewIfNeeded().catch(() => null);
                await page.waitForTimeout(1000); // Ge sidan 1 sekund att rita ut fler rader
                scrollAttempts++;
            }
            
            const rows = await page.locator('table tbody tr:not(:has(td[colspan]))').all();
            if (rows.length === 0) {
                // Inga rader alls på denna sida, vi har nått slutet
                break;
            }

            const klockslag = new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
            console.log(`[${klockslag}] Sida ${sidan}: Läser in ${rows.length} offerter...`);

            let nyaOfferterPaSidan = 0;
            
            for (let i = 0; i < rows.length; i++) {
                // Plocka ut information med 2s timeout så det aldrig hänger
                const namn = await rows[i].locator('td:nth-child(2)').innerText({ timeout: 2000 }).catch(() => "Okänd");
                const visningarStr = await rows[i].locator('td:nth-child(3)').innerText({ timeout: 2000 }).catch(() => "0");
                const visningar = parseInt(visningarStr) || 0;
                const status = await rows[i].locator('td:nth-child(4)').innerText({ timeout: 2000 }).catch(() => "Okänd");
                
                // Motpart ligger i kolumn 5 – försök med flera selektorer för att klara olika Oneflow-versioner
                let motpart = "Okänd";
                const motpartSelectors = [
                    'td:nth-child(5) span[class*="_ParticipantPillName_"]',  // Vanligast
                    'td:nth-child(5) span[class*="ParticipantPillName"]',    // Utan understreck
                    'td:nth-child(5) [data-slot="participant-name"]',         // Data-attribut
                    'td:nth-child(5) [class*="pill"] span',                   // Generisk pill-span
                    'td:nth-child(5) [class*="Pill"] span',                   // Variant med stor bokstav
                    'td:nth-child(5) [class*="participant"] span',            // Generisk participant
                    'td:nth-child(5) [class*="Participant"] span',            // Variant med stor bokstav
                ];
                for (const sel of motpartSelectors) {
                    const els = await rows[i].locator(sel).all();
                    if (els.length > 0) {
                        const text = await els[0].innerText({ timeout: 2000 }).catch(() => "");
                        if (text.trim()) {
                            motpart = text.trim();
                            break;
                        }
                    }
                }
                // Sista utväg: ta hela kolumn 5-texten och ta första raden om den verkar vara ett namn
                if (motpart === "Okänd") {
                    const col5Text = await rows[i].locator('td:nth-child(5)').innerText({ timeout: 2000 }).catch(() => "");
                    const firstLine = col5Text.split('\n')[0].trim();
                    if (firstLine && firstLine.length > 1 && firstLine.length < 60) {
                        motpart = firstLine;
                    }
                }

                if (namn !== "Okänd") {
                    let uniktId = "";
                    try {
                        const href = await rows[i].locator('a').first().getAttribute('href', { timeout: 500 });
                        if (href) uniktId = href;
                    } catch(e) {}
                    
                    if (!uniktId) {
                        try {
                            const dataId = await rows[i].getAttribute('data-id') || await rows[i].getAttribute('id');
                            if (dataId) uniktId = dataId;
                        } catch(e) {}
                    }
                    
                    if (!uniktId) {
                        uniktId = `fallback_${sidan}_${i}_${namn}_${motpart}`;
                    }

                    const sparatId = Buffer.from(uniktId).toString('base64');
                    
                    let exaktTid = "Idag";
                    const gammalData = gamlaOfferter[sparatId];

                    // Om visningar har ökat gör vi hover på profilcirkeln under Deltagare (kolumn 6)
                    if (gammalData && visningar > gammalData.visningar) {
                        try {
                            const avatar = rows[i].locator('td:nth-child(6) [role="button"]').last();
                            await avatar.hover({ timeout: 2000 });
                            await page.waitForTimeout(1000); // Vänta tills popupen dyker upp
                            
                            const dialogs = await page.locator('[role="dialog"], [role="tooltip"], [data-radix-popper-content-wrapper]').all();
                            for (const d of dialogs) {
                                const dText = await d.innerText();
                                if (dText.includes('Senast visad') || dText.includes('Viewed')) {
                                    const raderText = dText.split('\n').map(r => r.trim()).filter(r => r.length > 0);
                                    const senastIndex = raderText.findIndex(r => r === 'Senast visad' || r === 'Last viewed');
                                    if (senastIndex !== -1 && raderText.length > senastIndex + 1) {
                                        exaktTid = raderText[senastIndex + 1];
                                    }
                                }
                            }
                            
                            // Flytta musen ur vägen så hover-rutan försvinner innan vi går till nästa
                            await rows[i].locator('td:nth-child(1)').hover().catch(() => null);
                            await page.waitForTimeout(300);
                        } catch(e) {
                            console.log("Kunde inte hämta exakt hover-tid, använder standard");
                        }
                    }
                    
                    if (!nuvarandeOfferter[sparatId]) {
                        nyaOfferterPaSidan++;
                    }

                    nuvarandeOfferter[sparatId] = {
                        namn: namn.trim(),
                        status: status.trim(),
                        motpart: motpart.trim(),
                        uniktId: uniktId,
                        visningar: visningar,
                        senastTittad: gammalData ? gammalData.senastTittad : "Okänt", // Fylls på från gammal historik
                        nyTittadTid: exaktTid // Spara ner den hover-tittade tiden om den fanns
                    };
                }
            }

            // Om sidan inte gav några nya unika offerter, avbryt
            if (nyaOfferterPaSidan === 0) {
                break;
            }

            // Kontrollera om det finns en aktiv "Nästa sida"-knapp.
            // Om den är inaktiverad (disabled / aria-disabled="true") är vi på sista sidan!
            const hasNextPage = await page.locator('a:has-text("Go to next page"):not([aria-disabled="true"]):not([disabled])').count() > 0;
            if (!hasNextPage) {
                break;
            }
        }
        
        let antalAndringar = 0;
        const tidNu = new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });

        for (const [id, nyData] of Object.entries(nuvarandeOfferter)) {
            const gammalData = gamlaOfferter[id];
            
            if (gammalData) {
                let andrad = false;
                let meddelande = "";
                let titel = "";

                // 1. Kolla om antalet visningar har ökat
                if (nyData.visningar > gammalData.visningar) {
                    andrad = true;
                    const tidForut = gammalData.senastTittad || "Okänt";
                    
                    // Uppdatera till den exakta hover-tiden vi hittade, annars vår fallback-tid
                    nyData.senastTittad = (nyData.nyTittadTid && nyData.nyTittadTid !== "Idag") 
                                          ? nyData.nyTittadTid 
                                          : `${datumNu} ${tidNu}`; 
                    
                    // Räkna ut dagar sedan sist
                    let dagarSedan = "Okänt";
                    if (tidForut !== "Okänt") {
                        // Försök tolka datumet, tex "2026-10-08 18:06"
                        const forutDatum = new Date(tidForut);
                        if (!isNaN(forutDatum)) {
                            const diffMs = new Date() - forutDatum;
                            const diffDagar = Math.floor(diffMs / (1000 * 60 * 60 * 24));
                            dagarSedan = diffDagar === 0 ? "Idag" : `${diffDagar} dagar`;
                        }
                    }
                    
                    titel = nyData.motpart;
                    meddelande = `Offert: ${nyData.namn}\nMotpart: ${nyData.motpart}\nVisningar: ${gammalData.visningar} -> ${nyData.visningar}\nDagar sen sist tittad: ${dagarSedan}\nSenast tittad nu: ${nyData.senastTittad}`;
                }
                // 2. Kolla om statusen har ändrats
                else if (gammalData.status !== nyData.status) {
                    andrad = true;
                    titel = `${nyData.motpart} (Status)`;
                    meddelande = `Offert: ${nyData.namn}\nMotpart: ${nyData.motpart}\nStatus ändrades från ${gammalData.status} till ${nyData.status}\nVisningar: ${nyData.visningar}`;
                }

                if (andrad) {
                    console.log(`\nUpptäckt ändring:\n${meddelande}\n`);
                    await skickaNotis(titel, meddelande);
                    antalAndringar++;
                }
            } else {
                nyData.senastTittad = "Okänt";
            }
            
            // Städa bort vår temporära hover-variabel så den inte sparas i json
            delete nyData.nyTittadTid;
        }
        
        fs.writeFileSync(HISTORIK_FIL, JSON.stringify(nuvarandeOfferter, null, 2));
        console.log(`--- KLAR: Totalt ${Object.keys(nuvarandeOfferter).length} aktiva offerter övervakade, ${antalAndringar} ändringar hittade ---`);

    } catch (error) {
        console.error("Ett fel uppstod under körningen:", error);
    } finally {
        await browser.close();
    }
}

// Rekursiv schemaläggning (väntar tills körningen är helt klar)
async function startaBot() {
    await kollaOfferter();
    
    // Kör automatiskt varje kvart (900000 ms)
    setTimeout(startaBot, 900000);
}

startaBot();
