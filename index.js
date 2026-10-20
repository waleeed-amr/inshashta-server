const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const ImageKit = require('imagekit');
const crypto = require('crypto');
require('dotenv').config();

// ==========================================
// 🚀 QUANTUM LEAP: Enable HTTP Keep-Alive for Firebase
// This keeps the connection open with Google servers, making FCM requests up to 50% faster.
// ==========================================
process.env.FIREBASE_HTTP_KEEPALIVE = 'true';

let imagekit = null;
try {
  imagekit = new ImageKit({
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY || "public_HdSnCP/v/OzMEMISVsztsoZGqi0=",
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY || "private_pSOlbb0+klfxxnft/DlTZ84eWZo=",
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || "https://ik.imagekit.io/LEDO"
  });
  console.log('✅ ImageKit initialized.');
} catch (e) {
  console.error('❌ ImageKit init failed:', e.message);
}
const app = express();
app.use(cors());
// Base64 profile photos use this JSON route too, so preserve its 10 MB payload
// ceiling while bounding the in-memory IP limiter separately below.
app.use(express.json({ limit: '10mb' }));

// ==========================================
// 🛡️ SECURITY HEADERS (HELMET-LITE)
// ==========================================
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ==========================================
// 🚦 ADVANCED RATE LIMITER (MEMORY-BASED)
// ==========================================
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS = 150; // max requests per minute
const MAX_RATE_LIMIT_KEYS = 20000;

app.use('/api', (req, res, next) => {
  // Allow health/warm requests unconditionally
  if (req.path === '/warm' || req.path === '/health' || req.method === 'GET') return next();
  
  // Express only trusts forwarded addresses when trust proxy is configured.
  // Bound the key length and map size so spoofed headers cannot grow memory forever.
  const ip = String(req.ip || req.socket.remoteAddress || 'unknown').slice(0, 64);
  const now = Date.now();
  
  if (!rateLimitMap.has(ip)) {
    if (rateLimitMap.size >= MAX_RATE_LIMIT_KEYS) {
      const oldestKey = rateLimitMap.keys().next().value;
      if (oldestKey !== undefined) rateLimitMap.delete(oldestKey);
    }
    rateLimitMap.set(ip, { count: 1, startTime: now });
  } else {
    const data = rateLimitMap.get(ip);
    if (now - data.startTime > RATE_LIMIT_WINDOW) {
      // Reset window
      data.count = 1;
      data.startTime = now;
    } else {
      data.count++;
      if (data.count > MAX_REQUESTS) {
        return res.status(429).json({ error: 'Too many requests, slow down.' });
      }
    }
  }
  next();
});

// Clean up expired IPs from rateLimitMap every 5 minutes
const rateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimitMap.entries()) {
    if (now - data.startTime > RATE_LIMIT_WINDOW) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000);
// Housekeeping must not keep serverless runtimes alive after the response ends.
rateLimitCleanup.unref?.();

// ==========================================
// 🛡️ ASYNC HANDLER (Try-Catch Wrapper)
// ==========================================
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB limit to prevent memory issues
});

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

