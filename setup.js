const readline = require('readline');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

async function runSetup() {
    console.log('\n=============================================');
    console.log('   Välkommen till konfigurationen av Säljbot');
    console.log('=============================================\n');
    console.log('Detta skript skapar automatiskt din lokala .env-fil\nmed dina inloggningsuppgifter.\n');

    const email = await askQuestion('1. Ange din Oneflow e-post: ');
    const password = await askQuestion('2. Ange ditt Oneflow lösenord: ');
    
    console.log('\nNtfy är appen i mobilen som tar emot dina push-notiser.');
    console.log('Välj ett unikt namn (små bokstäver och bindestreck, t.ex. johan-offerter-24)');
    const topic = await askQuestion('3. Välj notis-kanal (ntfy topic): ');

    const workspaceInput = await askQuestion('4. Oneflow Workspace ID [Tryck Enter för standard 553051]: ');
    const workspaceId = workspaceInput.trim() ? workspaceInput.trim() : '553051';

    rl.close();

    const envContent = `ONEFLOW_EMAIL=${email.trim()}
ONEFLOW_PASSWORD=${password.trim()}
NTFY_TOPIC=${topic.trim()}
ONEFLOW_WORKSPACE_ID=${workspaceId}
`;

    const envPath = path.join(__dirname, '.env');
    fs.writeFileSync(envPath, envContent, 'utf8');

    console.log('\n✅ Klart! Din .env-fil har skapats.');
    console.log('\n---------------------------------------------');
    console.log('📱 GÖR SÅ HÄR I MOBILEN:');
    console.log('1. Ladda ner appen "ntfy" (App Store eller Google Play)');
    console.log(`2. Klicka på "+" och prenumerera på ämnet: ${topic.trim()}`);
    console.log(`   (Eller följ i webbläsaren på: https://ntfy.sh/${topic.trim()})`);
    console.log('---------------------------------------------');
    console.log('\n🚀 FÖR ATT STARTA BOTEN:');
    console.log('Kör kommandot:');
    console.log('   npm start');
    console.log('Eller om du vill se webbläsaren arbeta:');
    console.log('   npm run show\n');
}

runSetup();
