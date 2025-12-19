const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    isJidGroup
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: true,
    credentials: true
}));
app.use(express.json());

// WhatsApp sockets storage: Map<accountId, Socket>
const sessions = new Map();
// QR codes storage: Map<accountId, qrDataUrl>
const qrCodes = new Map();
// Connection status: Map<accountId, {connected, phone}>
const connectionStatus = new Map();

// CONFIGURATION
const PHP_API_URL = 'https://w.junaidinsights.com/api.php'; // CHANGE THIS FOR LIVE HOSTING
const INTERNAL_SECRET = 'wa3_internal_secret_key_12345';

// Logger
const logger = pino({ level: 'silent' });

// Helper to update PHP backend
async function notifyPhpBackend(accountId, status, phone = null) {
    try {
        const url = `${PHP_API_URL}?action=internal_status_update`;
        console.log(`[${accountId}] Notifying PHP: ${status} at ${url}`);

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                secret: INTERNAL_SECRET,
                account_id: accountId,
                status,
                phone
            })
        });

        if (!response.ok) {
            const text = await response.text();
            console.error(`[${accountId}] PHP Error (${response.status}): ${text.substring(0, 200)}`);
        } else {
            console.log(`[${accountId}] Notified PHP backend: ${status}`);
        }
    } catch (e) {
        console.error(`[${accountId}] Failed to notify PHP backend:`, e.message);
        if (e.message.includes('fetch failed')) {
            console.error(`[${accountId}] TIP: Check if PHP_API_URL (${PHP_API_URL}) is accessible from the Node.js environment.`);
        }
    }
}

// Function to start a WhatsApp session
async function startSession(accountId) {
    const clientId = String(accountId);
    const authPath = path.join(__dirname, 'data', 'auth', `session-${clientId}`);

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        browser: ['WhatsApp Sender', 'Chrome', '1.0.0']
    });

    sessions.set(clientId, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                const qrDataUrl = await QRCode.toDataURL(qr);
                qrCodes.set(clientId, qrDataUrl);
                console.log(`[${clientId}] QR generated`);
            } catch (err) {
                console.error('QR generation error:', err);
            }
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`[${clientId}] Connection closed. Reason:`, lastDisconnect?.error, "Reconnect:", shouldReconnect);

            qrCodes.delete(clientId);
            connectionStatus.set(clientId, { connected: false, phone: null });

            if (shouldReconnect) {
                console.log(`[${clientId}] Reconnecting in 5 seconds...`);
                setTimeout(() => startSession(clientId), 5000);
            } else {
                sessions.delete(clientId);
                notifyPhpBackend(clientId, 'disconnected');
                // Cleanup files
                try {
                    fs.rmSync(authPath, { recursive: true, force: true });
                } catch (e) { }
            }
        } else if (connection === 'open') {
            console.log(`[${clientId}] WhatsApp connected`);
            qrCodes.delete(clientId);

            const phone = sock.user.id.split(':')[0];
            connectionStatus.set(clientId, { connected: true, phone });

            notifyPhpBackend(clientId, 'connected', phone);
        }
    });

    return sock;
}

// ============ WHATSAPP ROUTES ============

