const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Set up Multer for form-data (image uploads)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Initialize Firebase Admin (Requires serviceAccountKey.json)
try {
  const serviceAccount = require('./app-loction-5-firebase-adminsdk-fbsvc-d43e43975e.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('Firebase Admin SDK initialized successfully.');
} catch (error) {
  console.log('Ensure you have a valid serviceAccountKey.json file.');
}

const db = admin.apps.length ? admin.firestore() : null;

// ==========================================
// Realtime Observer - Match Chat + DM Notifications
// ==========================================
if (db) {
  console.log('[Observer] Watching Messages collection...');
  
  const now = admin.firestore.Timestamp.now();
  db.collection('Messages').where('createdAt', '>=', now).onSnapshot(snapshot => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type === 'added') {
        const msg = change.doc.data();
        if (!msg.matchId || !msg.senderId) return;

        try {
          // Get sender name
          const senderDoc = await db.collection('Users').doc(msg.senderId).get();
          const senderName = senderDoc.exists ? senderDoc.data().name : 'User';

          const isDM = msg.matchId.startsWith('dm_');
          let tokens = [];
          let chatName = '';

          if (isDM) {
            // --- DM (Private Chat) ---
            const parts = msg.matchId.replace('dm_', '').split('_');
            const otherUid = parts.find(p => p !== msg.senderId);
            if (!otherUid) return;

            const otherDoc = await db.collection('Users').doc(otherUid).get();
            if (otherDoc.exists && otherDoc.data().fcmToken) {
              tokens.push(otherDoc.data().fcmToken);
            }
            chatName = senderName;
          } else {
            // --- Match Chat ---
            const matchDoc = await db.collection('Matches').doc(msg.matchId).get();
            if (!matchDoc.exists) return;
            const matchData = matchDoc.data();
            chatName = matchData.name || 'Match';
            const players = matchData.players || [];

            for (let pid of players) {
              if (pid === msg.senderId) continue;
              const pDoc = await db.collection('Users').doc(pid).get();
              if (pDoc.exists && pDoc.data().fcmToken) {
                tokens.push(pDoc.data().fcmToken);
              }
            }
          }

          // Send FCM
          if (tokens.length > 0) {
            const payload = {
              notification: {
                title: isDM ? senderName : `${chatName} - ${senderName}`,
                body: msg.text || 'Sent a message'
              },
              data: {
                matchId: msg.matchId,
                type: isDM ? 'dm_message' : 'chat_message'
              },
              tokens
            };

            const response = await admin.messaging().sendEachForMulticast(payload);
            console.log(`[FCM] Sent ${response.successCount}/${tokens.length} for ${isDM ? 'DM' : chatName}`);
          }
        } catch (err) {
          console.error('[FCM Error]', err.message);
        }
      }
    });
  });
}

// ==========================================
// ROUTES
// ==========================================

// 1. Root / Ping
app.get('/', (req, res) => {
  res.send({ status: 'Server is running', version: '2.1.6' });
});

// 2. Upload Image to imageBB
app.post('/upload-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }
    const apiKey = process.env.IMAGEBB_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'IMAGEBB_API_KEY not configured' });
    }

    const formData = new FormData();
    formData.append('image', req.file.buffer.toString('base64'));

    const response = await axios.post(`https://api.imgbb.com/1/upload?key=${apiKey}`, formData, {
      headers: formData.getHeaders(),
    });

    res.json({
      success: true,
      url: response.data.data.url,
      delete_url: response.data.data.delete_url
    });
  } catch (err) {
    console.error('Image upload failed', err.message);
    res.status(500).json({ error: 'Image upload failed' });
  }
});

// 3. Send Notification (FCM)
app.post('/send-notification', async (req, res) => {
  try {
    const { title, body, topic, token } = req.body;
    
    if (!admin.apps.length) return res.status(500).json({ error: 'Firebase Admin not initialized' });

    let message = {
      notification: { title, body }
    };

    if (topic) message.topic = topic;
    else if (token) message.token = token;
    else return res.status(400).json({ error: 'Topic or Token is required' });

    const response = await admin.messaging().send(message);
    res.json({ success: true, messageId: response });
  } catch (error) {
    console.error('Error sending notification', error);
    res.status(500).json({ error: 'Notification failed' });
  }
});

// 4. Mute User
app.post('/mute-user', async (req, res) => {
  try {
    const { userId, leaderId, matchId, durationMinutes } = req.body;
    if (!db) return res.status(500).json({ error: 'DB not available' });

    const matchDoc = await db.collection('Matches').doc(matchId).get();
    if (!matchDoc.exists || matchDoc.data().leaderId !== leaderId) {
      return res.status(403).json({ error: 'Unauthorized. You are not the leader of this match.' });
    }

    const until = new Date();
    until.setMinutes(until.getMinutes() + (durationMinutes || 5)); 

    await db.collection('Users').doc(userId).update({
      mutedUntil: admin.firestore.Timestamp.fromDate(until)
    });

    res.json({ success: true, message: `User muted until ${until}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Broadcast Notification to ALL users (Admin only)
app.post('/api/broadcast', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not available' });
    const { title, message } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'title and message required' });

    const usersSnap = await db.collection('Users').get();
    const tokens = [];
    usersSnap.forEach(doc => {
      const data = doc.data();
      if (data.fcmToken) tokens.push(data.fcmToken);
    });

    if (tokens.length === 0) return res.json({ success: true, sent: 0 });

    const payload = {
      notification: { title, body: message },
      data: { type: 'global_broadcast' },
      tokens
    };

    const response = await admin.messaging().sendEachForMulticast(payload);
    console.log(`[Broadcast] Sent ${response.successCount}/${tokens.length} notifications`);
    res.json({ success: true, sent: response.successCount, total: tokens.length });
  } catch (err) {
    console.error('Broadcast error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
