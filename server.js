const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: true,
    credentials: true
}));
app.use(express.json());

// WhatsApp clients storage: Map<accountId, Client>
const whatsappClients = new Map();
// QR codes storage: Map<accountId, qrDataUrl>
const qrCodes = new Map();
// Connection status: Map<accountId, {connected, phone}>
const connectionStatus = new Map();

// ============ WHATSAPP ROUTES ============

// Connect WhatsApp (start client and generate QR)
app.post('/api/whatsapp/connect', async (req, res) => {
    try {
        const { account_id, user_id } = req.body;

        if (!account_id) {
            return res.status(400).json({ error: 'Account ID required' });
        }

        // Check if client already exists and is ready
        if (whatsappClients.has(account_id)) {
            const existingClient = whatsappClients.get(account_id);
            if (existingClient.info) {
                return res.json({ success: true, connected: true, phone: existingClient.info.wid.user });
            }
        }

        // Create new WhatsApp client
        const client = new Client({
            authStrategy: new LocalAuth({ clientId: account_id }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ]
            }
        });

        whatsappClients.set(account_id, client);
        connectionStatus.set(account_id, { connected: false, phone: null });

        // QR Code event
        client.on('qr', async (qr) => {
            try {
                const qrDataUrl = await QRCode.toDataURL(qr);
                qrCodes.set(account_id, qrDataUrl);
                console.log(`[${account_id}] QR generated`);
            } catch (err) {
                console.error('QR generation error:', err);
            }
        });

        // Ready event
        client.on('ready', () => {
            console.log(`[${account_id}] WhatsApp ready`);
            qrCodes.delete(account_id);

            const phone = client.info?.wid?.user || null;
            connectionStatus.set(account_id, { connected: true, phone });
        });

        // Authenticated event
        client.on('authenticated', () => {
            console.log(`[${account_id}] Authenticated`);
        });

        // Auth failure
        client.on('auth_failure', (msg) => {
            console.error(`[${account_id}] Auth failure:`, msg);
            cleanup(account_id);
        });

        // Disconnected event
        client.on('disconnected', (reason) => {
            console.log(`[${account_id}] Disconnected:`, reason);
            cleanup(account_id);
        });

        // Initialize client
        client.initialize();

        res.json({ success: true, message: 'Connecting...' });
    } catch (error) {
        console.error('Connect error:', error);
        res.status(500).json({ error: 'Failed to start WhatsApp connection' });
    }
});

// Get status (QR code, connection status)
app.get('/api/whatsapp/status', (req, res) => {
    try {
        const { account_id } = req.query;

        if (!account_id) {
            return res.status(400).json({ error: 'Account ID required' });
        }

        const qr = qrCodes.get(account_id) || null;
        const status = connectionStatus.get(account_id) || { connected: false, phone: null };
        const client = whatsappClients.get(account_id);

                // Use the status from the map, which is updated by the ready/disconnected events
        let connected = status.connected;
        let phone = status.phone;

        // If client exists but status is not connected, check client.info as a fallback
        if (client && !connected) {
            if (client.info) {
                connected = true;
                phone = client.info.wid.user;
                // Update the map immediately if we find it's connected
                connectionStatus.set(account_id, { connected: true, phone });
                qrCodes.delete(account_id);
            }
        }

        // If connected, ensure QR is null
        if (connected) {
            qr = null;
        }

        res.json({
            qr,
            connected,
            phone
        });
    } catch (error) {
        console.error('Status error:', error);
        res.status(500).json({ error: 'Failed to get status' });
    }
});

// Send message
app.post('/api/whatsapp/send', async (req, res) => {
    try {
        const { account_id, phone, message } = req.body;

        if (!account_id || !phone || !message) {
            return res.status(400).json({ error: 'Account ID, phone, and message required' });
        }

        const client = whatsappClients.get(account_id);
        if (!client || !client.info) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }

        // Format phone number
        const formattedPhone = phone.replace(/\D/g, '') + '@c.us';

        // Send message
        await client.sendMessage(formattedPhone, message);

        res.json({ success: true, message: 'Message sent' });
    } catch (error) {
        console.error('Send error:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Disconnect account
app.post('/api/whatsapp/disconnect', async (req, res) => {
    try {
        const { account_id } = req.body;

        if (!account_id) {
            return res.status(400).json({ error: 'Account ID required' });
        }

        const client = whatsappClients.get(account_id);
        if (client) {
            // Attempt to logout from WhatsApp first
            await client.logout();
        }
        await cleanup(account_id);
        res.json({ success: true });
    } catch (error) {
        console.error('Disconnect error:', error);
        res.status(500).json({ error: 'Failed to disconnect' });
    }
});

// Cleanup function - fully removes WhatsApp session
async function cleanup(accountId) {
    try {
        const client = whatsappClients.get(accountId);
        if (client) {
            // client.logout() is now called in /api/whatsapp/disconnect
            // The destroy() call below handles the session cleanup
            // We keep the try/catch block for robustness, but remove the redundant logout call
            // try {
            //     await client.logout(); // Logout from WhatsApp
            // } catch (e) { }
            try {
                await client.destroy();
            } catch (e) { }
        }
    } catch (e) { }

    whatsappClients.delete(accountId);
    qrCodes.delete(accountId);
    connectionStatus.set(accountId, { connected: false, phone: null });

    // Try to delete session files
    const fs = require('fs');
    const path = require('path');
    const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-${accountId}`);
    try {
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`[${accountId}] Session files deleted`);
        }
    } catch (e) {
        console.log(`[${accountId}] Could not delete session files:`, e.message);
    }
}

// ============ HEALTH CHECK ============

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        activeClients: whatsappClients.size
    });
});

// Root route
app.get('/', (req, res) => {
    res.json({
        name: 'WhatsApp Sender Backend',
        version: '2.0.0',
        endpoints: {
            health: 'GET /api/health',
            connect: 'POST /api/whatsapp/connect',
            status: 'GET /api/whatsapp/status?account_id=xxx',
            send: 'POST /api/whatsapp/send',
            disconnect: 'POST /api/whatsapp/disconnect'
        }
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🚀 WhatsApp Sender Backend v2.0                         ║
║                                                           ║
║   Server: http://localhost:${PORT}                          ║
║                                                           ║
║   Endpoints:                                              ║
║   • POST /api/whatsapp/connect                            ║
║   • GET  /api/whatsapp/status                             ║
║   • POST /api/whatsapp/send                               ║
║   • POST /api/whatsapp/disconnect                         ║
║                                                           ║
║   Auth & Users managed by PHP frontend (api.php)          ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
    `);
});
