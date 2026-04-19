const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

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
// SMART IN-MEMORY CACHE (LRU) FOR RAPID MESSAGING
// Automatically clears after 15 seconds. Drops DB reads to ~0 during fast texting.
// ==========================================
const CacheStore = new Map();
const CACHE_TTL = 15000;

async function getCachedUser(uid) {
  if (!uid) return null;
  const key = `User_${uid}`;
  const now = Date.now();
  if (CacheStore.has(key)) {
    const entry = CacheStore.get(key);
    if (now - entry.time < CACHE_TTL) return entry.data;
  }
  
  if (db) {
    const doc = await db.collection('Users').doc(uid).get();
    if (doc.exists) {
      CacheStore.set(key, { data: doc.data(), time: now });
      return doc.data();
    }
  }
  return null;
}

// Fetch multiple users smartly using Cache + diff fallback
async function getCachedUsersBatch(userIds) {
  const result = {};
  const missingIds = [];
  const now = Date.now();
  
  userIds.forEach(id => {
    const key = `User_${id}`;
    if (CacheStore.has(key) && (now - CacheStore.get(key).time < CACHE_TTL)) {
      result[id] = CacheStore.get(key).data;
    } else {
      missingIds.push(id);
    }
  });

  if (missingIds.length > 0 && db) {
    // Process missing ones in chunks of 100 for db.getAll limit
    for (let i = 0; i < missingIds.length; i += 100) {
      const chunk = missingIds.slice(i, i + 100);
      const refs = chunk.map(id => db.collection('Users').doc(id));
      const docs = await db.getAll(...refs);
      docs.forEach(doc => {
        if (doc.exists) {
          result[doc.id] = doc.data();
          CacheStore.set(`User_${doc.id}`, { data: doc.data(), time: now });
        }
      });
    }
  }
  return result;
}

async function getCachedDoc(collection, docId) {
  const key = `${collection}_${docId}`;
  const now = Date.now();
  if (CacheStore.has(key)) {
    const entry = CacheStore.get(key);
    if (now - entry.time < CACHE_TTL) return entry.data;
  }
  
  if (db) {
    const doc = await db.collection(collection).doc(docId).get();
    if (doc.exists) {
      CacheStore.set(key, { data: doc.data(), time: now });
      return doc.data();
    }
  }
  return null;
}

