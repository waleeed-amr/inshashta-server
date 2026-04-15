const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const storage = multer.memoryStorage();
const upload = multer({ storage });

// Initialize Firebase Admin
try {
  let serviceAccount;
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  } else {
    serviceAccount = require('./app-loction-5-firebase-adminsdk-fbsvc-d43e43975e.json');
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log('✅ Firebase Admin SDK initialized.');
} catch (e) {
  console.error('❌ Firebase init failed:', e.message);
}

const db = admin.apps.length ? admin.firestore() : null;

// ==========================================
// HELPER: Save notification to Firestore
// ==========================================
async function saveNotification({ userId, title, body, type, targetId, senderName }) {
  if (!db) return null;
  try {
    const notifRef = await db.collection('Notifications').add({
      userId: userId || 'all',
      title,
      body,
      type: type || 'general',
      targetId: targetId || '',
      senderName: senderName || '',
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`📝 Notification saved: ${notifRef.id} for user ${userId || 'all'}`);
    return notifRef.id;
  } catch (err) {
    console.error('❌ Failed to save notification:', err.message);
    return null;
  }
}

// ==========================================
// HELPER: Send FCM and save notifications
// ==========================================
async function sendFCMAndSave({ tokens, userIds, title, body, data, type, targetId, senderName }) {
  if (!tokens || tokens.length === 0) {
    console.log('⚠️ No tokens to send to');
    return { sent: 0, saved: 0 };
  }

  let sent = 0;
  let saved = 0;

  // Send FCM
  try {
    const payload = {
      notification: { title, body },
      data: data || {},
      tokens
    };
    const response = await admin.messaging().sendEachForMulticast(payload);
    sent = response.successCount;
    console.log(`📲 FCM sent: ${sent}/${tokens.length} successful`);

    // Log failures
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        console.error(`  ❌ Token[${idx}] failed:`, resp.error?.message);
      }
    });
  } catch (err) {
    console.error('❌ FCM send error:', err.message);
  }

  // Save to Firestore for each user
  if (userIds && userIds.length > 0) {
    for (const uid of userIds) {
      await saveNotification({ userId: uid, title, body, type, targetId, senderName });
      saved++;
    }
  }

  return { sent, saved };
}

// ==========================================
// API ROUTES
// ==========================================

// Health check
app.get('/', (req, res) => res.json({ status: 'Server is running', version: '3.0.0' }));
app.get('/api', (req, res) => res.json({ status: 'Server is running', version: '3.0.0' }));