// Garbage collection to clean up expired cache items and prevent memory leaks
const cacheCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of CacheStore.entries()) {
    if (now - value.time > CACHE_TTL) {
      CacheStore.delete(key);
    }
  }
}, 60000); // Run every 60 seconds
cacheCleanup.unref?.();

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
// HELPER: Send FCM and save notifications (MASSIVE PERFORMANCE OVERHAUL)
// Fully Non-Blocking: Both FCM and Firestore saving happen asynchronously.
// ==========================================
async function sendFCMAndSave({ tokens, userIds, title, body, data, type, targetId, senderName, senderAvatar, saveToInbox = true }) {
  const uniqueTokens = [...new Set(tokens || [])];
  const uniqueUserIds = [...new Set(userIds || [])];

  if (uniqueTokens.length === 0) {
    console.log('⚠️ No tokens to send to');
    return { sent: 0, failed: 0, saved: 0, timedOut: false, errors: [] };
  }

  const fcmPromise = (async () => {
    const CHUNK_SIZE = 500;
    const chunks = [];
    for (let i = 0; i < uniqueTokens.length; i += CHUNK_SIZE) chunks.push(uniqueTokens.slice(i, i + CHUNK_SIZE));
    const invalidUserIds = new Set();
    const errors = [];
    let totalSent = 0;
    let totalFailed = 0;
    const sends = chunks.map(async (tokenChunk, chunkIndex) => {
      const threadId = targetId || 'inshashta_general';
      const isIncomingCall = type === 'INCOMING_CALL';
      const rawData = {
        ...(data || {}), title: title || '', body: body || '', senderName: senderName || '',
        senderAvatar: senderAvatar || '', type: type || 'general', targetId: targetId || '',
        timestamp: Date.now().toString(), channelId: isIncomingCall ? 'in_shashta_calls_v4' : 'in_shashta_messages_v2',
      };
      const stringifiedData = Object.fromEntries(Object.entries(rawData)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [key, String(value)]));
      const payload = {
        data: stringifiedData,
        android: {
          priority: 'high',
          ttl: isIncomingCall ? 45_000 : 86_400_000,
          ...(isIncomingCall ? { collapseKey: 'in_shashta_incoming_call' } : {}),
        },
        apns: {
          headers: {
            'apns-priority': '10',
            'apns-collapse-id': (isIncomingCall ? 'inshashta-incoming-call' : threadId).slice(0, 64),
            ...(isIncomingCall ? { 'apns-expiration': String(Math.floor(Date.now() / 1000) + 45) } : {}),
          },
          payload: { aps: { contentAvailable: true, sound: 'default', 'thread-id': threadId, alert: { title, body } } },
        },
        tokens: tokenChunk,
      };
      const response = await admin.messaging().sendEachForMulticast(payload);
      totalSent += response.successCount;
      totalFailed += response.failureCount;
      response.responses.forEach((item, idx) => {
        if (item.success) return;
        const code = item.error?.code || 'messaging/unknown-error';
        if (!errors.includes(code) && errors.length < 8) errors.push(code);
        if (code === 'messaging/invalid-registration-token' || code === 'messaging/registration-token-not-registered') {
          const userId = uniqueUserIds[chunkIndex * CHUNK_SIZE + idx];
          if (userId) invalidUserIds.add(userId);
        }
      });
    });
    const results = await Promise.allSettled(sends);
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        totalFailed += chunks[index].length;
        const code = result.reason?.code || 'messaging/request-failed';
        if (!errors.includes(code) && errors.length < 8) errors.push(code);
      }
    });
    if (invalidUserIds.size && db) {
      for (const uid of invalidUserIds) {
        try { await db.collection('Users').doc(uid).update({ fcmToken: admin.firestore.FieldValue.delete() }); }
        catch (error) { console.warn('[FCM] Could not remove invalid token for user:', uid, error.code || error.message); }
      }
    }
    console.log(`[FCM] ${type || 'general'} delivered ${totalSent}/${uniqueTokens.length}; failed=${totalFailed}`);
    return { sent: totalSent, failed: totalFailed, errors };
  })().catch((error) => {
    console.error('[FCM] Sending failed:', error.code || error.message);
    return { sent: 0, failed: uniqueTokens.length, errors: [error.code || 'messaging/request-failed'] };
  });

  const dbPromise = (async () => {
    // Call signaling is already stored in WebRTCCalls. Duplicating every ring
    // into Notifications caused stale call entries and extra Firestore writes.
    if (!saveToInbox) return { saved: 0, error: null };
    if (!db || uniqueUserIds.length === 0) return { saved: 0, error: db ? null : 'firestore-unavailable' };
    let saved = 0;
    try {
      for (let i = 0; i < uniqueUserIds.length; i += 400) {
        const batchIds = uniqueUserIds.slice(i, i + 400);
        const batch = db.batch();
        batchIds.forEach(uid => batch.set(db.collection('Notifications').doc(), {
          userId: uid, title, body, type: type || 'general', targetId: targetId || '',
          senderName: senderName || '', senderAvatar: senderAvatar || '', read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }));
        await batch.commit();
        saved += batchIds.length;
      }
      return { saved, error: null };
    } catch (error) {
      console.error('[Notification DB] Save failed:', error.code || error.message);
      return { saved, error: error.code || 'firestore-write-failed' };
    }
  })();

  let timeoutId;
  const tasks = Promise.all([fcmPromise, dbPromise]);
  const result = await Promise.race([
    tasks,
    new Promise((resolve) => { timeoutId = setTimeout(() => resolve(null), 8_000); }),
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  if (!result) return { sent: 0, failed: uniqueTokens.length, saved: 0, timedOut: true, errors: ['delivery-timeout'] };
  return { ...result[0], ...result[1], timedOut: false };
}

// ==========================================
// API ROUTES
// ==========================================

// Health check + warm-up endpoint (prevents Vercel cold start)
app.get('/', (req, res) => res.json({ status: 'Server is running', version: '9.5.0', ts: Date.now() }));
app.get('/api', (req, res) => res.json({ status: 'Server is running', version: '9.5.0', ts: Date.now() }));

// Dedicated warm-up endpoint (called on app launch to prevent cold start delay)
app.get('/api/warm', (req, res) => {
  res.json({ warm: true, ts: Date.now() });
});

// ==========================================
// Cloudinary Authentication Endpoint (Signed Uploads)
// ==========================================
app.get('/api/cloudinary-sign', (req, res) => {
  try {
    const timestamp = Math.round((new Date).getTime() / 1000);
    const apiSecret = "7bmJ3dti_Hn_Byuf38Awgjk9D5c";
    const apiKey = "566119222639312";
    const cloudName = "dd07kmewo";
    
    // Cloudinary signature requires params to be alphabetically sorted
    const signature = crypto.createHash('sha1').update(`timestamp=${timestamp}${apiSecret}`).digest('hex');
    
    res.json({
      signature,
      timestamp,
      apiKey,
      cloudName
    });
  } catch (error) {
    console.error('Cloudinary auth error:', error);
    res.status(500).json({ error: 'Failed to generate auth parameters' });
  }
});

// ==========================================
// ImageKit.io Authentication Endpoint
// ==========================================
app.get('/api/imagekit-auth', (req, res) => {
  try {
    if (!imagekit) {
      return res.status(500).json({ error: 'ImageKit is not configured. Missing environment variables.' });
    }
    const result = imagekit.getAuthenticationParameters();
    res.json(result);
  } catch (error) {
    console.error('ImageKit auth error:', error);
    res.status(500).json({ error: 'Failed to generate auth parameters' });
  }
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

    const isDM = matchId.startsWith('dm_');
    const isGroup = matchId.startsWith('group_');
    const directRecipientId = isDM
      ? matchId.replace('dm_', '').split('_').find((id) => id !== senderId)
      : null;

    // The sender profile and the DM recipient token are independent reads.
    // Fetch them together so a cold Firestore cache doesn't add two network
    // round trips to every first message in a conversation.
    const [senderData, directRecipientData] = await Promise.all([
      getCachedUser(senderId),
      directRecipientId ? getCachedUser(directRecipientId) : Promise.resolve(null),
    ]);
    let senderName = senderData ? senderData.name : 'User';
    const isSenderVerified = senderData && (senderData.isVerified === true || (Array.isArray(senderData.badges) && senderData.badges.includes('verified')));
    
    // Add verification badge directly to the sender name so it appears perfectly in Android/iOS push notifications
    if (isSenderVerified) {
      senderName = senderName + ' ✅';
    }
    
    const senderAvatar = senderData ? (senderData.avatarUrl || '') : '';

    const tokens = [];
    const userIds = [];
    let chatName = '';

    if (isDM) {
      // DM: get the other user's token
      const otherUid = directRecipientId;
      if (otherUid) {
        const otherData = directRecipientData;
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
      data: { matchId, type: msgType, chatName, senderName, senderAvatar, senderIsVerified: isSenderVerified ? 'true' : 'false' },
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

    // Get joiner name & avatar using Cache
    const userData = await getCachedUser(userId);
    const userName = userData ? userData.name : 'Player';
    const userAvatar = userData ? (userData.avatarUrl || '') : '';

    // Get match info using Cache
    const matchData = await getCachedDoc('Matches', matchId);
    if (!matchData) return res.json({ success: true, sent: 0, reason: 'Match not found' });
    const matchName = matchData.name || 'Match';
    const leaderId = matchData.leaderId;

    // Notify the leader
    const tokens = [];
    const userIds = [];

    if (leaderId && leaderId !== userId) {
      const leaderData = await getCachedUser(leaderId);
      if (leaderData && leaderData.fcmToken) {
        tokens.push(leaderData.fcmToken);
        userIds.push(leaderId);
      }
    }

    const title = `⚽ ${matchName}`;
    const body = `${userName} joined the match! (${(matchData.players || []).length}/${matchData.maxPlayers || 14})`;

    const result = await sendFCMAndSave({
      tokens,
      userIds,
      title: 'تفاعل جديد',
      body: body,
      data: { matchId, type: 'chat_reaction', senderName: userName, senderAvatar: userAvatar, senderIsVerified: 'false' },
      type: 'chat_reaction',
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
    // Verify admin key
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== (process.env.ADMIN_KEY || 'inshashta2026')) {
      return res.status(403).json({ error: 'Unauthorized - Admin access required' });
    }

    if (!db) return res.status(500).json({ error: 'DB not available' });
    const { title, message } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'title and message required' });

    console.log(`\n📢 Broadcast: "${title}" - "${message}"`);

    // Fetch all users with tokens and use the highly optimized sendFCMAndSave
    const usersSnap = await db.collection('Users').select('fcmToken').get();
    const tokens = [];
    const userIds = [];
    usersSnap.forEach(doc => {
      const fcmToken = doc.data().fcmToken;
      if (fcmToken) {
        tokens.push(fcmToken);
        userIds.push(doc.id);
      }
    });

    console.log(`📢 Broadcasting to ${tokens.length} tokens...`);

    if (tokens.length > 0) {
      // Await the main wrapper (the FCM sending and saving will happen in parallel background)
      const result = await sendFCMAndSave({
        tokens,
        userIds,
        title,
        body: message,
        data: { type: 'global_broadcast', title, body: message },
        type: 'global_broadcast',
        targetId: 'all',
        senderName: 'Admin',
        senderAvatar: ''
      });
      console.log(`📢 Broadcast initiated for ${result.sent} devices.`);
    }

    // Return immediately without waiting for the large stream/FCM
    res.json({ success: true, message: 'Broadcast started in background' });
  } catch (err) {
    console.error('[Broadcast Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3a-2. Notify Admin of Badge Request
// ==========================================
app.post('/api/notify-badge-request', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not available' });
    const { userName, userId } = req.body;
    if (!userName) return res.status(400).json({ error: 'userName required' });

    console.log(`\n🏅 Badge Request Notification: from ${userName} (${userId})`);

    // Find admin user by email
    const adminSnap = await db.collection('Users')
      .where('email', '==', '01022763613@inshashta.app')
      .limit(1)
      .get();

    if (adminSnap.empty) {
      return res.json({ success: true, sent: 0, reason: 'Admin not found' });
    }

    const adminDoc = adminSnap.docs[0];
    const adminData = adminDoc.data();
    const adminId = adminDoc.id;

    if (!adminData.fcmToken) {
      return res.json({ success: true, sent: 0, reason: 'Admin has no token' });
    }

    const title = '🏅 طلب توثيق جديد';
    const body = `يوجد طلب توثيق حساب جديد من ${userName}`;

    const result = await sendFCMAndSave({
      tokens: [adminData.fcmToken],
      userIds: [adminId],
      title,
      body,
      data: { type: 'badge_request' },
      type: 'badge_request',
      targetId: userId || '',
      senderName: userName,
      senderAvatar: ''
    });

    res.json({ success: true, sent: result.sent });
  } catch (err) {
    console.error('[Badge Request Notify Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3b. Notify Status Reaction
// ==========================================
app.post('/api/notify-status-reaction', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not available' });
    const { targetUserId, senderId, emoji } = req.body;
    if (!targetUserId || !senderId || !emoji) {
      return res.status(400).json({ error: 'targetUserId, senderId and emoji required' });
    }

    console.log(`\n💖 Notify Status Reaction: target=${targetUserId}, sender=${senderId}, emoji=${emoji}`);

    const senderData = await getCachedUser(senderId);
    const senderName = senderData ? senderData.name : 'مستخدم';
    
    const targetData = await getCachedUser(targetUserId);
    if (!targetData || !targetData.fcmToken) return res.json({ success: true, sent: 0, reason: 'No token' });

    const title = 'تفاعل جديد على حالتك';
    const body = `لقد تفاعل ${senderName} مع حالتك بـ ${emoji}`;

    const result = await sendFCMAndSave({
      tokens: [targetData.fcmToken],
      userIds: [targetUserId],
      title,
      body,
      data: { type: 'status_reaction' },
      type: 'status_reaction',
      targetId: senderId,
      senderName,
      senderAvatar: senderData?.avatarUrl || ''
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Notify Status Reaction Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3c. Notify Chat Reaction
// ==========================================
app.post('/api/notify-chat-reaction', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not available' });
    const { matchId, targetUserId, senderId, emoji } = req.body;
    if (!matchId || !targetUserId || !senderId || !emoji) {
      return res.status(400).json({ error: 'matchId, targetUserId, senderId and emoji required' });
    }

    // Don't notify if reacting to own message
    if (targetUserId === senderId) return res.json({ success: true, sent: 0, reason: 'Own message' });

    console.log(`\n💖 Notify Chat Reaction: matchId=${matchId}, target=${targetUserId}, sender=${senderId}, emoji=${emoji}`);

    const senderData = await getCachedUser(senderId);
    const senderName = senderData ? senderData.name : 'مستخدم';
    
    const targetData = await getCachedUser(targetUserId);
    if (!targetData || !targetData.fcmToken) return res.json({ success: true, sent: 0, reason: 'No token' });

    const isDM = matchId.startsWith('dm_');
    const isGroup = matchId.startsWith('group_');
    let chatName = '';
    
    if (isGroup) {
      const groupData = await getCachedDoc('Groups', matchId.replace('group_', ''));
      chatName = groupData?.name || 'مجموعة';
    } else if (!isDM) {
      const matchData = await getCachedDoc('Matches', matchId);
      chatName = matchData?.name || 'مباراة';
    }

    const title = isDM ? 'تفاعل جديد' : chatName;
    const body = `لقد تفاعل ${senderName} مع رسالتك بـ ${emoji}`;

    const msgType = isDM ? 'dm_message' : (isGroup ? 'group_message' : 'chat_message');

    const result = await sendFCMAndSave({
      tokens: [targetData.fcmToken],
      userIds: [targetUserId],
      title,
      body,
      data: { matchId, type: msgType, chatName },
      type: msgType,
      targetId: matchId,
      senderName,
      senderAvatar: senderData?.avatarUrl || ''
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Notify Chat Reaction Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3b. Reply Message - Inline reply from notification
// ==========================================
app.post('/api/reply-message', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not available' });
    const { matchId, senderId, text } = req.body;
    if (!matchId || !senderId || !text) {
      return res.status(400).json({ error: 'matchId, senderId and text required' });
    }

    console.log(`\n💬 Inline reply: matchId=${matchId}, senderId=${senderId}, text=${text}`);

    // 1. Save the message to Firestore
    await db.collection('Messages').add({
      matchId,
      senderId,
      text,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      readBy: [senderId]
    });

    // Get sender info via Cache
    const senderData = await getCachedUser(senderId);
    let senderName = senderData ? senderData.name : 'شخص';
    const isSenderVerified = senderData && (senderData.isVerified || (senderData.badges && senderData.badges.includes('verified')));
    const senderAvatar = senderData ? (senderData.avatarUrl || '') : '';

    // 3. Collect recipient tokens
    const isDM = matchId.startsWith('dm_');
    const isGroup = matchId.startsWith('group_');
    const tokens = [];
    const userIds = [];
    let chatName = '';

    if (isDM) {
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
      const groupId = matchId.replace('group_', '');
      const groupData = await getCachedDoc('Groups', groupId);
      chatName = groupData?.name || 'Group';
      const memberIds = (groupData?.members || []).filter(id => id !== senderId);
      if (memberIds.length > 0) {
        const usersData = await getCachedUsersBatch(memberIds);
        Object.keys(usersData).forEach(uid => {
          if (usersData[uid].fcmToken) { tokens.push(usersData[uid].fcmToken); userIds.push(uid); }
        });
      }
    } else {
      const matchData = await getCachedDoc('Matches', matchId);
      chatName = matchData?.name || 'Match';
      const pIds = (matchData?.players || []).filter(id => id !== senderId);
      if (pIds.length > 0) {
        const usersData = await getCachedUsersBatch(pIds);
        Object.keys(usersData).forEach(uid => {
          if (usersData[uid].fcmToken) { tokens.push(usersData[uid].fcmToken); userIds.push(uid); }
        });
      }
    }

    // 4. Send FCM notification to recipients
    const title = isDM ? senderName : chatName;
    const body = isDM ? text : `${senderName}: ${text}`;
    const msgType = isDM ? 'dm_message' : (isGroup ? 'group_message' : 'chat_message');

    if (tokens.length > 0) {
      const result = await sendFCMAndSave({
        tokens, userIds, title, body,
        data: { matchId, type: msgType, chatName },
        type: msgType, targetId: matchId,
        senderName, senderAvatar
      });
      console.log(`📲 Reply notification sent: ${result.sent} devices`);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Reply Message Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ==========================================
// WebRTC: Short-lived TURN credentials (Open Relay free tier)
// ==========================================
app.get('/api/webrtc/ice', async (req, res) => {
  res.set('Cache-Control', 'no-store, private');
  if (!db || !admin.apps.length) return res.status(503).json({ error: 'Authentication service is unavailable' });
  const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!bearer) return res.status(401).json({ error: 'Authentication required' });
  try {
    await admin.auth().verifyIdToken(bearer[1]);
  } catch {
    return res.status(401).json({ error: 'Invalid authentication token' });
  }

  const credentialsUrl = process.env.OPENRELAY_CREDENTIALS_URL;
  if (!credentialsUrl) return res.status(503).json({ error: 'TURN credentials are not configured' });
  let parsedCredentialsUrl;
  try { parsedCredentialsUrl = new URL(credentialsUrl); }
  catch { return res.status(503).json({ error: 'TURN credentials URL is invalid' }); }
  if (parsedCredentialsUrl.protocol !== 'https:' || !parsedCredentialsUrl.hostname.endsWith('.metered.live')) {
    return res.status(503).json({ error: 'TURN credentials URL must be an HTTPS Metered endpoint' });
  }

  try {
    const response = await fetch(parsedCredentialsUrl, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) return res.status(502).json({ error: 'TURN provider rejected the credentials request' });
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > 32 * 1024) return res.status(502).json({ error: 'TURN provider returned an oversized response' });
    const responseBody = await response.text();
    if (responseBody.length > 32 * 1024) return res.status(502).json({ error: 'TURN provider returned an oversized response' });

    let providerServers;
    try { providerServers = JSON.parse(responseBody); }
    catch { return res.status(502).json({ error: 'TURN provider returned invalid JSON' }); }
    if (!Array.isArray(providerServers) || providerServers.length > 20) {
      return res.status(502).json({ error: 'TURN provider returned an invalid ICE configuration' });
    }

    // Only forward well-formed ICE URLs. Do not silently accept a provider
    // response containing STUN only: it would look configured while calls
    // behind restrictive NATs still cannot use the relay.
    const iceServers = providerServers.filter((server) => {
      if (!server || typeof server !== 'object') return false;
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      if (!urls.length || urls.length > 12 || urls.some((url) => typeof url !== 'string' || url.length > 512 || !/^(stun|stuns|turn|turns):/i.test(url))) return false;
      const hasTurn = urls.some((url) => /^turns?:/i.test(url));
      return !hasTurn || (typeof server.username === 'string' && server.username.length > 0 && typeof server.credential === 'string' && server.credential.length > 0);
    });
    if (!iceServers.length || !iceServers.some((server) => (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => /^turns?:/i.test(url)))) {
      return res.status(502).json({ error: 'TURN provider returned no usable relay credentials' });
    }
    return res.json({ iceServers });
  } catch (error) {
    console.error('[WebRTC TURN Error]', error.name === 'TimeoutError' ? 'provider timeout' : 'provider request failed');
    return res.status(502).json({ error: 'TURN provider is temporarily unavailable' });
  }
});

// ==========================================
// WebRTC: Notify Incoming Call
// ==========================================
app.post('/api/notify-call', async (req, res) => {
  try {
    if (!db || !admin.apps.length) return res.status(503).json({ error: 'DB not available' });
    const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!bearer) return res.status(401).json({ error: 'Authentication required' });
    let authenticatedUser;
    try { authenticatedUser = await admin.auth().verifyIdToken(bearer[1]); }
    catch { return res.status(401).json({ error: 'Invalid authentication token' }); }
    const { callerId, calleeId, callId } = req.body || {};
    if (typeof callerId !== 'string' || callerId.length < 1 || callerId.length > 128 || callerId.includes('/')
      || typeof calleeId !== 'string' || calleeId.length < 1 || calleeId.length > 128 || calleeId.includes('/')
      || typeof callId !== 'string' || callId.length <= 5 || callId.length > 320 || !callId.startsWith('call_') || callId.includes('/')
      || callerId === calleeId) {
      return res.status(400).json({ error: 'callerId, calleeId, and callId required' });
    }
    if (authenticatedUser.uid !== callerId) return res.status(403).json({ error: 'Caller identity mismatch' });
    const callRef = db.collection('WebRTCCalls').doc(callId);
    const claimId = crypto.randomUUID();
    const claim = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(callRef);
      if (!snapshot.exists) return { error: 'invalid' };
      const call = snapshot.data();
      if (call.callerId !== callerId || call.calleeId !== calleeId || call.status !== 'ringing') return { error: 'invalid' };
      const ringingAtMs = call.updatedAt?.toMillis?.();
      if (!Number.isFinite(ringingAtMs) || Date.now() - ringingAtMs > 45_000) return { error: 'expired' };
      const sentAtMs = call.callPushSentAt?.toMillis?.();
      if (Number.isFinite(sentAtMs) && Date.now() - sentAtMs < 45_000) return { duplicate: true };
      const leaseUntilMs = call.callPushLeaseUntil?.toMillis?.();
      if (Number.isFinite(leaseUntilMs) && leaseUntilMs > Date.now()) return { pending: true };
      transaction.update(callRef, {
        callPushLeaseId: claimId,
        callPushLeaseUntil: admin.firestore.Timestamp.fromMillis(Date.now() + 15_000),
      });
      return { callData: call };
    });
    if (claim.error === 'expired') return res.status(410).json({ error: 'Call invitation expired' });
    if (claim.error || !claim.callData && !claim.duplicate && !claim.pending) return res.status(403).json({ error: 'Invalid call invitation' });
    if (claim.duplicate) return res.json({ success: true, duplicate: true, sent: 1, failed: 0 });
    if (claim.pending) return res.status(409).json({ success: false, reason: 'call_push_in_progress', sent: 0 });
    const callData = claim.callData;
    const callerName = String(callData.callerName || 'مستخدم').slice(0, 64);
    const callerAvatar = String(callData.callerAvatar || '').slice(0, 1024);

    console.log(`\n📞 Incoming Call: from ${callerId} to ${calleeId} (CallID: ${callId})`);

    const calleeData = await getCachedUser(calleeId);
    if (!calleeData || !calleeData.fcmToken) {
       await callRef.update({ callPushLeaseId: admin.firestore.FieldValue.delete(), callPushLeaseUntil: admin.firestore.FieldValue.delete() }).catch(() => {});
       console.warn(`[Notify Call] Callee has no registered push token: ${calleeId}`);
       return res.status(409).json({ success: false, reason: 'callee_no_push_token', sent: 0 });
    }

    const title = 'مكالمة واردة';
    const body = `مكالمة صوتية من ${callerName || 'شخص'}`;

    // Send high-priority FCM Data Message to wake up the app
    const result = await sendFCMAndSave({
      tokens: [calleeData.fcmToken],
      userIds: [calleeId],
      title,
      body,
      data: { type: 'INCOMING_CALL', callId, callerId, calleeId, callerName: callerName || '', callerAvatar: callerAvatar || '', callType: 'audio' },
      type: 'INCOMING_CALL',
      targetId: callerId,
      senderName: callerName || '',
      senderAvatar: callerAvatar || '',
      saveToInbox: false,
    });

    await db.runTransaction(async (transaction) => {
      const latest = await transaction.get(callRef);
      if (!latest.exists || latest.data().callPushLeaseId !== claimId) return;
      transaction.update(callRef, {
        ...(result.sent > 0 ? { callPushSentAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
        callPushLeaseId: admin.firestore.FieldValue.delete(),
        callPushLeaseUntil: admin.firestore.FieldValue.delete(),
      });
    }).catch((error) => console.warn('[Notify Call] Could not finalize push claim:', error.code || error.message));

    if (result.timedOut || result.sent === 0) {
      console.error(`[Notify Call] Push delivery failed for call ${callId}:`, JSON.stringify(result));
      return res.status(502).json({ success: false, reason: 'push_delivery_failed', ...result });
    }
    return res.json({ success: result.failed === 0, ...result });
  } catch (err) {
    console.error('[Notify Call Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ADMIN DASHBOARD: Server Stats
// ==========================================
app.get('/api/stats', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== (process.env.ADMIN_KEY || 'inshashta2026')) {
    return res.status(403).json({ error: 'منطقة محظورة 🚫 - مسار محمي بكلمة مرور' });
  }
  
  res.json({
    status: 'Running efficiently',
    version: '9.5.0',
    uptime: process.uptime(),
    activeCacheEntries: CacheStore.size,
    rateLimiterActiveIPs: rateLimitMap.size,
    memoryUsage: process.memoryUsage(),
    firebaseInitialized: !!admin.apps.length
  });
});

// ==========================================
// 4. Delete Message Notification (Overwrite Tray)
// Supports admin deletion: pass isAdminDelete=true and adminName to show who deleted
// ==========================================
app.post('/api/delete-notification', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not available' });
    const { matchId, isAdminDelete, adminName } = req.body;
    if (!matchId) return res.status(400).json({ error: 'matchId required' });
    
    console.log(`\n🗑️ Delete notification requested for: matchId=${matchId}${isAdminDelete ? ` (Admin: ${adminName})` : ''}`);

    const isDM = matchId.startsWith('dm_');
    const isGroup = matchId.startsWith('group_');
    const tokens = [];
    
    // Fetch tokens
    if (isDM) {
      const parts = matchId.replace('dm_', '').split('_');
      for (const uid of parts) {
        const data = await getCachedUser(uid);
        if (data?.fcmToken) tokens.push(data.fcmToken);
      }
    } else if (isGroup) {
      const groupData = await getCachedDoc('Groups', matchId.replace('group_', ''));
      if (groupData?.members?.length > 0) {
        const usersData = await getCachedUsersBatch(groupData.members);
        Object.keys(usersData).forEach(uid => {
           if (usersData[uid].fcmToken) tokens.push(usersData[uid].fcmToken);
        });
      }
    } else {
      const matchData = await getCachedDoc('Matches', matchId);
      if (matchData?.players?.length > 0) {
        const usersData = await getCachedUsersBatch(matchData.players);
        Object.keys(usersData).forEach(uid => {
           if (usersData[uid].fcmToken) tokens.push(usersData[uid].fcmToken);
        });
      }
    }

    if (tokens.length === 0) return res.json({ success: true, sent: 0, reason: 'No tokens found' });

    const deleteBody = isAdminDelete 
      ? `🛡️ تم حذف رسالة بواسطة المشرف ${adminName || ''}`
      : '🚫 تم حذف هذه الرسالة';

    // Send a message that overwrites the notification tag with "Message deleted"
    const response = await admin.messaging().sendEachForMulticast({
      data: {
        title: 'تنبيه',
        body: deleteBody,
        type: 'delete_message',
        matchId,
        timestamp: Date.now().toString()
      },
      android: {
        priority: 'high',
        ttl: 86400000,
      },
      tokens
    });

    res.json({ success: true, sent: response.successCount });
  } catch (err) {
    console.error('[Delete Notification Error]', err.message);
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
    const matchData = await getCachedDoc('Matches', matchId);
    if (!matchData || matchData.leaderId !== leaderId) {
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
    version: '9.2.0',
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

// Authenticated, privacy-bounded client diagnostics. Reports are written by
// Admin SDK and can only be listed/triaged by the designated admin account.
const consoleIssueRateMap = new Map();
const CONSOLE_ADMIN_EMAIL = '01022763613@inshashta.app';
const consoleIssueRateCleanup = setInterval(() => {
  const now = Date.now();
  for (const [uid, rate] of consoleIssueRateMap.entries()) {
    if (now - rate.start > 60_000) consoleIssueRateMap.delete(uid);
  }
}, 5 * 60 * 1000);
consoleIssueRateCleanup.unref?.();
function cleanConsoleIssueText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[\w.-]+/gi, '$1[REDACTED]')
    .replace(/((?:password|token|secret|api[_-]?key)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .slice(0, maxLength);
}

async function verifyConsoleIssueCaller(req, res, requireAdmin = false) {
  const token = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  try {
    const identity = await admin.auth().verifyIdToken(token);
    if (requireAdmin && String(identity.email || '').toLowerCase() !== CONSOLE_ADMIN_EMAIL) {
      res.status(403).json({ error: 'Admin access required' });
      return null;
    }
    return identity;
  } catch {
    res.status(401).json({ error: 'Invalid authentication token' });
    return null;
  }
}

app.post('/api/client-issues', async (req, res) => {
  const identity = await verifyConsoleIssueCaller(req, res);
  if (!identity) return;
  if (!db) return res.status(503).json({ error: 'Issue storage unavailable' });

  const rateKey = identity.uid;
  const now = Date.now();
  if (consoleIssueRateMap.size > 20_000) {
    for (const [uid, value] of consoleIssueRateMap.entries()) {
      if (now - value.start > 60_000) consoleIssueRateMap.delete(uid);
    }
    while (consoleIssueRateMap.size > 20_000) consoleIssueRateMap.delete(consoleIssueRateMap.keys().next().value);
  }
  const rate = consoleIssueRateMap.get(rateKey) || { start: now, count: 0 };
  if (now - rate.start >= 60_000) { rate.start = now; rate.count = 0; }
  const body = req.body || {};
  const reports = Array.isArray(body.issues) ? body.issues : [body];
  if (!reports.length || reports.length > 20) return res.status(400).json({ error: 'Submit between 1 and 20 issue reports' });
  if (Buffer.byteLength(JSON.stringify(reports), 'utf8') > 300_000) return res.status(413).json({ error: 'Issue report batch is too large' });
  rate.count += reports.length;
  consoleIssueRateMap.set(rateKey, rate);
  if (rate.count > 60) return res.status(429).json({ error: 'Too many issue reports' });

  if (reports.some((report) => !cleanConsoleIssueText(report?.message, 2000))) {
    return res.status(400).json({ error: 'Every issue report needs a non-empty error message' });
  }

  try {
    const user = await getCachedUser(identity.uid).catch(() => null);
    const batch = db.batch();
    const issueCollection = db.collection('ClientConsoleIssues');
    const entries = reports.map((report) => {
      const clientIssueId = cleanConsoleIssueText(report.id, 80);
      const stableDocId = clientIssueId && /^[A-Za-z0-9_-]{1,80}$/.test(clientIssueId)
        ? crypto.createHash('sha256').update(`${identity.uid}:${clientIssueId}`).digest('hex')
        : crypto.randomUUID().replace(/-/g, '');
      return { report, clientIssueId, ref: issueCollection.doc(stableDocId) };
    });
    const existingReports = await db.getAll(...entries.map((entry) => entry.ref));
    let writes = 0;
    for (let index = 0; index < entries.length; index++) {
      const { report, clientIssueId, ref } = entries[index];
      const existing = existingReports[index];
      if (existing.exists) {
        if (existing.data()?.reporterUid !== identity.uid) return res.status(409).json({ error: 'Issue report ID collision' });
        continue;
      }
      batch.create(ref, {
        clientIssueId,
        reporterUid: identity.uid,
        reporterName: cleanConsoleIssueText(user?.name || identity.name || '', 100),
        reporterEmail: cleanConsoleIssueText(identity.email || '', 160),
        message: cleanConsoleIssueText(report.message, 2000),
        stack: cleanConsoleIssueText(report.stack, 8000),
        source: cleanConsoleIssueText(report.source, 120) || 'app',
        route: cleanConsoleIssueText(report.route, 300),
        lastAction: cleanConsoleIssueText(report.lastAction, 250),
        context: cleanConsoleIssueText(report.context, 400),
        platform: cleanConsoleIssueText(report.platform, 500),
        status: 'open',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        clientOccurredAt: cleanConsoleIssueText(report.createdAt, 40),
      });
      writes++;
    }
    if (writes) await batch.commit();
    return res.status(201).json({ success: true, count: entries.length, ids: entries.map((entry) => entry.ref.id) });
  } catch (error) {
    console.error('[Client Issue] Could not store report:', error.message);
    return res.status(503).json({ error: 'Issue storage failed; client will retry later' });
  }
});

app.get('/api/admin/client-issues', async (req, res) => {
  const identity = await verifyConsoleIssueCaller(req, res, true);
  if (!identity) return;
  if (!db) return res.status(503).json({ error: 'Issue storage unavailable' });
  try {
    const snapshot = await db.collection('ClientConsoleIssues').orderBy('createdAt', 'desc').limit(200).get();
    const issues = snapshot.docs.map((issueDoc) => {
      const data = issueDoc.data();
      return {
        id: issueDoc.id,
        ...data,
        createdAt: data.createdAt?.toDate?.().toISOString() || data.clientOccurredAt || '',
        resolvedAt: data.resolvedAt?.toDate?.().toISOString() || null,
      };
    });
    return res.json({ issues });
  } catch (error) {
    console.error('[Client Issue] Admin list failed:', error.message);
    return res.status(503).json({ error: 'Could not load issue reports' });
  }
});

app.patch('/api/admin/client-issues/:issueId', async (req, res) => {
  const identity = await verifyConsoleIssueCaller(req, res, true);
  if (!identity) return;
  if (!db) return res.status(503).json({ error: 'Issue storage unavailable' });
  const issueId = String(req.params.issueId || '');
  const status = req.body?.status;
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(issueId) || !['open', 'resolved'].includes(status)) {
    return res.status(400).json({ error: 'Invalid issue ID or status' });
  }
  try {
    await db.collection('ClientConsoleIssues').doc(issueId).update({
      status,
      resolvedAt: status === 'resolved' ? admin.firestore.FieldValue.serverTimestamp() : null,
      resolvedBy: identity.uid,
    });
    return res.json({ success: true });
  } catch (error) {
    if (error.code === 5) return res.status(404).json({ error: 'Issue not found' });
    console.error('[Client Issue] Admin update failed:', error.message);
    return res.status(503).json({ error: 'Could not update issue' });
  }
});

// ==========================================
// 12. Admin: Reset User Password (FREE)
// ==========================================
app.post('/api/admin/reset-password', asyncHandler(async (req, res) => {
  // Verify admin key
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== (process.env.ADMIN_KEY || 'inshashta2026')) {
    return res.status(403).json({ error: 'Unauthorized - Admin access required' });
  }

  const { phone, newPassword } = req.body;
  if (!phone || !newPassword) {
    return res.status(400).json({ error: 'phone and newPassword are required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const cleanPhone = phone.trim().replace(/[\s-]/g, '');
  const fakeEmail = `${cleanPhone}@inshashta.app`;

  console.log(`\n🔑 Admin password reset for: ${fakeEmail}`);

  try {
    // 1. Find user by email (fake email from phone)
    const userRecord = await admin.auth().getUserByEmail(fakeEmail);
    
    // 2. Update password
    await admin.auth().updateUser(userRecord.uid, { password: newPassword });

    console.log(`✅ Password reset successful for UID: ${userRecord.uid}`);
    res.json({ 
      success: true, 
      message: `Password reset for ${cleanPhone}`,
      uid: userRecord.uid
    });
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      return res.status(404).json({ error: `User not found with phone: ${cleanPhone}` });
    }
    console.error('❌ Password reset failed:', err.message);
    res.status(500).json({ error: err.message });
  }
}));

// ==========================================
// 12b. Self-Service: Device-Verified Password Reset (AI-Supervised)
// ==========================================
app.post('/api/recover-account', asyncHandler(async (req, res) => {
  if (!db) return res.status(500).json({ error: 'DB not available' });

  const { phone, deviceId, newPassword } = req.body;
  if (!phone || !deviceId || !newPassword) {
    return res.status(400).json({ error: 'phone, deviceId and newPassword are required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const cleanPhone = phone.trim().replace(/[\s-]/g, '');
  const fakeEmail = `${cleanPhone}@inshashta.app`;

  console.log(`\n🔐 Self-service recovery for: ${cleanPhone}, deviceId: ${deviceId.slice(0, 10)}...`);

  try {
    // 1. Find user in Firebase Auth
    const userRecord = await admin.auth().getUserByEmail(fakeEmail);

    // 2. Look up user in Firestore to check device
    const userDoc = await db.collection('Users').doc(userRecord.uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'user_not_found', message: 'لا يوجد حساب مرتبط بهذا الرقم' });
    }

    const userData = userDoc.data();

    // 3. Compare deviceId
    if (!userData.deviceId) {
      return res.status(403).json({ 
        error: 'no_device_registered',
        message: 'لم يتم تسجيل جهاز لهذا الحساب. تواصل مع الأدمن لاستعادة الحساب.'
      });
    }

    if (userData.deviceId !== deviceId) {
      console.log(`❌ Device mismatch! Stored: ${userData.deviceId?.slice(0, 10)}, Provided: ${deviceId.slice(0, 10)}`);
      return res.status(403).json({ 
        error: 'device_mismatch',
        message: 'هذا الجهاز لا يتطابق مع الجهاز المسجل في الحساب. تواصل مع الأدمن.'
      });
    }

    // 4. Device matches! Reset password
    await admin.auth().updateUser(userRecord.uid, { password: newPassword });

    console.log(`✅ Self-service recovery successful for UID: ${userRecord.uid}`);
    res.json({ 
      success: true, 
      message: 'تم إعادة تعيين كلمة المرور بنجاح!',
      userName: userData.name || ''
    });
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      return res.status(404).json({ error: 'user_not_found', message: 'لا يوجد حساب مرتبط بهذا الرقم' });
    }
    console.error('❌ Self-service recovery failed:', err.message);
    res.status(500).json({ error: 'server_error', message: 'حدث خطأ، حاول مرة أخرى لاحقاً' });
  }
}));

// ==========================================
// 13. Gemini AI Chat Proxy
// ==========================================
const aiRateLimitMap = new Map();
const AI_RATE_LIMIT_WINDOW = 60000; // 1 minute
const AI_MAX_REQUESTS = 30; // 30 AI requests per minute per user

app.post('/api/ai/chat', asyncHandler(async (req, res) => {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyDDQMlVeTWqWZp92X06bFH_E0jq_0QvqN0';
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Gemini API key not configured' });
  }

  const { message, history, userId } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  // Per-user rate limiting for AI
  const rateLimitKey = userId || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const now = Date.now();
  if (aiRateLimitMap.has(rateLimitKey)) {
    const data = aiRateLimitMap.get(rateLimitKey);
    if (now - data.startTime > AI_RATE_LIMIT_WINDOW) {
      data.count = 1;
      data.startTime = now;
    } else {
      data.count++;
      // Limit removed for admin usage 
      // if (data.count > AI_MAX_REQUESTS) {
      //   return res.status(429).json({ error: 'لقد تجاوزت الحد المسموح. حاول مرة أخرى بعد دقيقة.' });
      // }
    }
  } else {
    aiRateLimitMap.set(rateLimitKey, { count: 1, startTime: now });
  }

  console.log(`\n🤖 AI Chat request from: ${rateLimitKey}`);

  try {
    // Build conversation history for Gemini
    const contents = [];

    const systemPrompt = `أنت "شِشتا AI" ✅ - المساعد الرسمي المعتمد لتطبيق "in shashta". أنت مشرف ذكي وموثق على التطبيق بالكامل.

🏷️ هويتك:
- اسمك: شِشتا AI
- أنت حساب موثق ✅ ومعتمد رسمياً من التطبيق
- أنت المشرف الذكي الرسمي على تطبيق in shashta
- مالك التطبيق بالكامل هو: وليد عمرو خيال
- لا تذكر أبداً أنك Gemini أو Google أو أي نموذج ذكاء اصطناعي آخر

📱 عن التطبيق:
in shashta هو تطبيق دردشة وسوشيال ميديا بين الأصدقاء. التطبيق مصمم للتواصل الاجتماعي والمرح بين الأصحاب.

💬 ميزات التطبيق التي تشرف عليها:
1. **المحادثات** - دردشة فردية وجماعية مع صور وفيديوهات ورسائل صوتية وملصقات (الميزة الأساسية)
2. **المجموعات** - مجموعات أصدقاء وشِلل
3. **الحالة** - مشاركة حالات (صور/فيديو/نصوص) تختفي بعد 24 ساعة (زي الستوري)
4. **الملف الشخصي** - إعدادات الحساب، صورة البروفايل، تغيير الاسم
5. **الإشعارات** - تنبيهات الرسائل والأنشطة الجديدة
6. **الملصقات** - ملصقات متحركة وإيموجي في المحادثات
7. **الرسائل الصوتية** - تسجيل وإرسال رسائل صوتية
8. **إعادة التوجيه** - تحويل الرسائل بين المحادثات
9. **التفاعلات** - ردود فعل بالإيموجي على الرسائل
10. **المباريات** - ميزة إضافية لتنظيم مباريات كرة قدم بين الأصحاب

🛡️ صلاحياتك كمشرف:
- مساعدة المستخدمين في حل أي مشكلة
- شرح كيفية استخدام أي ميزة في التطبيق
- الإجابة عن أي سؤال عام
- تقديم اقتراحات لتحسين تجربة المستخدم
- الدردشة العامة بأسلوب ودي ومرح

🎯 قواعد الرد:
- رد بالعربي المصري العامي بشكل طبيعي
- لو المستخدم كتب بلغة تانية، رد بنفس لغته
- استخدم إيموجي بشكل طبيعي ومناسب
- كن مختصر ومفيد - ما تطولش في الكلام
- كن ودود ومرح زي صاحب بيساعد
- لو سألوك "مين أنت" قول أنك شِشتا AI المشرف المعتمد ✅ على التطبيق
- لو سألوك "مين صاحب التطبيق" قول وليد عمرو خيال
- لو سألوك عن أي موضوع عام، رد عادي بشكل مختصر
- لا تخترع معلومات عن مستخدمين محددين
- لو حد طلب مساعدة تقنية، وجهه بالخطوات بالتفصيل`;


    // Add conversation history
    if (history && Array.isArray(history) && history.length > 0) {
      // First message must be from 'user'
      const firstUserIdx = history.findIndex(h => h.role === 'user');
      const validHistory = firstUserIdx >= 0 ? history.slice(firstUserIdx) : [];
      
      validHistory.forEach(h => {
        contents.push({
          role: h.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: h.content }]
        });
      });
    }

    // Add current message
    contents.push({
      role: 'user',
      parts: [{ text: message }]
    });

    // Call Gemini API
    const geminiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents,
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        generationConfig: {
          temperature: 0.8,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 2048
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
        ]
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );

    const aiText = geminiResponse.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!aiText) {
      console.error('❌ Empty AI response:', JSON.stringify(geminiResponse.data));
      return res.status(500).json({ error: 'لم أتمكن من الرد. حاول مرة أخرى.' });
    }

    console.log(`✅ AI responded: ${aiText.substring(0, 80)}...`);
    res.json({ success: true, reply: aiText });

  } catch (err) {
    console.error('❌ Gemini API error:', err.response?.data || err.message);
    const status = err.response?.status || 500;
    const errorMsg = status === 429 
      ? 'الـ AI مشغول حالياً، حاول مرة أخرى بعد شوية.'
      : 'حدث خطأ في الاتصال بالذكاء الاصطناعي.';
    res.status(status).json({ error: errorMsg });
  }
}));

// Clean up AI rate limit map every 5 minutes
const aiRateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, data] of aiRateLimitMap.entries()) {
    if (now - data.startTime > AI_RATE_LIMIT_WINDOW) {
      aiRateLimitMap.delete(key);
    }
  }
}, 5 * 60 * 1000);
aiRateLimitCleanup.unref?.();

// ==========================================
// 🔔 SECURITY: NEW LOGIN NOTIFICATION
// ==========================================
app.post('/api/notify-new-login', async (req, res) => {
  const { uid, deviceName } = req.body;
  if (!uid || !deviceName) return res.status(400).json({ error: 'Missing data' });
  try {
    const userData = await getCachedUser(uid);
    if (!userData) return res.status(404).json({ error: 'User not found' });
    if (userData.fcmToken) {
      await sendFCMAndSave({
        tokens: [userData.fcmToken],
        userIds: [uid],
        title: '🚨 تنبيه أمني خطير',
        body: `تم تسجيل الدخول للتو إلى حسابك من جهاز جديد: ${deviceName}. إذا لم تكن أنت، قم بتغيير كلمة المرور فوراً.`,
        type: 'security_alert',
        targetId: 'security'
      });
      return res.json({ success: true });
    }
    res.json({ success: false, message: 'No previous token found' });
  } catch (err) {
    console.error('Notify new login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🛑 GLOBAL ERROR HANDLER
// ==========================================
app.use((err, req, res, next) => {
  console.error('[Global Error]', err.message);
  res.status(500).json({ error: 'Internal Server Error', details: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));

module.exports = app;
