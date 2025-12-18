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
const PHP_API_URL = 'http://localhost/wa3/api.php'; // CHANGE THIS FOR LIVE HOSTING
const INTERNAL_SECRET = 'wa3_internal_secret_key_12345';

// Logger
const logger = pino({ level: 'silent' });

// Helper to update PHP backend
async function notifyPhpBackend(accountId, status, phone = null) {
    try {
        const url = `${PHP_API_URL}?action=internal_status_update`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                secret: INTERNAL_SECRET,
                account_id: accountId,
                status,
                phone
            })
        });
        console.log(`[${accountId}] Notified PHP backend: ${status}`);
    } catch (e) {
        console.error(`[${accountId}] Failed to notify PHP backend:`, e.message);
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
                startSession(clientId);
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
        const participants = metadata.participants.map(p => ({
            id: p.id,
            user: p.id.split('@')[0],
            isAdmin: p.admin === 'admin',
            isSuperAdmin: p.admin === 'superadmin'
        }));

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

app.listen(PORT, () => {
    console.log(`WhatsApp Sender (Baileys) running on port ${PORT}`);
});