// ==========================================
// HELPER: Save notification to Firestore
// ==========================================
async function saveNotification({ userId, title, body, type, targetId, senderName, senderAvatar }) {
  if (!db) return null;
  try {
    const notifRef = await db.collection('Notifications').add({
      userId: userId || 'all',
      title,
      body,
      type: type || 'general',
      targetId: targetId || '',
      senderName: senderName || '',
      senderAvatar: senderAvatar || '',
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
// HELPER: Send FCM (DATA-ONLY) and save notifications
// Optimized: FCM is sent FIRST, Firestore saves run in parallel AFTER
// ==========================================
async function sendFCMAndSave({ tokens, userIds, title, body, data, type, targetId, senderName, senderAvatar }) {
  const uniqueTokens = [...new Set(tokens || [])];
  const uniqueUserIds = [...new Set(userIds || [])];

  if (uniqueTokens.length === 0) {
    console.log('⚠️ No tokens to send to');
    return { sent: 0, saved: 0 };
  }

  let sent = 0;

  // ========== STEP 1: Send FCM IMMEDIATELY (highest priority) ==========
  try {
    const payload = {
      notification: {
        title: title || '',
        body: body || ''
      },
      data: {
        ...(data || {}),
        title: title || '',
        body: body || '',
        senderName: senderName || '',
        senderAvatar: senderAvatar || '',
        type: type || 'general',
        targetId: targetId || '',
        timestamp: Date.now().toString()
      },
      android: {
        priority: 'high',
        ttl: 0,
        notification: {
          sound: 'default'
        }
      },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: {
          aps: {
            contentAvailable: true,
            sound: 'default',
            alert: { title, body }
          }
        }
      },
      tokens: uniqueTokens
    };
    const response = await admin.messaging().sendEachForMulticast(payload);
    sent = response.successCount;
    console.log(`📲 FCM sent: ${sent}/${uniqueTokens.length} successful`);

    // Log failures and clean up invalid tokens
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        console.error(`  ❌ Token[${idx}] failed:`, resp.error?.message);
        // Auto-cleanup invalid tokens
        const errCode = resp.error?.code;
        if (errCode === 'messaging/invalid-registration-token' ||
            errCode === 'messaging/registration-token-not-registered') {
          console.log(`  🧹 Removing invalid token for user index ${idx}`);
          if (uniqueUserIds[idx] && db) {
            db.collection('Users').doc(uniqueUserIds[idx]).update({
              fcmToken: admin.firestore.FieldValue.delete()
            }).catch(() => {});
          }
        }
      }
    });
  } catch (err) {
    console.error('❌ FCM send error:', err.message);
  }

  // ========== STEP 2: Save to Firestore via Batched Writes (High Speed) ==========
  let saved = 0;
  if (db && uniqueUserIds && uniqueUserIds.length > 0) {
    try {
      for (let i = 0; i < uniqueUserIds.length; i += 400) {
        const batchIds = uniqueUserIds.slice(i, i + 400);
        const batch = db.batch();
        batchIds.forEach(uid => {
          const docRef = db.collection('Notifications').doc();
          batch.set(docRef, {
            userId: uid,
            title,
            body,
            type: type || 'general',
            targetId: targetId || '',
            senderName: senderName || '',
            senderAvatar: senderAvatar || '',
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        });
        await batch.commit();
        saved += batchIds.length;
      }
      console.log(`📝 Batched saving: ${saved} notifications`);
    } catch (err) {
      console.error('❌ Batch save error:', err.message);
    }
  }

  return { sent, saved };
}

// ==========================================
// API ROUTES
// ==========================================

// Health check + warm-up endpoint (prevents Vercel cold start)
app.get('/', (req, res) => res.json({ status: 'Server is running', version: '6.1.0', ts: Date.now() }));
app.get('/api', (req, res) => res.json({ status: 'Server is running', version: '6.1.0', ts: Date.now() }));

// Dedicated warm-up endpoint (called on app launch to prevent cold start delay)
app.get('/api/warm', (req, res) => {
  res.json({ warm: true, ts: Date.now() });
});

// ==========================================
// 1. Notify Message - Chat, DM & Group notifications
// ==========================================
app.post('/api/notify-message', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not available' });
    const { matchId, senderId, text } = req.body;
    if (!matchId || !senderId) return res.status(400).json({ error: 'matchId and senderId required' });

    console.log(`\n📨 Notify message: matchId=${matchId}, senderId=${senderId}`);

    // Get sender name & avatar via Cache
    const senderData = await getCachedUser(senderId);
    const senderName = senderData ? senderData.name : 'User';
    const senderAvatar = senderData ? (senderData.avatarUrl || '') : '';

    const isDM = matchId.startsWith('dm_');
    const isGroup = matchId.startsWith('group_');
    const tokens = [];
    const userIds = [];
    let chatName = '';

    if (isDM) {
      // DM: get the other user's token
      const parts = matchId.replace('dm_', '').split('_');
      const otherUid = parts.find(p => p !== senderId);
      if (otherUid) {
        const otherData = await getCachedUser(otherUid);
        if (otherData && otherData.fcmToken) {
          tokens.push(otherData.fcmToken);
          userIds.push(otherUid);
        }
      }
      chatName = senderName;
    } else if (isGroup) {
      // Group Chat: get all members' tokens via Batch Cache
      const groupId = matchId.replace('group_', '');
      const groupData = await getCachedDoc('Groups', groupId);
      if (!groupData) return res.json({ success: true, sent: 0, reason: 'Group not found' });
      chatName = groupData.name || 'Group';

      const memberIds = (groupData.members || []).filter(id => id !== senderId);
      if (memberIds.length > 0) {
        const usersData = await getCachedUsersBatch(memberIds);
        Object.keys(usersData).forEach(uid => {
          if (usersData[uid].fcmToken) {
            tokens.push(usersData[uid].fcmToken);
            userIds.push(uid);
          }
        });
      }
    } else {
      // Match Chat: get all players' tokens via Batch Cache
      const matchData = await getCachedDoc('Matches', matchId);
      if (!matchData) return res.json({ success: true, sent: 0, reason: 'Match not found' });
      chatName = matchData.name || 'Match';

      const pIds = (matchData.players || []).filter(id => id !== senderId);
      if (pIds.length > 0) {
        const usersData = await getCachedUsersBatch(pIds);
        Object.keys(usersData).forEach(uid => {
          if (usersData[uid].fcmToken) {
            tokens.push(usersData[uid].fcmToken);
            userIds.push(uid);
          }
        });
      }
    }

    const title = isDM ? senderName : `${chatName}`;
    const body = isDM ? (text || 'Sent a message') : `${senderName}: ${text || 'Sent a message'}`;
    const msgType = isDM ? 'dm_message' : (isGroup ? 'group_message' : 'chat_message');

    const result = await sendFCMAndSave({
      tokens,
      userIds,
      title,
      body,
      data: { matchId, type: msgType, chatName },
      type: msgType,
      targetId: matchId,
      senderName,
      senderAvatar
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

    // Get joiner name & avatar
    const userDoc = await db.collection('Users').doc(userId).get();
    const userName = userDoc.exists ? userDoc.data().name : 'Player';
    const userAvatar = userDoc.exists ? (userDoc.data().avatarUrl || '') : '';

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
      senderName: userName,
      senderAvatar: userAvatar
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

    // Send FCM data-only
    let sent = 0;
    try {
      const response = await admin.messaging().sendEachForMulticast({
        data: {
          title,
          body: message,
          type: 'global_broadcast',
          senderName: 'Admin',
          senderAvatar: '',
          timestamp: Date.now().toString()
        },
        android: {
          priority: 'high',
          ttl: 0,
        },
        apns: {
          headers: { 'apns-priority': '10' },
          payload: { aps: { contentAvailable: true, sound: 'default', alert: { title, body: message } } }
        },
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
// 4. Call Invite - Ring the user's phone via Notification Push
// ==========================================
app.post('/api/call-invite', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not available' });
    const { matchId, callerId, type } = req.body;
    if (!matchId || !callerId) return res.status(400).json({ error: 'matchId and callerId required' });

    console.log(`\n📞 Call invite: matchId=${matchId}, callerId=${callerId}`);

    const callerData = await getCachedUser(callerId);
    const callerName = callerData ? callerData.name : 'User';
    const callerAvatar = callerData ? (callerData.avatarUrl || '') : '';

    const isDM = matchId.startsWith('dm_');
    const isGroup = matchId.startsWith('group_');
    const tokens = [];
    const userIds = [];
    
    // Fetch target user(s) tokens via Bulk Cache
    if (isDM) {
      const parts = matchId.replace('dm_', '').split('_');
      const otherUid = parts.find(p => p !== callerId);
      if (otherUid) {
        const otherData = await getCachedUser(otherUid);
        if (otherData && otherData.fcmToken) {
          tokens.push(otherData.fcmToken);
          userIds.push(otherUid);
        }
      }
    } else if (isGroup) {
      const groupData = await getCachedDoc('Groups', matchId.replace('group_', ''));
      if (groupData) {
        const memberIds = (groupData.members || []).filter(id => id !== callerId);
        if (memberIds.length > 0) {
          const usersData = await getCachedUsersBatch(memberIds);
          Object.keys(usersData).forEach(uid => {
            if (usersData[uid].fcmToken) { tokens.push(usersData[uid].fcmToken); userIds.push(uid); }
          });
        }
      }
    } else {
      const matchData = await getCachedDoc('Matches', matchId);
      if (matchData) {
        const pIds = (matchData.players || []).filter(id => id !== callerId);
        if (pIds.length > 0) {
          const usersData = await getCachedUsersBatch(pIds);
          Object.keys(usersData).forEach(uid => {
            if (usersData[uid].fcmToken) { tokens.push(usersData[uid].fcmToken); userIds.push(uid); }
          });
        }
      }
    }

    if (tokens.length === 0) return res.json({ success: true, sent: 0, reason: 'No tokens found' });

    const title = `📞 مكالمة واردة من ${callerName}`;
    const body = `اضغط للرد على المكالمة والانضمام`;

    // CRITICAL: Send DATA-ONLY FCM (no "notification" key!)
    // If "notification" key is present, Android handles it via system tray
    // and onMessageReceived is NEVER called when app is killed/background.
    // With data-only, onMessageReceived is ALWAYS called → IncomingCallActivity launches.
    const response = await admin.messaging().sendEachForMulticast({
      data: {
        title,
        body,
        matchId,
        type: 'call_invite',
        callType: type || 'video_call',
        senderName: callerName,
        senderAvatar: callerAvatar,
        timestamp: Date.now().toString()
      },
      android: {
        priority: 'high',
        ttl: 0,
      },
      apns: {
         headers: { 'apns-priority': '10' },
         payload: { aps: { contentAvailable: true, sound: 'default', category: 'CALL_INVITE' } }
      },
      tokens
    });

    res.json({ success: true, sent: response.successCount });
  } catch (err) {
    console.error('[Call Invite Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4b. Send Call Cancel (Silent Notification)
// ==========================================
app.post('/api/call-cancel', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not available' });
    const { matchId, senderId } = req.body;
    if (!matchId || !senderId) return res.status(400).json({ error: 'matchId and senderId required' });

    let userIds = [];
    if (matchId.startsWith('dm_')) {
      const parts = matchId.replace('dm_', '').split('_');
      userIds = parts.filter(id => id !== senderId);
    } else if (matchId.startsWith('group_')) {
      const groupId = matchId.replace('group_', '');
      const groupData = await getCachedDoc('Groups', groupId);
      if (groupData?.members?.length) {
        userIds = groupData.members.filter(id => id !== senderId);
      }
    } else {
      const matchDoc = await getCachedDoc('Matches', matchId);
      if (matchDoc?.players) {
        userIds = matchDoc.players.filter(id => id !== senderId);
      }
    }

    if (userIds.length === 0) return res.json({ success: true, sent: 0, msg: 'No users to notify' });

    const tokens = await getUsersTokens(userIds);
    if (tokens.length === 0) return res.json({ success: true, sent: 0, msg: 'No online users' });

    console.log(`🔇 Sending call_cancel to ${tokens.length} devices for match ${matchId}`);

    const response = await admin.messaging().sendEachForMulticast({
      data: {
        type: 'call_cancel',
        matchId: matchId,
        timestamp: Date.now().toString()
      },
      android: {
        priority: 'high',
        ttl: 0,
      },
      apns: {
         headers: { 'apns-priority': '10' },
         payload: { aps: { contentAvailable: true } }
      },
      tokens
    });

    res.json({ success: true, sent: response.successCount });
  } catch (err) {
    console.error('[Call Cancel Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// API Reply Message was removed since native inline reply has been disabled in Android notification

// ==========================================
// 5. Mark notification as read
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
// 6. Mark all notifications as read for user
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
// 7. Send single notification (test)
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
// 8. Upload Image (JSON Base64 Mode)
// ==========================================
app.post('/upload-image', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'No image provided' });
    const apiKey = process.env.IMAGEBB_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'IMAGEBB_API_KEY missing' });

    // Clean base64 string (remove data:image/png;base64, prefix if exists)
    const base64Data = image.replace(/^data:image\/\w+;base64,/, "");

    // Use URLSearchParams instead of form-data package (works natively in Node 18+)
    const params = new URLSearchParams();
    params.append('image', base64Data);

    const response = await axios.post(`https://api.imgbb.com/1/upload?key=${apiKey}`, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    console.log(`📸 Image uploaded via ImgBB:`, response.data.data.url);
    res.json({ success: true, url: response.data.data.url });
  } catch (err) {
    console.error('❌ Upload failed:', err.response?.data || err.message);
    res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

// ==========================================
// 9. Mute user
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
// 10. Extract MediaFire Direct Link
// ==========================================
app.post('/api/mediafire-direct', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !url.includes('mediafire.com')) {
      return res.status(400).json({ error: 'Invalid MediaFire URL format' });
    }

    console.log(`\n🔗 Extracting direct link from: ${url}`);
    
    // Fetch the HTML from MediaFire
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36'
      }
    });
    
    const html = response.data;
    
    // Try to find the download button URL (usually id="downloadButton")
    const regexps = [
      /id="downloadButton" href="([^"]+)"/i,
      /class="input pov" href="([^"]+)"/i,
      /href="([^"]+)"\n\s*id="downloadButton"/i
    ];

    let directUrl = null;
    for (const regex of regexps) {
      const match = html.match(regex);
      if (match && match[1]) {
        directUrl = match[1];
        break;
      }
    }

    if (!directUrl) {
       // Look for general download structure if the above fails
       const fallbackMatch = html.match(/"([^"]+\.mediafire\.com\/download\/[^"]+)"/);
       if (fallbackMatch && fallbackMatch[1]) directUrl = fallbackMatch[1];
    }

    if (directUrl) {
      console.log('✅ Direct URL found');
      return res.json({ success: true, url: directUrl.replace(/&amp;/g, '&') });
    } else {
      console.error('❌ Could not find direct URL in HTML');
      return res.status(404).json({ error: 'Direct link not found' });
    }
    
  } catch (err) {
    console.error('[MediaFire Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 11. Debug: Check server health
// ==========================================
app.get('/api/health', async (req, res) => {
  const health = {
    server: 'running',
    version: '5.0.0',
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