app.get('/', (req, res) => {
    const sessionCount = sessions.size;
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>WhatsApp Backend Status</title>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
            <style>
                :root {
                    --bg: #0f172a;
                    --card: #1e293b;
                    --text: #f8fafc;
                    --primary: #10b981;
                }
                body {
                    font-family: 'Inter', sans-serif;
                    background-color: var(--bg);
                    color: var(--text);
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                }
                .card {
                    background: var(--card);
                    padding: 2rem;
                    border-radius: 1rem;
                    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
                    text-align: center;
                    max-width: 400px;
                    width: 90%;
                    border: 1px solid rgba(255,255,255,0.1);
                }
                h1 { margin: 0 0 1rem; font-size: 1.5rem; }
                .status {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.5rem;
                    background: rgba(16, 185, 129, 0.1);
                    color: var(--primary);
                    padding: 0.5rem 1rem;
                    border-radius: 2rem;
                    font-weight: 600;
                    margin-bottom: 1.5rem;
                }
                .dot {
                    width: 10px;
                    height: 10px;
                    background: var(--primary);
                    border-radius: 50%;
                    box-shadow: 0 0 10px var(--primary);
                    animation: pulse 2s infinite;
                }
                @keyframes pulse {
                    0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
                    70% { transform: scale(1); box-shadow: 0 0 0 10px rgba(16, 185, 129, 0); }
                    100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
                }
                .stats {
                    font-size: 0.9rem;
                    color: #94a3b8;
                    border-top: 1px solid rgba(255,255,255,0.1);
                    padding-top: 1rem;
                }
                strong { color: var(--text); }
            </style>
        </head>
        <body>
            <div class="card">
                <div class="status">
                    <span class="dot"></span>
                    Server is Online
                </div>
                <h1>WhatsApp Backend</h1>
                <div class="stats">
                    Active Sessions: <strong>${sessionCount}</strong><br>
                    Uptime: <strong>${Math.floor(process.uptime() / 60)} minutes</strong>
                </div>
            </div>
        </body>
        </html>
    `);
});

app.post('/api/whatsapp/connect', async (req, res) => {
    try {
        const { account_id } = req.body;
        if (!account_id) return res.status(400).json({ error: 'Account ID required' });

        const clientId = String(account_id);

        if (sessions.has(clientId)) {
            const status = connectionStatus.get(clientId);
            if (status && status.connected) {
                return res.json({ success: true, connected: true, phone: status.phone });
            }
        }

        await startSession(clientId);
        res.json({ success: true, message: 'Connecting...' });
    } catch (error) {
        console.error('Connect error:', error);
        res.status(500).json({ error: 'Failed to start WhatsApp connection' });
    }
});

app.get('/api/whatsapp/status', (req, res) => {
    try {
        const { account_id } = req.query;
        if (!account_id) return res.status(400).json({ error: 'Account ID required' });

        const clientId = String(account_id);
        const qr = qrCodes.get(clientId) || null;
        const status = connectionStatus.get(clientId) || { connected: false, phone: null };

        res.json({
            qr,
            connected: status.connected,
            authenticating: !status.connected && !qr && sessions.has(clientId),
            phone: status.phone
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get status' });
    }
});

app.post('/api/whatsapp/send', async (req, res) => {
    try {
        const { account_id, phone, message } = req.body;
        if (!account_id || !phone || !message) {
            return res.status(400).json({ error: 'Missing fields' });
        }

        const sock = sessions.get(String(account_id));
        if (!sock) return res.status(400).json({ error: 'WhatsApp not connected' });

        const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: message });

        res.json({ success: true, message: 'Message sent' });
    } catch (error) {
        console.error('Send error:', error);
        res.status(500).json({ error: 'Failed to send' });
    }
});

app.post('/api/whatsapp/check-numbers', async (req, res) => {
    try {
        const { account_id, numbers } = req.body;
        const sock = sessions.get(String(account_id));
        if (!sock) return res.status(400).json({ error: 'Not connected' });

        const results = [];
        for (const number of numbers) {
            const clean = number.toString().replace(/\D/g, '');
            if (!clean) continue;

            const [result] = await sock.onWhatsApp(clean);
            if (result && result.exists) {
                results.push({ input: number, valid: true, formatted: result.jid.split('@')[0] });
            } else {
                results.push({ input: number, valid: false });
            }
        }
        res.json({ success: true, results });
    } catch (error) {
        res.status(500).json({ error: 'Failed to check' });
    }
});

app.get('/api/whatsapp/groups', async (req, res) => {
    try {
        const { account_id } = req.query;
        const sock = sessions.get(String(account_id));
        if (!sock) return res.status(400).json({ error: 'Not connected' });

        // Baileys doesn't have a simple getGroups, we usually get them from the store or by fetching metadata
        // For simplicity in this replacement, we'll try to fetch all joined groups if supported or return empty
        const groups = [];
        const chats = await sock.groupFetchAllParticipating();

        for (const id in chats) {
            const chat = chats[id];
            groups.push({
                id: chat.id,
                name: chat.subject,
                participantCount: chat.participants.length,
                unreadCount: 0 // Baileys doesn't track unread easily without a store
            });
        }

        res.json({ success: true, groups });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch groups' });
    }
});

app.get('/api/whatsapp/group-participants', async (req, res) => {
    try {
        const { account_id, group_id } = req.query;
        const sock = sessions.get(String(account_id));
        if (!sock) return res.status(400).json({ error: 'Not connected' });

        const metadata = await sock.groupMetadata(group_id);
        const participants = metadata.participants.map(p => {
            // Standard JID: number@s.whatsapp.net or number:suffix@s.whatsapp.net
            // LID: lid-number@s.whatsapp.net
            let user = p.id.split('@')[0];
            if (user.includes(':')) user = user.split(':')[0]; // Remove device suffix
            if (user.startsWith('lid-')) user = user.replace('lid-', ''); // Remove lid prefix

            return {
                id: p.id,
                user: user,
                name: p.notify || '', // Use pushname/notify name if available
                isAdmin: p.admin === 'admin' || p.admin === 'superadmin', // Include superadmins
                isSuperAdmin: p.admin === 'superadmin'
            };
        });

        res.json({ success: true, participants });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch participants' });
    }
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
    try {
        const { account_id } = req.body;
        const clientId = String(account_id);
        const sock = sessions.get(clientId);

        if (sock) {
            await sock.logout();
            sessions.delete(clientId);
        }

        notifyPhpBackend(clientId, 'disconnected');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to disconnect' });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', activeSessions: sessions.size });
});

// Process handlers to prevent crashes
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err, origin) => {
    console.error('Uncaught Exception:', err, 'at:', origin);
});

// Initialize existing sessions from disk
async function initSessions() {
    const authDir = path.join(__dirname, 'data', 'auth');
    console.log('Checking for existing sessions in:', authDir);

    if (!fs.existsSync(authDir)) {
        console.log('No auth directory found, skipping session initialization.');
        return;
    }

    try {
        const folders = fs.readdirSync(authDir);
        for (const folder of folders) {
            if (folder.startsWith('session-')) {
                const clientId = folder.replace('session-', '');
                console.log(`[Startup] Restoring session: ${clientId}`);
                // Don't await here to allow concurrent loading
                startSession(clientId).catch(err => {
                    console.error(`[Startup] Failed to restore session ${clientId}:`, err.message);
                });
            }
        }
    } catch (err) {
        console.error('Failed to read auth directory:', err.message);
    }
}

app.listen(PORT, () => {
    console.log(`WhatsApp Sender (Baileys) running on port ${PORT}`);
    initSessions();

});
