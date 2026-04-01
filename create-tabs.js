require('dotenv').config();
const { google } = require('googleapis');
const credentials = require('./credentials.json');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });

async function createTabs() {
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

    // The tabs we want:
    const tabs = ['Lead', 'Qarzdorlar', 'Bosh Xonalar', 'Rad Etilganlar', 'Moliya'];

    // Get existing
    const res = await sheets.spreadsheets.get({ spreadsheetId });
    const existing = res.data.sheets.map(s => s.properties.title);

    const requests = [];
    for (const tab of tabs) {
        if (!existing.includes(tab)) {
            requests.push({
                addSheet: {
                    properties: { title: tab }
                }
            });
        }
    }

    if (requests.length > 0) {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            resource: { requests }
        });
        console.log("Created missing tabs.");
    } else {
        console.log("Tabs already exist.");
    }
}

createTabs().catch(console.error);
