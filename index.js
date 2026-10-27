const crypto = require('node:crypto');
const cors = require('cors');
const express = require('express');
const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const TOPIC = 'tournament_updates';
const SEASON_COLLECTIONS = ['teams', 'players', 'matches', 'goals', 'cards', 'news', 'highlights', 'comments'];
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://waleeed-amr.github.io,https://localhost,capacitor://localhost,http://localhost')
    .split(',').map(origin => origin.trim()).filter(Boolean)
);

let firebaseReady = false;
let db = null;
let auth = null;
let messaging = null;

try {
  const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!rawServiceAccount) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured');
  const serviceAccount = JSON.parse(rawServiceAccount);
  if (serviceAccount.project_id !== 'kearshehta') throw new Error('The service account must belong to Firebase project kearshehta');
  serviceAccount.private_key = String(serviceAccount.private_key || '').replace(/\\n/g, '\n');
  if (!serviceAccount.client_email || !serviceAccount.private_key) throw new Error('Service account JSON is incomplete');
  const firebaseApp = getApps()[0] || initializeApp({ credential: cert(serviceAccount), projectId: 'kearshehta' });
  db = getFirestore(firebaseApp);
  auth = getAuth(firebaseApp);
  messaging = getMessaging(firebaseApp);
  firebaseReady = true;
} catch (error) {
  console.error('[startup] Firebase Admin is not configured:', error.message);
}

app.disable('x-powered-by');
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  maxAge: 86400
}));
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

function requireFirebase(req, res, next) {
  if (!firebaseReady) return res.status(503).json({ code: 'unavailable', message: 'خدمة Firebase غير مجهزة على السيرفر.' });
  return next();
}

async function getUserFromRequest(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const error = new Error('سجّل الدخول أولًا.');
    error.status = 401;
    error.code = 'unauthenticated';
    throw error;
  }
  try {
    return await auth.verifyIdToken(match[1]);
  } catch {
    const error = new Error('انتهت جلسة الدخول. سجّل الدخول مرة أخرى.');
    error.status = 401;
    error.code = 'unauthenticated';
    throw error;
  }
}

async function requireUser(req, res, next) {
  try {
    req.user = await getUserFromRequest(req);
    return next();
  } catch (error) {
    return res.status(error.status || 401).json({ code: error.code || 'unauthenticated', message: error.message });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.admin !== true) return res.status(403).json({ code: 'permission-denied', message: 'صلاحية الأدمن مطلوبة.' });
  return next();
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get('/', (req, res) => res.json({ service: 'Dawret Ramadan API', ok: true }));
app.get('/api/health', (req, res) => res.status(firebaseReady ? 200 : 503).json({
  ok: firebaseReady,
  service: 'Dawret Ramadan API',
  ...(firebaseReady ? {} : { error: 'Firebase Admin credentials are missing or invalid.' })
}));

app.post('/api/registerPushToken', requireFirebase, requireUser, asyncRoute(async (req, res) => {
  const token = String(req.body?.token || '');
  const platform = req.body?.platform === 'native' ? 'native' : 'web';
  if (token.length < 40 || token.length > 4096) return res.status(400).json({ code: 'invalid-argument', message: 'رمز الإشعار غير صالح.' });
  const tokenId = crypto.createHash('sha256').update(token).digest('hex');
  await db.collection('pushTokens').doc(tokenId).set({
    uid: req.user.uid,
    token,
    platform,
    active: true,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await messaging.subscribeToTopic([token], TOPIC);
  return res.json({ ok: true });
}));

app.post('/api/sendTournamentNotification', requireFirebase, requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 80);
  const body = String(req.body?.body || '').trim().slice(0, 220);
  if (!title || !body) return res.status(400).json({ code: 'invalid-argument', message: 'اكتب عنوان الإشعار ونصه.' });
  const messageId = await messaging.send({
    topic: TOPIC,
    notification: { title, body },
    data: { url: './', sentAt: new Date().toISOString() },
    android: { priority: 'high', notification: { channelId: 'tournament' } },
    apns: { payload: { aps: { sound: 'default' } } }
  });
  await db.collection('notificationCampaigns').add({
    title, body, messageId, sentBy: req.user.uid, createdAt: FieldValue.serverTimestamp()
  });
  return res.json({ messageId, successCount: 1 });
}));

app.use((error, req, res, next) => {
  console.error('[api]', error.message);
  if (res.headersSent) return next(error);
  const status = error.status || (error.message === 'Origin is not allowed' ? 403 : 500);
  return res.status(status).json({ code: error.code || 'internal', message: status === 500 ? 'حدث خطأ داخلي في السيرفر.' : error.message });
});

if (require.main === module) app.listen(PORT, () => console.log(`Dawret Ramadan API listening on ${PORT}`));
module.exports = app;
