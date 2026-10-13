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
        
        // 1. Identifiera alla tillgängliga workspaces / pipelines
        const loginUrl = page.url();
        const urlMatch = loginUrl.match(/\/c\/(\d+)/);
        const defaultWsId = process.env.ONEFLOW_WORKSPACE_ID || (urlMatch ? urlMatch[1] : '553051');
        let workspaces = [];

        // Om användaren angett specifika workspaces manuellt i .env (t.ex. ONEFLOW_WORKSPACES=553051,553052)
        if (process.env.ONEFLOW_WORKSPACES) {
            workspaces = process.env.ONEFLOW_WORKSPACES.split(',').map((id, idx) => ({ id: id.trim(), name: `Pipeline ${idx + 1}` })).filter(w => w.id);
        }

        // Annars upptäck alla tillgängliga workspaces automatiskt från Oneflow-menyn
        if (workspaces.length === 0) {
            try {
                await page.goto(`https://app.oneflow.com/c/${defaultWsId}/contracts`, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await page.waitForTimeout(2000);

                const picker = page.locator('[data-testid="sidebar-workspace-picker"]');
                if (await picker.count() > 0) {
                    await picker.click();
                    await page.waitForTimeout(1000);

                    const upptackta = await page.evaluate(() => {
                        const popover = document.querySelector('[data-radix-popper-content-wrapper], [role="dialog"], [role="listbox"]');
                        if (!popover) return [];

                        const res = [];
                        // Hitta alla relevanta element och knappar i menyn
                        const elements = Array.from(popover.querySelectorAll('[data-slot="combobox-item"], [role="option"], button, [data-value]'));
                        
                        for (const it of elements) {
                            const text = it.innerText ? it.innerText.trim() : '';
                            if (!text) continue;

                            // Kolla om detta är "Delade med mig" (ID: 0)
                            if (text.toLowerCase().includes('delade med mig')) {
                                if (!res.some(r => r.id === '0')) {
                                    res.push({ id: '0', name: 'Delade med mig' });
                                }
                                continue;
                            }

                            // Hämta ID från vanliga attribut
                            let id = it.getAttribute('data-value') || it.getAttribute('data-id') || it.getAttribute('value');
                            
                            // Om ID saknas, kolla href
                            if (!id) {
                                const href = it.getAttribute('href') || (it.querySelector('a') && it.querySelector('a').getAttribute('href'));
                                if (href) {
                                    const m = href.match(/\/c\/(\d+)/);
                                    if (m) id = m[1];
                                }
                            }

                            // Om ID fortfarande saknas, sök igenom elementets alla attribut efter ett siffer-ID
                            if (!id) {
                                for (const attr of Array.from(it.attributes)) {
                                    if (/^\d{5,10}$/.test(attr.value)) {
                                        id = attr.value;
                                        break;
                                    }
                                }
                            }

                            if (id && !res.some(r => r.id === id)) {
                                res.push({ id, name: text });
                            }
                        }
                        return res;
                    });

                    if (upptackta.length > 0) {
                        workspaces = upptackta;
                    }

                    // Stäng menyn igen
                    await page.keyboard.press('Escape').catch(() => null);
                }
            } catch (err) {
                console.log("Kunde inte läsa in workspaces automatiskt via menyn:", err.message);
            }
        }

        // Fallback: om inga hittades i gränssnittet, använd standard från inloggning / .env
        if (workspaces.length === 0) {
            workspaces = [{ id: defaultWsId, name: 'Standard' }];
        }

        const wsNamnLista = workspaces.map(w => `"${w.name}" (${w.id})`).join(', ');
        console.log(`[${new Date().toLocaleTimeString()}] Upptäckte ${workspaces.length} st pipeline(s)/workspace(s): ${wsNamnLista}`);

        // Loopa igenom varje workspace / pipeline
        for (const ws of workspaces) {
            console.log(`\n=== Söker offerter i pipeline: ${ws.name} (ID: ${ws.id}) ===`);
            const MAX_SIDOR = 20;

            for (let sidan = 1; sidan <= MAX_SIDOR; sidan++) {
                const url = `https://app.oneflow.com/c/${ws.id}/contracts/all?noTag%5B%5D=1&page=${sidan}`;
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await page.waitForSelector('table', { timeout: 10000 }).catch(() => null);
                // Vänta på att riktiga rader renderas (eller tomt-meddelande) så vi inte misstar den temporära "Laddar"-raden för tom tabell
                await Promise.race([
                    page.waitForSelector('table tbody tr:not(:has(td[colspan]))', { timeout: 15000 }),
                    page.waitForSelector('text=Inga resultat hittades', { timeout: 15000 }),
                    page.waitForSelector('[data-slot="empty"]', { timeout: 15000 })
                ]).catch(() => null);
                await page.waitForTimeout(500);

                // Kolla om sidan faktiskt är tom
                const isEmpty = (await page.locator('[data-slot="empty"]').count() > 0)
                             || (await page.getByText('Inga resultat hittades').count() > 0);
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
                console.log(`[${klockslag}] [${ws.name}] Sida ${sidan}: Läser in ${rows.length} offerter...`);

                // Läs av kolumnindex dynamiskt från thead th så att ordningen alltid matchar 100%
                const colMap = await page.evaluate(() => {
                    const ths = Array.from(document.querySelectorAll('table thead th'));
                    const map = { namn: 2, visningar: 3, status: 4, motpart: 5, deltagare: 6 };
                    ths.forEach((th, idx) => {
                        const txt = th.innerText.toLowerCase().trim();
                        if (txt.includes('namn')) map.namn = idx + 1;
                        else if (txt.includes('visning')) map.visningar = idx + 1;
                        else if (txt.includes('steg') || txt.includes('status')) map.status = idx + 1;
                        else if (txt.includes('motpart')) map.motpart = idx + 1;
                        else if (txt.includes('deltagare')) map.deltagare = idx + 1;
                    });
                    return map;
                });

                let nyaOfferterPaSidan = 0;

                for (let i = 0; i < rows.length; i++) {
                    // Plocka ut information med 2s timeout så det aldrig hänger
                    const namn = await rows[i].locator(`td:nth-child(${colMap.namn})`).innerText({ timeout: 2000 }).catch(() => "Okänd");
                    const visningarStr = await rows[i].locator(`td:nth-child(${colMap.visningar})`).innerText({ timeout: 2000 }).catch(() => "0");
                    const visningar = parseInt(visningarStr) || 0;
                    const status = await rows[i].locator(`td:nth-child(${colMap.status})`).innerText({ timeout: 2000 }).catch(() => "Okänd");

                    // Motpart ligger i kolumn colMap.motpart – försök med flera selektorer för att klara olika Oneflow-versioner
                    let motpart = "Okänd";
                    const motpartSelectors = [
                        `td:nth-child(${colMap.motpart}) span[class*="_ParticipantPillName_"]`,
                        `td:nth-child(${colMap.motpart}) span[class*="ParticipantPillName"]`,
                        `td:nth-child(${colMap.motpart}) [data-slot="participant-name"]`,
                        `td:nth-child(${colMap.motpart}) [class*="pill" i] span`,
                        `td:nth-child(${colMap.motpart}) [class*="Participant" i] span`,
                        `td:nth-child(${colMap.motpart}) [class*="pill" i]`,
                        `td:nth-child(${colMap.motpart}) [class*="Participant" i]`
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
                    // Sista utväg: ta hela motpartskolumnens text och ta första raden
                    if (motpart === "Okänd") {
                        const colText = await rows[i].locator(`td:nth-child(${colMap.motpart})`).innerText({ timeout: 2000 }).catch(() => "");
                        const rader = colText.split('\n').map(r => r.trim()).filter(r => r.length > 0 && !r.startsWith('+'));
                        if (rader.length > 0 && rader[0].length < 60) {
                            motpart = rader[0];
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
                            uniktId = `fallback_${ws.id}_${sidan}_${i}_${namn}_${motpart}`;
                        }

                        // Identifiera offerten unikt (inkluderar workspace för att garantera unikhet)
                        const sparatId = Buffer.from(`${ws.id}_${uniktId}`).toString('base64');
                        
                        let exaktTid = "Idag";
                        const gammalData = gamlaOfferter[sparatId];

                        // Om visningar har ökat gör vi hover på profilcirkeln under Deltagare
                        if (gammalData && visningar > gammalData.visningar) {
                            try {
                                const avatar = rows[i].locator(`td:nth-child(${colMap.deltagare}) [role="button"]`).last();
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
                            workspace: ws.name,
                            workspaceId: ws.id,
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
        }
        
        let antalAndringar = 0;
        const datumNu = new Date().toISOString().split('T')[0];
        const tidNu = new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });

        for (const [id, nyData] of Object.entries(nuvarandeOfferter)) {
            const gammalData = gamlaOfferter[id];
            
            if (gammalData) {
                let andrad = false;
                let meddelande = "";
                let titel = "";
                const pipelineRad = (workspaces.length > 1 && nyData.workspace) ? `Pipeline: ${nyData.workspace}\n` : '';

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
                    meddelande = `Offert: ${nyData.namn}\n${pipelineRad}Motpart: ${nyData.motpart}\nVisningar: ${gammalData.visningar} -> ${nyData.visningar}\nDagar sen sist tittad: ${dagarSedan}\nSenast tittad nu: ${nyData.senastTittad}`;
                }
                // 2. Kolla om statusen har ändrats
                else if (gammalData.status !== nyData.status) {
                    andrad = true;
                    titel = `${nyData.motpart} (Status)`;
                    meddelande = `Offert: ${nyData.namn}\n${pipelineRad}Motpart: ${nyData.motpart}\nStatus ändrades från ${gammalData.status} till ${nyData.status}\nVisningar: ${nyData.visningar}`;
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
