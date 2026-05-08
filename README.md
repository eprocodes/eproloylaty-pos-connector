# eProLoyalty POS Bridge

## Project files
```
eproloyalty-app/
├── main.js                  ← Electron entry: manages both windows
├── preload.js               ← IPC bridge (main ↔ renderer)
├── package.json
├── assets/
│   └── icon.ico             ← App icon (create a 256×256 .ico file)
└── renderer/
    ├── agent.html           ← Desktop widget (transparent, always-on-top)
    └── settings.html        ← Full POS Bridge settings window
```

---

## STEP 1 — Install Node.js

Download and install from https://nodejs.org  
Choose the **LTS** version (e.g. 20.x).  
Verify: open Command Prompt and run:
```
node -v
npm -v
```

---

## STEP 2 — Install dependencies

Open Command Prompt in the project folder, then run:
```
npm install
```
This installs Electron and all packages listed in package.json.

---

## STEP 3 — Run in development (test it)

```
npm start
```
The agent widget appears on your desktop bottom-right corner.  
Click the icon → menu opens. Click Settings → POS Bridge window opens.

---

## STEP 4 — Build the Windows .exe installer

```
npm run build:win
```

This creates a `dist/` folder containing:
```
dist/
└── eProLoyalty POS Bridge Setup 1.4.2.exe   ← installer
```

Double-click the installer on any Windows PC to install the app.

## Local Data Storage (Single DB)

The app uses one embedded SQLite database for all local data:
- settings
- live monitor counters/stats
- transaction history

Database file location on Windows:
`%APPDATA%\eproloyalty-pos-bridge\eproloyalty.db`

No separate database installation is needed. It is bundled with the app installer.

---

## Add your app icon (required for build)

1. Create a folder: `assets/`
2. Put a 256×256 `.ico` file named `icon.ico` inside it.
   - Free converter: https://icoconvert.com
   - Use your eProLoyalty logo PNG → convert to ICO

---

## Auto-start with Windows (optional)

Add this inside `app.whenReady()` in main.js:
```js
app.setLoginItemSettings({
  openAtLogin: true,
  name: 'eProLoyalty POS Bridge',
  path: app.getPath('exe'),
});
```

---

## Connect to real POS database

In `main.js`, add a polling interval after `createAgentWindow()`:

```js
const sql = require('mssql');

const dbConfig = {
  user:     'sa',
  password: 'your_password',
  server:   'localhost\\SQLEXPRESS',
  database: 'POSDB',
  options:  { encrypt: false, trustServerCertificate: true }
};

let lastInvId = null;

async function pollPOS() {
  try {
    const pool   = await sql.connect(dbConfig);
    const result = await pool.request().query(`
      SELECT TOP 1 InvoiceNo, InvoiceTotal
      FROM Transactions
      WHERE Status = 'PAID'
      ORDER BY TransDate DESC
    `);
    if (result.recordset.length > 0) {
      const row = result.recordset[0];
      if (row.InvoiceNo !== lastInvId) {
        lastInvId = row.InvoiceNo;
        // Send to agent window → agent shows loyalty popup
        if (agentWin) agentWin.webContents.send('new-transaction', {
          invId: row.InvoiceNo,
          amt:   row.InvoiceTotal
        });
      }
    }
  } catch(e) {
    console.error('POS poll error:', e.message);
  }
}

setInterval(pollPOS, 3000); // poll every 3 seconds
```

Then in `preload.js` add:
```js
onNewTransaction: (cb) => ipcRenderer.on('new-transaction', (_, d) => cb(d)),
```

And in `agent.html` JS:
```js
if (window.electronAPI) {
  window.electronAPI.onNewTransaction(({ invId, amt }) => {
    showLoyaltyPopup(amt, invId);
  });
}
```

---

## How the two windows work

| Window          | Frame | Transparent | Always on top | Taskbar |
|-----------------|-------|-------------|---------------|---------|
| `agent.html`    | No    | Yes         | Yes           | Hidden  |
| `settings.html` | Yes   | No          | No            | Visible |

The agent window is resized by `main.js` via IPC:
- `agent-collapse` → 64×64px (icon only)
- `agent-expand`   → 248×440px (menu fully visible)

This avoids clipping because the OS moves/resizes the window,
not the browser (`window.resizeTo` is unreliable in Electron).