// ==========================================
// 1. Notify Message - Chat & DM notifications
// ==========================================
app.post('/api/notify-message', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not available' });
    const { matchId, senderId, text } = req.body;
    if (!matchId || !senderId) return res.status(400).json({ error: 'matchId and senderId required' });

    console.log(`\n📨 Notify message: matchId=${matchId}, senderId=${senderId}`);

    // Get sender name
    const senderDoc = await db.collection('Users').doc(senderId).get();
    const senderName = senderDoc.exists ? senderDoc.data().name : 'User';

    const isDM = matchId.startsWith('dm_');
    const tokens = [];
    const userIds = [];
    let chatName = '';

    if (isDM) {
      // DM: get the other user's token
      const parts = matchId.replace('dm_', '').split('_');
      const otherUid = parts.find(p => p !== senderId);
      if (otherUid) {
        const otherDoc = await db.collection('Users').doc(otherUid).get();
        if (otherDoc.exists && otherDoc.data().fcmToken) {
          tokens.push(otherDoc.data().fcmToken);
          userIds.push(otherUid);
        }
      }
      chatName = senderName;
    } else {
      // Match Chat: get all players' tokens
      const matchDoc = await db.collection('Matches').doc(matchId).get();
      if (!matchDoc.exists) return res.json({ success: true, sent: 0, reason: 'Match not found' });
      const matchData = matchDoc.data();
      chatName = matchData.name || 'Match';

      for (let pid of (matchData.players || [])) {
        if (pid === senderId) continue;
        const pDoc = await db.collection('Users').doc(pid).get();
        if (pDoc.exists && pDoc.data().fcmToken) {
          tokens.push(pDoc.data().fcmToken);
          userIds.push(pid);
        }
      }
    }

    const title = isDM ? senderName : `${chatName}`;
    const body = isDM ? (text || 'Sent a message') : `${senderName}: ${text || 'Sent a message'}`;

    const result = await sendFCMAndSave({
      tokens,
      userIds,
      title,
      body,
      data: { matchId, type: isDM ? 'dm_message' : 'chat_message' },
      type: isDM ? 'dm_message' : 'chat_message',
      targetId: matchId,
      senderName
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Notify Message Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. Notify Join - Player joined a match
// ==========================================
app.post('/api/notify-join', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not available' });
    const { matchId, userId } = req.body;
    if (!matchId || !userId) return res.status(400).json({ error: 'matchId and userId required' });

    console.log(`\n🤝 Notify join: matchId=${matchId}, userId=${userId}`);

    // Get joiner name
    const userDoc = await db.collection('Users').doc(userId).get();
    const userName = userDoc.exists ? userDoc.data().name : 'Player';

    // Get match info
    const matchDoc = await db.collection('Matches').doc(matchId).get();
    if (!matchDoc.exists) return res.json({ success: true, sent: 0, reason: 'Match not found' });
    const matchData = matchDoc.data();
    const matchName = matchData.name || 'Match';
    const leaderId = matchData.leaderId;

    // Notify the leader
    const tokens = [];
    const userIds = [];

    if (leaderId && leaderId !== userId) {
      const leaderDoc = await db.collection('Users').doc(leaderId).get();
      if (leaderDoc.exists && leaderDoc.data().fcmToken) {
        tokens.push(leaderDoc.data().fcmToken);
        userIds.push(leaderId);
      }
    }

    const title = `⚽ ${matchName}`;
    const body = `${userName} joined the match! (${(matchData.players || []).length}/${matchData.maxPlayers || 14})`;

    const result = await sendFCMAndSave({
      tokens,
      userIds,
      title,
      body,
      data: { matchId, type: 'player_joined' },
      type: 'player_joined',
      targetId: matchId,
      senderName: userName
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Notify Join Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. Broadcast to ALL users
// ==========================================
app.post('/api/broadcast', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not available' });
    const { title, message } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'title and message required' });

    console.log(`\n📢 Broadcast: "${title}" - "${message}"`);

    const usersSnap = await db.collection('Users').get();
    const tokens = [];
    const userIds = [];
    usersSnap.forEach(doc => {
      if (doc.data().fcmToken) {
        tokens.push(doc.data().fcmToken);
        userIds.push(doc.id);
      }
    });

    // Also save a global notification for users without tokens
    await saveNotification({
      userId: 'all',
      title,
      body: message,
      type: 'global_broadcast',
      targetId: '',
      senderName: 'Admin'
    });

    if (tokens.length === 0) return res.json({ success: true, sent: 0, saved: 1 });

    // Send FCM (but don't save per-user since we have global)
    let sent = 0;
    try {
      const response = await admin.messaging().sendEachForMulticast({
        notification: { title, body: message },
        data: { type: 'global_broadcast' },
        tokens
      });
      sent = response.successCount;
      console.log(`📲 Broadcast FCM: ${sent}/${tokens.length}`);
    } catch (err) {
      console.error('❌ Broadcast FCM error:', err.message);
    }

    res.json({ success: true, sent, total: tokens.length });
  } catch (err) {
    console.error('[Broadcast Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. Mark notification as read
// ==========================================
app.post('/api/mark-read', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not available' });
    const { notificationId } = req.body;
    if (!notificationId) return res.status(400).json({ error: 'notificationId required' });

    await db.collection('Notifications').doc(notificationId).update({ read: true });
    res.json({ success: true });
  } catch (err) {
    console.error('[Mark Read Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 5. Mark all notifications as read for user
// ==========================================
app.post('/api/mark-all-read', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not available' });
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const batch = db.batch();
    const snap = await db.collection('Notifications')
      .where('userId', 'in', [userId, 'all'])
      .where('read', '==', false)
      .get();

    snap.forEach(doc => {
      batch.update(doc.ref, { read: true });
    });

    await batch.commit();
    console.log(`✅ Marked ${snap.size} notifications as read for ${userId}`);
    res.json({ success: true, count: snap.size });
  } catch (err) {
    console.error('[Mark All Read Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 6. Send single notification (test)
// ==========================================
app.post('/send-notification', async (req, res) => {
  try {
    const { title, body, token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const response = await admin.messaging().send({
      notification: { title, body }, token
    });
    console.log(`📲 Single notification sent: ${response}`);
    res.json({ success: true, messageId: response });
  } catch (err) {
    console.error('[Send Notification Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 7. Upload Image (JSON Base64 Mode)
// ==========================================
app.post('/upload-image', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'No image provided' });
    const apiKey = process.env.IMAGEBB_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'IMAGEBB_API_KEY missing' });

    // Clean base64 string (remove data:image/png;base64, prefix if exists)
    const base64Data = image.replace(/^data:image\/\w+;base64,/, "");

    const formData = new FormData();
    formData.append('image', base64Data);

    const response = await axios.post(`https://api.imgbb.com/1/upload?key=${apiKey}`, formData, {
      headers: formData.getHeaders()
    });
    console.log(`📸 Image uploaded via ImgBB:`, response.data.data.url);
    res.json({ success: true, url: response.data.data.url });
  } catch (err) {
    console.error('❌ Upload failed:', err.response?.data || err.message);
    res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

// ==========================================
// 8. Mute user
// ==========================================
app.post('/mute-user', async (req, res) => {
  try {
    const { userId, leaderId, matchId, durationMinutes } = req.body;
    if (!db) return res.status(500).json({ error: 'DB not available' });
    const matchDoc = await db.collection('Matches').doc(matchId).get();
    if (!matchDoc.exists || matchDoc.data().leaderId !== leaderId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const until = new Date();
    until.setMinutes(until.getMinutes() + (durationMinutes || 5));
    await db.collection('Users').doc(userId).update({
      mutedUntil: admin.firestore.Timestamp.fromDate(until)
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 9. Debug: Check server health
// ==========================================
app.get('/api/health', async (req, res) => {
  const health = {
    server: 'running',
    version: '3.0.0',
    firebase: !!admin.apps.length,
    firestore: !!db,
    timestamp: new Date().toISOString()
  };

  if (db) {
    try {
      const usersCount = await db.collection('Users').count().get();
      health.usersCount = usersCount.data().count;
      const tokensSnap = await db.collection('Users').where('fcmToken', '!=', '').get();
      health.usersWithTokens = tokensSnap.size;
    } catch (err) {
      health.dbError = err.message;
    }
  }

  res.json(health);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));

module.exports = app;
