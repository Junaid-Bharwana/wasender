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

// Prevent server crash on Puppeteer errors
process.on('unhandledRejection', (reason, promise) => {
    const errorMsg = reason?.message || reason?.originalMessage || '';
    if (errorMsg.includes('Session closed') || errorMsg.includes('Target closed') || errorMsg.includes('Execution context was destroyed')) {
        // Ignore these common Puppeteer race condition errors during logout
        return;
    }
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Don't exit the process
});

// WhatsApp clients storage: Map<accountId, Client>
const whatsappClients = new Map();
// QR codes storage: Map<accountId, qrDataUrl>
const qrCodes = new Map();
// Connection status: Map<accountId, {connected, phone}>
const connectionStatus = new Map();

// CONFIGURATION
const PHP_API_URL = 'http://localhost/wa3/api.php'; // CHANGE THIS FOR LIVE HOSTING
const INTERNAL_SECRET = 'wa3_internal_secret_key_12345';

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

// ============ WHATSAPP ROUTES ============

// Connect WhatsApp (start client and generate QR)
app.post('/api/whatsapp/connect', async (req, res) => {
    try {
        const { account_id, user_id } = req.body;

        if (!account_id) {
            return res.status(400).json({ error: 'Account ID required' });
        }

        const clientId = String(account_id);

        // Check if client already exists and is ready
        if (whatsappClients.has(clientId)) {
            const existingClient = whatsappClients.get(clientId);
            if (existingClient.info) {
                return res.json({ success: true, connected: true, phone: existingClient.info.wid.user });
            }
        }

        // Create new WhatsApp client
        const client = new Client({
            authStrategy: new LocalAuth({ clientId: clientId }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--disable-gpu'
                ]
            }
        });

        whatsappClients.set(clientId, client);
        connectionStatus.set(clientId, { connected: false, phone: null });

        // QR Code event
        client.on('qr', async (qr) => {
            try {
                const qrDataUrl = await QRCode.toDataURL(qr);
                qrCodes.set(clientId, qrDataUrl);
                console.log(`[${clientId}] QR generated`);
            } catch (err) {
                console.error('QR generation error:', err);
            }
        });

        // Ready event
        client.on('ready', () => {
            console.log(`[${clientId}] WhatsApp ready`);
            qrCodes.delete(clientId);

            const phone = client.info?.wid?.user || null;
            connectionStatus.set(clientId, { connected: true, phone });

            // Sync with PHP
            notifyPhpBackend(clientId, 'connected', phone);
        });

        // Authenticated event
        client.on('authenticated', () => {
            console.log(`[${clientId}] Authenticated`);
            // Update status to show "Authenticating..." on frontend
            const current = connectionStatus.get(clientId) || { connected: false, phone: null };
            connectionStatus.set(clientId, { ...current, authenticating: true });
        });

        // Auth failure
        client.on('auth_failure', (msg) => {
            console.error(`[${clientId}] Auth failure:`, msg);
            cleanup(clientId);
        });

        // Disconnected event
        client.on('disconnected', (reason) => {
            console.log(`[${clientId}] Disconnected:`, reason);
            cleanup(clientId);
            // Sync with PHP
            notifyPhpBackend(clientId, 'disconnected');
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

        const clientId = String(account_id);

        const qr = qrCodes.get(clientId) || null;
        const status = connectionStatus.get(clientId) || { connected: false, phone: null };
        const client = whatsappClients.get(clientId);

        // Double check client info
        const connected = client?.info !== undefined;
        const phone = connected ? client.info.wid.user : status.phone;
        const authenticating = status.authenticating || false;

        res.json({
            qr,
            connected,
            authenticating,
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

        const clientId = String(account_id);

        const client = whatsappClients.get(clientId);
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

// Check existence of numbers (Batch)
app.post('/api/whatsapp/check-numbers', async (req, res) => {
    try {
        const { account_id, numbers } = req.body;

        if (!account_id || !Array.isArray(numbers)) {
            return res.status(400).json({ error: 'Account ID and numbers array required' });
        }

        const clientId = String(account_id);

        const client = whatsappClients.get(clientId);
        if (!client || !client.info) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }

        const results = [];

        // Process in chunks to avoid overwhelming
        for (const number of numbers) {
            try {
                // Remove non-digit chars
                const cleanNumber = number.toString().replace(/\D/g, '');
                if (!cleanNumber) {
                    results.push({ input: number, valid: false, reason: 'Empty' });
                    continue;
                }

                // Check if registered
                const registered = await client.getNumberId(cleanNumber);

                if (registered) {
                    results.push({
                        input: number,
                        valid: true,
                        formatted: registered.user,
                        serialized: registered._serialized
                    });
                } else {
                    results.push({ input: number, valid: false, reason: 'Not on WhatsApp' });
                }
            } catch (e) {
                results.push({ input: number, valid: false, reason: 'Error checking' });
            }
        }

        res.json({ success: true, results });
    } catch (error) {
        console.error('Check numbers error:', error);
        res.status(500).json({ error: 'Failed to check numbers' });
    }
});

// Get Groups
app.get('/api/whatsapp/groups', async (req, res) => {
    try {
        const { account_id } = req.query;
        if (!account_id) return res.status(400).json({ error: 'Account ID required' });

        const clientId = String(account_id);

        const client = whatsappClients.get(clientId);
        if (!client || !client.info) return res.status(400).json({ error: 'WhatsApp not connected' });

        // Retry logic for getChats to handle "Evaluation failed"
        let chats;
        let attempts = 0;
        while (attempts < 3) {
            try {
                // Abort if client was disconnected during retry wait
                if (!whatsappClients.has(clientId)) {
                    throw new Error('Client disconnected');
                }

                chats = await client.getChats();
                break;
            } catch (e) {
                // Ignore session closed errors if we are disconnecting
                if (e.message.includes('Session closed')) {
                    throw new Error('Client disconnected during request');
                }

                attempts++;
                if (attempts >= 3) throw e;
                console.log(`[${clientId}] Retrying getChats (${attempts}/3)...`);
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        const groups = chats
            .filter(chat => chat.isGroup)
            .map(chat => ({
                id: chat.id._serialized,
                name: chat.name,
                participantCount: chat.participants.length,
                unreadCount: chat.unreadCount
            }));

        res.json({ success: true, groups });
    } catch (error) {
        // Don't log expected disconnect errors
        if (error.message !== 'Client disconnected' && error.message !== 'Client disconnected during request') {
            console.error('Get groups error:', error);
        }
        res.status(500).json({ error: 'Failed to fetch groups' });
    }
});

// Get Group Participants
app.get('/api/whatsapp/group-participants', async (req, res) => {
    try {
        const { account_id, group_id } = req.query;
        if (!account_id || !group_id) return res.status(400).json({ error: 'Account ID and Group ID required' });

        const clientId = String(account_id);

        const client = whatsappClients.get(clientId);
        if (!client || !client.info) return res.status(400).json({ error: 'WhatsApp not connected' });

        const chat = await client.getChatById(group_id);
        if (!chat || !chat.isGroup) return res.status(404).json({ error: 'Group not found' });

        const participants = chat.participants.map(p => ({
            id: p.id._serialized,
            user: p.id.user,
            isAdmin: p.isAdmin,
            isSuperAdmin: p.isSuperAdmin
        }));

        res.json({ success: true, participants });
    } catch (error) {
        console.error('Get participants error:', error);
        res.status(500).json({ error: 'Failed to fetch participants' });
    }
});

// Disconnect account
app.post('/api/whatsapp/disconnect', async (req, res) => {
    try {
        const { account_id } = req.body;

        if (!account_id) {
            return res.status(400).json({ error: 'Account ID required' });
        }

        const clientId = String(account_id);

        // Delegate entire process to cleanup to avoid race conditions
        console.log(`[${clientId}] Disconnect requested via API`);
        await cleanup(clientId);

        // Also ensure PHP is updated
        notifyPhpBackend(clientId, 'disconnected');

        res.json({ success: true });
    } catch (error) {
        console.error('Disconnect error:', error);
        res.status(500).json({ error: 'Failed to disconnect' });
    }
});

// Cleanup function - fully removes WhatsApp session
async function cleanup(accountId) {
    const clientId = String(accountId);
    try {
        const client = whatsappClients.get(clientId);
        if (client) {
            try {
                // Attempt to logout first
                // This ensures the session is invalidated on the phone
                await client.logout();
                console.log(`[${clientId}] Logged out from WhatsApp Web`);
            } catch (e) {
                console.warn(`[${clientId}] Logout failed:`, e.message);
            }

            // CRITICAL: Wait longer for logout network packet to be fully processed
            await new Promise(resolve => setTimeout(resolve, 3000));

            try {
                // Then destroy the browser
                await client.destroy();
            } catch (e) { }

            // CRITICAL: Wait for file locks to be released on Windows
            // Chrome takes a moment to release handle on debug.log and cache files
            await new Promise(resolve => setTimeout(resolve, 2500));
        }
    } catch (e) { }

    whatsappClients.delete(clientId);
    qrCodes.delete(clientId);
    connectionStatus.set(clientId, { connected: false, phone: null });

    // Try to delete session files with native retry
    const fs = require('fs');
    const path = require('path');
    const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-${clientId}`);
    try {
        if (fs.existsSync(sessionPath)) {
            // maxRetries helps with EBUSY/EPERM on Windows
            fs.rmSync(sessionPath, {
                recursive: true,
                force: true,
                maxRetries: 5,
                retryDelay: 1000
            });
            console.log(`[${clientId}] Session files deleted`);
        }
    } catch (e) {
        // If it still fails, just log it. It's not critical for server operation.
        // It might be cleaned up on next restart or manual deletion.
        console.log(`[${clientId}] Note: Could not delete session files (likely locked):`, e.message);
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
