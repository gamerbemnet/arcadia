const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const DATABASE_URL = process.env.DATABASE_URL;
const db = require('./db');
const { filterMessage } = require('./filter');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(path.join(DATA_DIR, 'uploads'))) fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

// Session store
let sessionStore;
if (DATABASE_URL) {
  const PgSession = require('connect-pg-simple')(session);
  sessionStore = new PgSession({ conString: DATABASE_URL, createTableIfMissing: true });
} else {
  const SQLiteStore = require('connect-sqlite3')(session);
  sessionStore = new SQLiteStore({ dir: DATA_DIR, db: 'sessions.db' });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  store: sessionStore,
  secret: 'arcadia-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 10 * 365 * 24 * 60 * 60 * 1000, httpOnly: true }
}));

// --- Uploads ---
const uploadDirs = ['uploads', 'uploads/avatars', 'uploads/models', 'uploads/textures', 'uploads/meshes', 'uploads/audio', 'uploads/scripts'];
uploadDirs.forEach(dir => { const p = path.join(DATA_DIR, dir); if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const type = req.body.type || 'models';
    const dir = path.join(DATA_DIR, `uploads/${type}s`);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads')));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// --- Initialize Database ---
async function initDB() {
  if (DATABASE_URL) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        avatar_color TEXT DEFAULT '#00a2ff',
        avatar_data TEXT DEFAULT '{}',
        inventory TEXT DEFAULT '[]',
        flux INTEGER DEFAULT 500,
        premium INTEGER DEFAULT 0,
        premium_expires TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS friends (
        user_id TEXT,
        friend_id TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, friend_id)
      );
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        data TEXT DEFAULT '{}',
        thumbnail TEXT DEFAULT '',
        genre TEXT DEFAULT 'Adventure',
        plays INTEGER DEFAULT 0,
        likes INTEGER DEFAULT 0,
        max_players INTEGER DEFAULT 12,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        channel TEXT DEFAULT 'global',
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        amount INTEGER NOT NULL,
        description TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        from_user_id TEXT NOT NULL,
        to_user_id TEXT NOT NULL,
        from_items TEXT DEFAULT '[]',
        to_items TEXT DEFAULT '[]',
        from_flux INTEGER DEFAULT 0,
        to_flux INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        filename TEXT NOT NULL,
        filepath TEXT NOT NULL,
        preview TEXT DEFAULT '',
        downloads INTEGER DEFAULT 0,
        flux_cost INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        text TEXT NOT NULL,
        rating INTEGER DEFAULT 5,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        from_user_id TEXT,
        message TEXT NOT NULL,
        read INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS favorites (
        user_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, game_id)
      );
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        owner_id TEXT NOT NULL,
        icon TEXT DEFAULT '🎮',
        color TEXT DEFAULT '#00a2ff',
        member_count INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT DEFAULT 'member',
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, user_id)
      );
    `);
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        avatar_color TEXT DEFAULT '#00a2ff',
        avatar_data TEXT DEFAULT '{}',
        inventory TEXT DEFAULT '[]',
        flux INTEGER DEFAULT 500,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS friends (
        user_id TEXT,
        friend_id TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, friend_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (friend_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        data TEXT DEFAULT '{}',
        thumbnail TEXT DEFAULT '',
        genre TEXT DEFAULT 'Adventure',
        plays INTEGER DEFAULT 0,
        likes INTEGER DEFAULT 0,
        max_players INTEGER DEFAULT 12,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        channel TEXT DEFAULT 'global',
        message TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        amount INTEGER NOT NULL,
        description TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        from_user_id TEXT NOT NULL,
        to_user_id TEXT NOT NULL,
        from_items TEXT DEFAULT '[]',
        to_items TEXT DEFAULT '[]',
        from_flux INTEGER DEFAULT 0,
        to_flux INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (from_user_id) REFERENCES users(id),
        FOREIGN KEY (to_user_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        filename TEXT NOT NULL,
        filepath TEXT NOT NULL,
        preview TEXT DEFAULT '',
        downloads INTEGER DEFAULT 0,
        flux_cost INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        text TEXT NOT NULL,
        rating INTEGER DEFAULT 5,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (game_id) REFERENCES games(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        from_user_id TEXT,
        message TEXT NOT NULL,
        read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS favorites (
        user_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, game_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (game_id) REFERENCES games(id)
      );
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        owner_id TEXT NOT NULL,
        icon TEXT DEFAULT '🎮',
        color TEXT DEFAULT '#00a2ff',
        member_count INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT DEFAULT 'member',
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, user_id),
        FOREIGN KEY (group_id) REFERENCES groups(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `);
    try { db.exec("ALTER TABLE users RENAME COLUMN gemz TO flux"); } catch(e) {}
    try { db.exec("ALTER TABLE trades RENAME COLUMN from_gemz TO from_flux"); } catch(e) {}
    try { db.exec("ALTER TABLE trades RENAME COLUMN to_gemz TO to_flux"); } catch(e) {}
    try { db.exec("ALTER TABLE users ADD COLUMN premium INTEGER DEFAULT 0"); } catch(e) {}
    try { db.exec("ALTER TABLE users ADD COLUMN premium_expires TEXT"); } catch(e) {}
  }
}

// --- Notifications helper ---
async function addNotification(userId, type, message, fromUserId = null) {
  const id = uuidv4();
  await db.run('INSERT INTO notifications (id, user_id, type, from_user_id, message) VALUES (?, ?, ?, ?, ?)', id, userId, type, fromUserId, message);
}

const onlineUsers = new Map();

// --- Party System (in-memory) ---
const parties = new Map();
let partyIdCounter = 1;

function getParty(partyId) {
  return parties.get(partyId);
}

function createParty(owner, name, gameId) {
  const id = 'P' + (partyIdCounter++);
  const party = {
    id, name: name || `${owner.username}'s Party`,
    owner: { id: owner.id, username: owner.username, avatarColor: owner.avatarColor },
    members: [{ id: owner.id, username: owner.username, avatarColor: owner.avatarColor, voiceEnabled: false }],
    gameId: gameId || null,
    maxMembers: 8,
    createdAt: Date.now()
  };
  parties.set(id, party);
  return party;
}

function joinParty(partyId, user) {
  const party = parties.get(partyId);
  if (!party) return { error: 'Party not found' };
  if (party.members.length >= party.maxMembers) return { error: 'Party is full' };
  if (party.members.find(m => m.id === user.id)) return { error: 'Already in party' };
  party.members.push({ id: user.id, username: user.username, avatarColor: user.avatarColor, voiceEnabled: false });
  return { success: true, party };
}

function leaveParty(partyId, userId) {
  const party = parties.get(partyId);
  if (!party) return;
  party.members = party.members.filter(m => m.id !== userId);
  if (party.members.length === 0) {
    parties.delete(partyId);
  } else if (party.owner.id === userId) {
    party.owner = party.members[0];
  }
  return party;
}

function kickFromParty(partyId, ownerId, targetId) {
  const party = parties.get(partyId);
  if (!party || party.owner.id !== ownerId) return { error: 'Not authorized' };
  party.members = party.members.filter(m => m.id !== targetId);
  return { success: true, party };
}

function broadcastParty(partyId) {
  const party = parties.get(partyId);
  if (!party) return;
  const msg = JSON.stringify({ type: 'party_update', party });
  party.members.forEach(m => {
    const online = onlineUsers.get(m.id);
    if (online && online.ws.readyState === 1) online.ws.send(msg);
  });
}

// --- Voice Chat Signaling (WebRTC) ---
// Routes signaling messages between peers in a party

wss.on('connection', (ws, req) => {
  let userId = null;
  let username = null;
  let avatarColor = '#00a2ff';

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'auth') {
        userId = msg.userId;
        username = msg.username;
        avatarColor = msg.avatarColor || '#00a2ff';
        onlineUsers.set(userId, { ws, username, avatarColor });
        broadcastOnline();
      } else if (msg.type === 'chat' && userId) {
        const filtered = filterMessage(userId, msg.message);
        if (!filtered.allowed) {
          ws.send(JSON.stringify({ type: 'chat_error', reason: filtered.reason }));
          return;
        }
        const finalMsg = filtered.wasFiltered ? filtered.censored : msg.message;
        const id = uuidv4();
        const channel = msg.channel || 'global';
        db.run('INSERT INTO chat_messages (id, user_id, channel, message) VALUES (?, ?, ?, ?)', id, userId, channel, finalMsg);
        const sender = await db.get('SELECT premium, premium_expires FROM users WHERE id = ?', userId);
        const isPremium = sender && sender.premium === 1 && sender.premium_expires && new Date(sender.premium_expires) > new Date();
        const chatMsg = JSON.stringify({ type: 'chat', user: username, avatarColor, message: finalMsg, channel, timestamp: Date.now(), isPremium, filtered: filtered.wasFiltered });
        if (channel.startsWith('party_')) {
          const partyId = channel.replace('party_', '');
          const party = parties.get(partyId);
          if (party) {
            party.members.forEach(m => {
              const online = onlineUsers.get(m.id);
              if (online && online.ws.readyState === 1) online.ws.send(chatMsg);
            });
          }
        } else if (channel === 'global') {
          wss.clients.forEach(c => { if (c.readyState === 1) c.send(chatMsg); });
        } else {
          const target = onlineUsers.get(channel);
          if (target && target.ws.readyState === 1) target.ws.send(chatMsg);
          ws.send(chatMsg);
        }
      } else if (msg.type === 'typing' && userId) {
        if (msg.channel && msg.channel.startsWith('party_')) {
          const partyId = msg.channel.replace('party_', '');
          const party = parties.get(partyId);
          if (party) {
            party.members.forEach(m => {
              if (m.id !== userId) {
                const online = onlineUsers.get(m.id);
                if (online && online.ws.readyState === 1) online.ws.send(JSON.stringify({ type: 'typing', user: username }));
              }
            });
          }
        } else {
          const target = onlineUsers.get(msg.channel);
          if (target && target.ws.readyState === 1) {
            target.ws.send(JSON.stringify({ type: 'typing', user: username }));
          }
        }
      // --- Party WebSocket Messages ---
      } else if (msg.type === 'party_create' && userId) {
        const party = createParty({ id: userId, username, avatarColor }, msg.name, msg.gameId);
        ws.send(JSON.stringify({ type: 'party_joined', party }));
      } else if (msg.type === 'party_join' && userId) {
        const result = joinParty(msg.partyId, { id: userId, username, avatarColor });
        if (result.error) {
          ws.send(JSON.stringify({ type: 'party_error', error: result.error }));
        } else {
          broadcastParty(msg.partyId);
        }
      } else if (msg.type === 'party_leave' && userId) {
        const party = leaveParty(msg.partyId, userId);
        if (party) broadcastParty(msg.partyId);
        ws.send(JSON.stringify({ type: 'party_left' }));
      } else if (msg.type === 'party_kick' && userId) {
        const result = kickFromParty(msg.partyId, userId, msg.targetId);
        if (result.error) {
          ws.send(JSON.stringify({ type: 'party_error', error: result.error }));
        } else {
          const target = onlineUsers.get(msg.targetId);
          if (target && target.ws.readyState === 1) {
            target.ws.send(JSON.stringify({ type: 'party_kicked', partyId: msg.partyId }));
          }
          broadcastParty(msg.partyId);
        }
      } else if (msg.type === 'party_voice_toggle' && userId) {
        const party = parties.get(msg.partyId);
        if (party) {
          const member = party.members.find(m => m.id === userId);
          if (member) {
            member.voiceEnabled = !member.voiceEnabled;
            broadcastParty(msg.partyId);
          }
        }
      // --- Voice Chat WebRTC Signaling ---
      } else if (msg.type === 'voice_offer' || msg.type === 'voice_answer' || msg.type === 'voice_ice') {
        const target = onlineUsers.get(msg.to);
        if (target && target.ws.readyState === 1) {
          target.ws.send(JSON.stringify({ type: msg.type, from: userId, offer: msg.offer, answer: msg.answer, candidate: msg.candidate }));
        }
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    if (userId) {
      onlineUsers.delete(userId);
      // Clean user from all parties
      for (const [partyId, party] of parties) {
        const wasMember = party.members.find(m => m.id === userId);
        if (wasMember) {
          leaveParty(partyId, userId);
          if (parties.has(partyId)) broadcastParty(partyId);
        }
      }
    }
    broadcastOnline();
  });
});

function broadcastOnline() {
  const users = [];
  onlineUsers.forEach((v, k) => users.push({ id: k, username: v.username, avatarColor: v.avatarColor }));
  const msg = JSON.stringify({ type: 'online', users });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// --- Currency: Flux ---
async function addFlux(userId, amount, description, type = 'earn') {
  const id = uuidv4();
  await db.run('UPDATE users SET flux = flux + ? WHERE id = ?', amount, userId);
  await db.run('INSERT INTO transactions (id, user_id, type, amount, description) VALUES (?, ?, ?, ?, ?)', id, userId, type, amount, description);
}

// --- Chat ---
app.get('/api/chat/history', async (req, res) => {
  const channel = req.query.channel || 'global';
  const messages = await db.all(`
    SELECT c.*, u.username, u.avatar_color, u.premium, u.premium_expires
    FROM chat_messages c JOIN users u ON c.user_id = u.id
    WHERE c.channel = ? ORDER BY c.created_at DESC LIMIT 50
  `, channel);
  const result = messages.map(m => ({
    ...m,
    is_premium: m.premium === 1 && m.premium_expires && new Date(m.premium_expires) > new Date()
  }));
  res.json({ messages: result.reverse() });
});

// --- Auth ---
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Username must be 3-20 characters' });

  const existing = await db.get('SELECT id FROM users WHERE username = ? OR email = ?', username, email);
  if (existing) return res.status(400).json({ error: 'Username or email already taken' });

  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  const colors = ['#00a2ff','#e74c3c','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#3498db','#ff6b6b','#00cec9','#6c5ce7','#fd79a8'];
  const color = colors[Math.floor(Math.random() * colors.length)];

  await db.run('INSERT INTO users (id, username, email, password, avatar_color) VALUES (?, ?, ?, ?, ?)', id, username, email, hash, color);
  req.session.userId = id;
  res.json({ success: true, user: { id, username, email, avatar_color: color } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await db.get('SELECT * FROM users WHERE username = ?', username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.userId = user.id;
  res.json({ success: true, user: { id: user.id, username: user.username, email: user.email, avatar_color: user.avatar_color } });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = await db.get('SELECT id, username, email, avatar_color, avatar_data, inventory, flux, premium, premium_expires, created_at FROM users WHERE id = ?', req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  let avatarData = {};
  try { avatarData = JSON.parse(user.avatar_data || '{}'); } catch(e) {}
  let inventory = [];
  try { inventory = JSON.parse(user.inventory || '[]'); } catch(e) {}
  const isPremium = user.premium === 1 && user.premium_expires && new Date(user.premium_expires) > new Date();
  res.json({ user: { ...user, avatar_data: avatarData, inventory, isPremium } });
});

// --- Friends ---
app.get('/api/friends', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const friends = await db.all(`
    SELECT u.id, u.username, u.avatar_color
    FROM friends f
    JOIN users u ON (u.id = f.friend_id AND f.user_id = ?) OR (u.id = f.user_id AND f.friend_id = ?)
    WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 'accepted'
  `, userId, userId, userId, userId);
  const pending = await db.all(`
    SELECT u.id, u.username, u.avatar_color, f.user_id as from_user_id
    FROM friends f
    JOIN users u ON u.id = f.user_id
    WHERE f.friend_id = ? AND f.status = 'pending'
  `, userId);
  res.json({ friends, pending });
});

app.post('/api/friends/add', requireAuth, async (req, res) => {
  const { username } = req.body;
  const target = await db.get('SELECT id FROM users WHERE username = ?', username);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.session.userId) return res.status(400).json({ error: 'Cannot add yourself' });

  const existing = await db.get('SELECT * FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', req.session.userId, target.id, target.id, req.session.userId);
  if (existing) return res.status(400).json({ error: 'Friend request already exists' });

  await db.run('INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)', req.session.userId, target.id, 'pending');
  await addNotification(target.id, 'friend_request', 'sent you a friend request', req.session.userId);
  res.json({ success: true });
});

app.post('/api/friends/accept', requireAuth, async (req, res) => {
  const { userId } = req.body;
  await db.run('UPDATE friends SET status = ? WHERE user_id = ? AND friend_id = ?', 'accepted', userId, req.session.userId);
  const existing = await db.get('SELECT * FROM friends WHERE user_id = ? AND friend_id = ?', req.session.userId, userId);
  if (!existing) {
    await db.run('INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)', req.session.userId, userId, 'accepted');
  }
  await addNotification(userId, 'friend_accept', 'accepted your friend request', req.session.userId);
  res.json({ success: true });
});

app.post('/api/friends/remove', requireAuth, async (req, res) => {
  const { userId } = req.body;
  await db.run('DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', req.session.userId, userId, userId, req.session.userId);
  res.json({ success: true });
});

app.get('/api/users/search', requireAuth, async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ users: [] });
  const users = await db.all('SELECT id, username, avatar_color FROM users WHERE username LIKE ? AND id != ? LIMIT 10', `%${q}%`, req.session.userId);
  res.json({ users });
});

// --- Games ---
app.get('/api/games', async (req, res) => {
  const games = await db.all(`
    SELECT g.*, u.username as owner_name, u.avatar_color as owner_color
    FROM games g JOIN users u ON g.owner_id = u.id
    ORDER BY g.plays DESC LIMIT 50
  `);
  res.json({ games });
});

app.get('/api/games/:id', async (req, res) => {
  const game = await db.get(`
    SELECT g.*, u.username as owner_name, u.avatar_color as owner_color
    FROM games g JOIN users u ON g.owner_id = u.id
    WHERE g.id = ?
  `, req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  res.json({ game });
});

app.post('/api/games', requireAuth, async (req, res) => {
  const { name, description, genre } = req.body;
  if (!name) return res.status(400).json({ error: 'Game name required' });
  const id = uuidv4();
  await db.run('INSERT INTO games (id, owner_id, name, description, genre) VALUES (?, ?, ?, ?, ?)', id, req.session.userId, name, description || '', genre || 'Adventure');
  res.json({ success: true, game: { id, name } });
});

app.put('/api/games/:id', requireAuth, async (req, res) => {
  const game = await db.get('SELECT * FROM games WHERE id = ?', req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (game.owner_id !== req.session.userId) return res.status(403).json({ error: 'Not authorized' });

  const { name, description, data, genre } = req.body;
  await db.run('UPDATE games SET name = COALESCE(?, name), description = COALESCE(?, description), data = COALESCE(?, data), genre = COALESCE(?, genre), updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    name, description, data ? JSON.stringify(data) : null, genre, req.params.id);
  res.json({ success: true });
});

app.delete('/api/games/:id', requireAuth, async (req, res) => {
  const game = await db.get('SELECT * FROM games WHERE id = ?', req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (game.owner_id !== req.session.userId) return res.status(403).json({ error: 'Not authorized' });
  await db.run('DELETE FROM games WHERE id = ?', req.params.id);
  res.json({ success: true });
});

app.post('/api/games/:id/play', async (req, res) => {
  await db.run('UPDATE games SET plays = plays + 1 WHERE id = ?', req.params.id);
  const game = await db.get('SELECT owner_id, plays FROM games WHERE id = ?', req.params.id);
  if (game && game.plays % 10 === 0) {
    await addFlux(game.owner_id, 5, `Game milestone: ${game.plays} plays`);
  }
  res.json({ success: true });
});

app.post('/api/games/:id/like', requireAuth, async (req, res) => {
  const game = await db.get('SELECT owner_id, name FROM games WHERE id = ?', req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  await db.run('UPDATE games SET likes = likes + 1 WHERE id = ?', req.params.id);
  if (game.owner_id !== req.session.userId) {
    await addFlux(game.owner_id, 2, 'Someone liked your game');
    await addNotification(game.owner_id, 'like', `Someone liked "${game.name}"`, req.session.userId);
  }
  await addFlux(req.session.userId, 1, 'Liked a game');
  res.json({ success: true });
});

app.get('/api/my-games', requireAuth, async (req, res) => {
  const games = await db.all('SELECT * FROM games WHERE owner_id = ? ORDER BY updated_at DESC', req.session.userId);
  res.json({ games });
});

// --- Avatar ---
app.get('/api/avatar', requireAuth, async (req, res) => {
  const user = await db.get('SELECT avatar_data, avatar_color FROM users WHERE id = ?', req.session.userId);
  let data = {};
  try { data = JSON.parse(user.avatar_data || '{}'); } catch(e) {}
  res.json({ avatar: data, color: user.avatar_color });
});

app.put('/api/avatar', requireAuth, async (req, res) => {
  const { avatar, color } = req.body;
  if (avatar) {
    await db.run('UPDATE users SET avatar_data = ? WHERE id = ?', JSON.stringify(avatar), req.session.userId);
  }
  if (color) {
    await db.run('UPDATE users SET avatar_color = ? WHERE id = ?', color, req.session.userId);
  }
  res.json({ success: true });
});

app.get('/api/users/:id/avatar', async (req, res) => {
  const user = await db.get('SELECT avatar_data, avatar_color, username FROM users WHERE id = ?', req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  let data = {};
  try { data = JSON.parse(user.avatar_data || '{}'); } catch(e) {}
  res.json({ avatar: data, color: user.avatar_color, username: user.username });
});

// --- Leaderboards ---
app.get('/api/leaderboard/games', async (req, res) => {
  const games = await db.all(`
    SELECT g.id, g.name, g.plays, g.likes, g.genre, u.username as owner_name, u.avatar_color as owner_color
    FROM games g JOIN users u ON g.owner_id = u.id
    ORDER BY g.plays DESC LIMIT 20
  `);
  res.json({ games });
});

app.get('/api/leaderboard/creators', async (req, res) => {
  const creators = await db.all(`
    SELECT u.id, u.username, u.avatar_color,
      COUNT(g.id) as game_count,
      COALESCE(SUM(g.plays), 0) as total_plays,
      COALESCE(SUM(g.likes), 0) as total_likes
    FROM users u
    LEFT JOIN games g ON g.owner_id = u.id
    GROUP BY u.id
    ORDER BY total_plays DESC LIMIT 20
  `);
  res.json({ creators });
});

app.get('/api/leaderboard/popular', async (req, res) => {
  const games = await db.all(`
    SELECT g.id, g.name, g.plays, g.likes, g.genre, u.username as owner_name, u.avatar_color as owner_color
    FROM games g JOIN users u ON g.owner_id = u.id
    ORDER BY g.likes DESC LIMIT 20
  `);
  res.json({ games });
});

// --- Shop ---
const SHOP_ITEMS = [
  // Hats
  { id: 'crown_gold', name: 'Golden Crown', price: 100, category: 'hat', preview: '👑' },
  { id: 'crown_diamond', name: 'Diamond Crown', price: 250, category: 'hat', preview: '💎' },
  { id: 'tophat_purple', name: 'Purple Top Hat', price: 150, category: 'hat', preview: '🎩' },
  { id: 'hat_wizard', name: 'Wizard Hat', price: 200, category: 'hat', preview: '🧙' },
  { id: 'headphones_gold', name: 'Gold Headphones', price: 180, category: 'hat', preview: '🎧' },
  { id: 'halo_golden', name: 'Golden Halo', price: 300, category: 'hat', preview: '😇' },
  { id: 'hat_beret', name: 'Red Beret', price: 120, category: 'hat', preview: '🎨' },
  { id: 'hat_viking', name: 'Viking Helmet', price: 220, category: 'hat', preview: '⚔️' },
  { id: 'hat_chef', name: 'Chef Hat', price: 130, category: 'hat', preview: '👨‍🍳' },
  { id: 'hat_straw', name: 'Straw Hat', price: 110, category: 'hat', preview: '🌾' },
  // Hair
  { id: 'hair_spiky', name: 'Spiky Hair', price: 80, category: 'hair', preview: '💇' },
  { id: 'hair_ponytail', name: 'Ponytail', price: 80, category: 'hair', preview: '💇‍♀️' },
  { id: 'hair_mohawk', name: 'Mohawk', price: 120, category: 'hair', preview: '🤘' },
  { id: 'hair_afro', name: 'Afro', price: 100, category: 'hair', preview: '🫧' },
  { id: 'hair_bun', name: 'Hair Bun', price: 90, category: 'hair', preview: '🎀' },
  { id: 'hair_long', name: 'Long Hair', price: 100, category: 'hair', preview: '💇‍♀️' },
  // Shirts
  { id: 'shirt_hero', name: 'Hero Shirt', price: 150, category: 'shirt', preview: '🦸' },
  { id: 'shirt_ninja', name: 'Ninja Shirt', price: 180, category: 'shirt', preview: '🥷' },
  { id: 'shirt_pirate', name: 'Pirate Shirt', price: 160, category: 'shirt', preview: '🏴‍☠️' },
  { id: 'shirt_space', name: 'Space Suit', price: 250, category: 'shirt', preview: '🚀' },
  { id: 'shirt_armor', name: 'Knight Armor', price: 300, category: 'shirt', preview: '🛡️' },
  { id: 'shirt_suit', name: 'Formal Suit', price: 200, category: 'shirt', preview: '🤵' },
  // Pants
  { id: 'pants_jeans', name: 'Blue Jeans', price: 80, category: 'pants', preview: '👖' },
  { id: 'pants_shorts', name: 'Sport Shorts', price: 70, category: 'pants', preview: '🩳' },
  { id: 'pants_robe', name: 'Wizard Robe', price: 180, category: 'pants', preview: '🧙' },
  { id: 'pants_armor', name: 'Armor Legs', price: 250, category: 'pants', preview: '🦾' },
  // Accessories
  { id: 'sword_flame', name: 'Flame Sword', price: 200, category: 'accessory', preview: '🔥' },
  { id: 'sword_ice', name: 'Ice Sword', price: 200, category: 'accessory', preview: '❄️' },
  { id: 'shield_gold', name: 'Gold Shield', price: 175, category: 'accessory', preview: '🛡️' },
  { id: 'wings_angel', name: 'Angel Wings', price: 350, category: 'accessory', preview: '😇' },
  { id: 'wings_demon', name: 'Demon Wings', price: 350, category: 'accessory', preview: '😈' },
  { id: 'cape_royal', name: 'Royal Cape', price: 150, category: 'accessory', preview: '👑' },
  { id: 'backpack_gold', name: 'Gold Backpack', price: 120, category: 'accessory', preview: '🎒' },
  { id: 'trail_fire', name: 'Fire Trail', price: 280, category: 'accessory', preview: '🔥' },
  { id: 'trail_ice', name: 'Ice Trail', price: 280, category: 'accessory', preview: '🧊' },
  // Faces
  { id: 'face_ninja', name: 'Ninja Face', price: 80, category: 'face', preview: '🥷' },
  { id: 'face_robot', name: 'Robot Face', price: 100, category: 'face', preview: '🤖' },
  { id: 'face_skull', name: 'Skull Face', price: 120, category: 'face', preview: '💀' },
  { id: 'face_zombie', name: 'Zombie Face', price: 90, category: 'face', preview: '🧟' },
  { id: 'face_clown', name: 'Clown Face', price: 110, category: 'face', preview: '🤡' },
  // Colors
  { id: 'color_neon_green', name: 'Neon Green Body', price: 150, category: 'color', preview: '🟢', value: '#39ff14' },
  { id: 'color_neon_pink', name: 'Neon Pink Body', price: 150, category: 'color', preview: '🩷', value: '#ff1493' },
  { id: 'color_gold', name: 'Gold Body', price: 250, category: 'color', preview: '🥇', value: '#ffd700' },
  { id: 'color_rainbow', name: 'Rainbow Body', price: 500, category: 'color', preview: '🌈', value: '#ff0000' },
  { id: 'color_neon_blue', name: 'Neon Blue Body', price: 150, category: 'color', preview: '🔵', value: '#00d4ff' },
  { id: 'color_neon_orange', name: 'Neon Orange Body', price: 150, category: 'color', preview: '🟠', value: '#ff6600' },
  // Premium-only items
  { id: 'crown_premium', name: 'Diamond Premium Crown', price: 0, category: 'hat', preview: '💠', premium: true },
  { id: 'wings_premium', name: 'Phoenix Wings', price: 0, category: 'accessory', preview: '🔥', premium: true },
  { id: 'hair_premium', name: 'Flame Hair', price: 0, category: 'hair', preview: '🔥', premium: true },
  { id: 'shirt_premium', name: 'Royal Premium Outfit', price: 0, category: 'shirt', preview: '👑', premium: true },
  { id: 'face_premium', name: 'Golden visage', price: 0, category: 'face', preview: '✨', premium: true },
];

app.get('/api/shop', (req, res) => {
  res.json({ items: SHOP_ITEMS });
});

app.get('/api/shop/my-items', requireAuth, async (req, res) => {
  const user = await db.get('SELECT inventory FROM users WHERE id = ?', req.session.userId);
  let inventory = [];
  try { inventory = JSON.parse(user.inventory || '[]'); } catch(e) {}
  res.json({ inventory });
});

app.post('/api/shop/buy', requireAuth, async (req, res) => {
  const { itemId } = req.body;
  const item = SHOP_ITEMS.find(i => i.id === itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const user = await db.get('SELECT flux, inventory, premium, premium_expires FROM users WHERE id = ?', req.session.userId);
  let inventory = [];
  try { inventory = JSON.parse(user.inventory || '[]'); } catch(e) {}

  if (inventory.includes(itemId)) return res.status(400).json({ error: 'Already owned' });

  // Premium-only items
  if (item.premium) {
    const isPremium = user.premium === 1 && user.premium_expires && new Date(user.premium_expires) > new Date();
    if (!isPremium) return res.status(400).json({ error: 'Premium only item' });
  } else {
    if (user.flux < item.price) return res.status(400).json({ error: 'Not enough flux' });
    await addFlux(req.session.userId, -item.price, `Bought ${item.name}`);
  }

  inventory.push(itemId);
  const updatedFlux = item.premium ? user.flux : user.flux - item.price;
  await db.run('UPDATE users SET flux = ?, inventory = ? WHERE id = ?', updatedFlux, JSON.stringify(inventory), req.session.userId);
  res.json({ success: true, flux: updatedFlux });
});

app.post('/api/shop/equip', requireAuth, async (req, res) => {
  const { itemId } = req.body;
  const item = SHOP_ITEMS.find(i => i.id === itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const user = await db.get('SELECT inventory, avatar_data FROM users WHERE id = ?', req.session.userId);
  let inventory = [];
  try { inventory = JSON.parse(user.inventory || '[]'); } catch(e) {}
  let avatarData = {};
  try { avatarData = JSON.parse(user.avatar_data || '{}'); } catch(e) {}

  if (!inventory.includes(itemId)) return res.status(400).json({ error: 'Not owned' });

  if (item.category === 'hat') avatarData.hat = itemId.replace(/^(crown_|tophat_|hat_|headphones_|halo_)/, '');
  else if (item.category === 'hair') avatarData.hair = itemId.replace('hair_', '');
  else if (item.category === 'shirt') avatarData.shirt = itemId.replace('shirt_', '');
  else if (item.category === 'pants') avatarData.pants = itemId.replace('pants_', '');
  else if (item.category === 'accessory') avatarData.accessory = itemId.replace(/^(sword_|shield_|wings_|cape_|backpack_|trail_)/, '');
  else if (item.category === 'face') avatarData.face = itemId.replace('face_', '');
  else if (item.category === 'color' && item.value) avatarData.bodyColor = item.value;

  await db.run('UPDATE users SET avatar_data = ? WHERE id = ?', JSON.stringify(avatarData), req.session.userId);
  res.json({ success: true, avatar: avatarData });
});

// --- Flux ---
app.get('/api/flux', requireAuth, async (req, res) => {
  const user = await db.get('SELECT flux FROM users WHERE id = ?', req.session.userId);
  res.json({ flux: user.flux });
});

app.post('/api/flux/claim-daily', requireAuth, async (req, res) => {
  const user = await db.get('SELECT flux, premium, premium_expires FROM users WHERE id = ?', req.session.userId);
  const lastClaim = await db.get('SELECT created_at FROM transactions WHERE user_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1', req.session.userId, 'daily');
  if (lastClaim) {
    const last = new Date(lastClaim.created_at);
    const now = new Date();
    const hoursSince = (now - last) / (1000 * 60 * 60);
    if (hoursSince < 23) {
      const hoursLeft = Math.ceil(23 - hoursSince);
      return res.status(400).json({ error: `Daily bonus available in ${hoursLeft}h` });
    }
  }
  const isPremium = user.premium === 1 && user.premium_expires && new Date(user.premium_expires) > new Date();
  const bonus = isPremium ? 100 : 50;
  await addFlux(req.session.userId, bonus, isPremium ? 'Daily bonus (Premium 2x)' : 'Daily login bonus');
  const updated = await db.get('SELECT flux FROM users WHERE id = ?', req.session.userId);
  res.json({ success: true, flux: updated.flux, earned: bonus, isPremium });
});

app.get('/api/flux/transactions', requireAuth, async (req, res) => {
  const txns = await db.all('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', req.session.userId);
  res.json({ transactions: txns });
});

// --- Premium ---
const PREMIUM_PLANS = [
  { id: 'monthly', name: 'Premium Monthly', price: '$4.99/mo', days: 30, flux: 500 },
  { id: 'yearly', name: 'Premium Yearly', price: '$39.99/yr', days: 365, flux: 6000 },
];

app.get('/api/premium/plans', (req, res) => {
  res.json({ plans: PREMIUM_PLANS });
});

app.get('/api/premium/status', requireAuth, async (req, res) => {
  const user = await db.get('SELECT premium, premium_expires FROM users WHERE id = ?', req.session.userId);
  const isPremium = user.premium === 1 && user.premium_expires && new Date(user.premium_expires) > new Date();
  res.json({ isPremium, expires: user.premium_expires });
});

app.post('/api/premium/subscribe', requireAuth, async (req, res) => {
  const { planId } = req.body;
  const plan = PREMIUM_PLANS.find(p => p.id === planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const user = await db.get('SELECT premium, premium_expires FROM users WHERE id = ?', req.session.userId);
  let expires = new Date();
  if (user.premium === 1 && user.premium_expires && new Date(user.premium_expires) > new Date()) {
    expires = new Date(user.premium_expires);
  }
  expires.setDate(expires.getDate() + plan.days);

  await db.run('UPDATE users SET premium = 1, premium_expires = ? WHERE id = ?', expires.toISOString(), req.session.userId);
  await addFlux(req.session.userId, plan.flux, `Premium bonus: ${plan.name}`);
  const updated = await db.get('SELECT flux, premium, premium_expires FROM users WHERE id = ?', req.session.userId);
  res.json({ success: true, flux: updated.flux, expires: updated.premium_expires });
});

app.post('/api/premium/cancel', requireAuth, async (req, res) => {
  await db.run('UPDATE users SET premium = 0, premium_expires = NULL WHERE id = ?', req.session.userId);
  res.json({ success: true });
});

// --- Assets ---
const ASSET_TYPES = ['avatar', 'model', 'texture', 'mesh', 'audio', 'script'];

app.post('/api/assets/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { name, type, preview } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'Name and type required' });
  if (!ASSET_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid asset type' });

  const user = await db.get('SELECT flux FROM users WHERE id = ?', req.session.userId);
  if (user.flux < 10) return res.status(400).json({ error: 'Not enough Flux (10 required)' });

  const id = uuidv4();
  const filepath = `/${req.file.path.replace(/\\/g, '/')}`;
  await db.run('INSERT INTO assets (id, user_id, name, type, filename, filepath, preview, flux_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, req.session.userId, name, type, req.file.filename, filepath, preview || '', 10);
  await addFlux(req.session.userId, -10, `Uploaded asset: ${name}`);

  const updated = await db.get('SELECT flux FROM users WHERE id = ?', req.session.userId);
  res.json({ success: true, asset: { id, name, type, filepath }, flux: updated.flux });
});

app.get('/api/assets', async (req, res) => {
  const { type, search } = req.query;
  let query = `SELECT a.*, u.username, u.avatar_color FROM assets a JOIN users u ON a.user_id = u.id`;
  const params = [];
  const conditions = [];

  if (type && ASSET_TYPES.includes(type)) {
    conditions.push('a.type = ?');
    params.push(type);
  }
  if (search) {
    conditions.push('a.name LIKE ?');
    params.push(`%${search}%`);
  }
  if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY a.created_at DESC LIMIT 50';

  const assets = await db.all(query, ...params);
  res.json({ assets });
});

app.get('/api/assets/:id', async (req, res) => {
  const asset = await db.get(`
    SELECT a.*, u.username, u.avatar_color
    FROM assets a JOIN users u ON a.user_id = u.id WHERE a.id = ?
  `, req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  res.json({ asset });
});

app.post('/api/assets/:id/download', async (req, res) => {
  await db.run('UPDATE assets SET downloads = downloads + 1 WHERE id = ?', req.params.id);
  res.json({ success: true });
});

app.delete('/api/assets/:id', requireAuth, async (req, res) => {
  const asset = await db.get('SELECT * FROM assets WHERE id = ?', req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (asset.user_id !== req.session.userId) return res.status(403).json({ error: 'Not authorized' });

  const filePath = path.join(__dirname, asset.filepath);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  await db.run('DELETE FROM assets WHERE id = ?', req.params.id);
  res.json({ success: true });
});

// --- Trading ---
app.post('/api/trade/send', requireAuth, async (req, res) => {
  const { toUserId, myItems, myFlux, theirItems, theirFlux } = req.body;
  const target = await db.get('SELECT id FROM users WHERE id = ?', toUserId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (toUserId === req.session.userId) return res.status(400).json({ error: 'Cannot trade with yourself' });

  const user = await db.get('SELECT inventory, flux FROM users WHERE id = ?', req.session.userId);
  let inventory = [];
  try { inventory = JSON.parse(user.inventory || '[]'); } catch(e) {}

  if (myItems && myItems.length > 0) {
    for (const itemId of myItems) {
      if (!inventory.includes(itemId)) return res.status(400).json({ error: `You don't own ${itemId}` });
    }
  }
  if (myFlux > user.flux) return res.status(400).json({ error: 'Not enough Flux' });

  const id = uuidv4();
  await db.run('INSERT INTO trades (id, from_user_id, to_user_id, from_items, to_items, from_flux, to_flux) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, req.session.userId, toUserId, JSON.stringify(myItems || []), JSON.stringify(theirItems || []), myFlux || 0, theirFlux || 0);
  await addNotification(toUserId, 'trade', 'sent you a trade offer', req.session.userId);
  res.json({ success: true, tradeId: id });
});

app.get('/api/trade/pending', requireAuth, async (req, res) => {
  const trades = await db.all(`
    SELECT t.*, u.username as from_username, u.avatar_color as from_color
    FROM trades t JOIN users u ON t.from_user_id = u.id
    WHERE t.to_user_id = ? AND t.status = 'pending'
  `, req.session.userId);
  res.json({ trades });
});

app.post('/api/trade/accept', requireAuth, async (req, res) => {
  const { tradeId } = req.body;
  const trade = await db.get('SELECT * FROM trades WHERE id = ? AND to_user_id = ? AND status = ?', tradeId, req.session.userId, 'pending');
  if (!trade) return res.status(404).json({ error: 'Trade not found' });

  const fromUser = await db.get('SELECT inventory, flux FROM users WHERE id = ?', trade.from_user_id);
  const toUser = await db.get('SELECT inventory, flux FROM users WHERE id = ?', trade.to_user_id);

  let fromInv = []; try { fromInv = JSON.parse(fromUser.inventory || '[]'); } catch(e) {}
  let toInv = []; try { toInv = JSON.parse(toUser.inventory || '[]'); } catch(e) {}
  let fromItems = []; try { fromItems = JSON.parse(trade.from_items || '[]'); } catch(e) {}
  let toItems = []; try { toItems = JSON.parse(trade.to_items || '[]'); } catch(e) {}

  for (const itemId of fromItems) {
    fromInv = fromInv.filter(i => i !== itemId);
    toInv.push(itemId);
  }
  for (const itemId of toItems) {
    toInv = toInv.filter(i => i !== itemId);
    fromInv.push(itemId);
  }

  if (trade.from_flux > 0) {
    if (fromUser.flux < trade.from_flux) return res.status(400).json({ error: 'Trader does not have enough Flux' });
    await addFlux(trade.from_user_id, -trade.from_flux, `Trade with ${toUser.username}`);
    await addFlux(req.session.userId, trade.from_flux, `Trade with ${fromUser.username}`);
  }
  if (trade.to_flux > 0) {
    if (toUser.flux < trade.to_flux) return res.status(400).json({ error: 'You do not have enough Flux' });
    await addFlux(req.session.userId, -trade.to_flux, `Trade with ${fromUser.username}`);
    await addFlux(trade.from_user_id, trade.to_flux, `Trade with ${toUser.username}`);
  }

  await db.run('UPDATE users SET inventory = ? WHERE id = ?', JSON.stringify(fromInv), trade.from_user_id);
  await db.run('UPDATE users SET inventory = ? WHERE id = ?', JSON.stringify(toInv), req.session.userId);
  await db.run('UPDATE trades SET status = ? WHERE id = ?', 'accepted', tradeId);
  res.json({ success: true });
});

app.post('/api/trade/decline', requireAuth, async (req, res) => {
  const { tradeId } = req.body;
  await db.run('UPDATE trades SET status = ? WHERE id = ? AND to_user_id = ?', 'declined', tradeId, req.session.userId);
  res.json({ success: true });
});

// --- Comments ---
app.post('/api/games/:id/comments', requireAuth, async (req, res) => {
  const { text, rating } = req.body;
  if (!text || text.trim().length === 0) return res.status(400).json({ error: 'Comment required' });
  const game = await db.get('SELECT id, owner_id FROM games WHERE id = ?', req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const id = uuidv4();
  await db.run('INSERT INTO comments (id, game_id, user_id, text, rating) VALUES (?, ?, ?, ?, ?)', id, req.params.id, req.session.userId, text.trim(), rating || 5);
  if (game.owner_id !== req.session.userId) {
    await addNotification(game.owner_id, 'comment', `New comment on "${game.name}"`, req.session.userId);
  }
  res.json({ success: true, commentId: id });
});

app.get('/api/games/:id/comments', async (req, res) => {
  const comments = await db.all(`
    SELECT c.*, u.username, u.avatar_color
    FROM comments c JOIN users u ON c.user_id = u.id
    WHERE c.game_id = ? ORDER BY c.created_at DESC LIMIT 50
  `, req.params.id);
  res.json({ comments });
});

// --- Notifications ---
app.get('/api/notifications', requireAuth, async (req, res) => {
  const notifications = await db.all(`
    SELECT n.*, u.username as from_username, u.avatar_color as from_color
    FROM notifications n LEFT JOIN users u ON n.from_user_id = u.id
    WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 30
  `, req.session.userId);
  const unread = await db.get('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0', req.session.userId);
  res.json({ notifications, unread: unread.count });
});

app.post('/api/notifications/read', requireAuth, async (req, res) => {
  await db.run('UPDATE notifications SET read = 1 WHERE user_id = ?', req.session.userId);
  res.json({ success: true });
});

// --- Favorites ---
app.post('/api/games/:id/favorite', requireAuth, async (req, res) => {
  const game = await db.get('SELECT id FROM games WHERE id = ?', req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const existing = await db.get('SELECT * FROM favorites WHERE user_id = ? AND game_id = ?', req.session.userId, req.params.id);
  if (existing) {
    await db.run('DELETE FROM favorites WHERE user_id = ? AND game_id = ?', req.session.userId, req.params.id);
    res.json({ success: true, favorited: false });
  } else {
    await db.run('INSERT INTO favorites (user_id, game_id) VALUES (?, ?)', req.session.userId, req.params.id);
    res.json({ success: true, favorited: true });
  }
});

app.get('/api/games/:id/favorite', requireAuth, async (req, res) => {
  const fav = await db.get('SELECT * FROM favorites WHERE user_id = ? AND game_id = ?', req.session.userId, req.params.id);
  res.json({ favorited: !!fav });
});

app.get('/api/my-favorites', requireAuth, async (req, res) => {
  const games = await db.all(`
    SELECT g.*, u.username as owner_name, u.avatar_color as owner_color
    FROM favorites f JOIN games g ON f.game_id = g.id JOIN users u ON g.owner_id = u.id
    WHERE f.user_id = ? ORDER BY f.created_at DESC
  `, req.session.userId);
  res.json({ games });
});

// --- Global Search ---
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 2) return res.json({ users: [], games: [] });
  const users = await db.all('SELECT id, username, avatar_color FROM users WHERE username LIKE ? LIMIT 10', `%${q}%`);
  const games = await db.all(`
    SELECT g.id, g.name, g.plays, g.likes, g.genre, u.username as owner_name
    FROM games g JOIN users u ON g.owner_id = u.id
    WHERE g.name LIKE ? ORDER BY g.plays DESC LIMIT 10
  `, `%${q}%`);
  res.json({ users, games });
});

// --- User Profile ---
app.get('/api/users/:id', async (req, res) => {
  const user = await db.get('SELECT id, username, avatar_color, avatar_data, premium, premium_expires, created_at FROM users WHERE id = ?', req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  let avatarData = {};
  try { avatarData = JSON.parse(user.avatar_data || '{}'); } catch(e) {}
  const isPremium = user.premium === 1 && user.premium_expires && new Date(user.premium_expires) > new Date();
  const games = await db.all('SELECT id, name, plays, likes, genre, updated_at FROM games WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 20', req.params.id);
  const gameCount = await db.get('SELECT COUNT(*) as count FROM games WHERE owner_id = ?', req.params.id);
  const totalPlays = await db.get('SELECT COALESCE(SUM(plays), 0) as total FROM games WHERE owner_id = ?', req.params.id);
  const friendCount = await db.get('SELECT COUNT(*) as count FROM friends WHERE (user_id = ? OR friend_id = ?) AND status = \'accepted\'', req.params.id, req.params.id);
  res.json({ user: { ...user, avatar_data: avatarData, isPremium }, games, stats: { gameCount: gameCount.count, totalPlays: totalPlays.total, friendCount: friendCount.count } });
});

// --- Groups ---
app.post('/api/groups', requireAuth, async (req, res) => {
  const { name, description, icon, color } = req.body;
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Group name must be 2+ characters' });
  if (name.length > 30) return res.status(400).json({ error: 'Group name max 30 characters' });
  const existing = await db.get('SELECT id FROM groups WHERE name = ?', name.trim());
  if (existing) return res.status(400).json({ error: 'Group name taken' });
  const id = uuidv4();
  await db.run('INSERT INTO groups (id, name, description, owner_id, icon, color) VALUES (?, ?, ?, ?, ?, ?)', id, name.trim(), description || '', req.session.userId, icon || '🎮', color || '#00a2ff');
  await db.run('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)', id, req.session.userId, 'owner');
  res.json({ success: true, group: { id, name: name.trim() } });
});

app.get('/api/groups', async (req, res) => {
  const groups = await db.all(`
    SELECT g.*, u.username as owner_name, u.avatar_color as owner_color
    FROM groups g JOIN users u ON g.owner_id = u.id
    ORDER BY g.member_count DESC LIMIT 50
  `);
  res.json({ groups });
});

app.get('/api/groups/mine', requireAuth, async (req, res) => {
  const groups = await db.all(`
    SELECT g.*, u.username as owner_name, gm.role
    FROM group_members gm
    JOIN groups g ON gm.group_id = g.id
    JOIN users u ON g.owner_id = u.id
    WHERE gm.user_id = ?
    ORDER BY gm.joined_at DESC
  `, req.session.userId);
  res.json({ groups });
});

app.get('/api/groups/:id', async (req, res) => {
  const group = await db.get(`
    SELECT g.*, u.username as owner_name, u.avatar_color as owner_color
    FROM groups g JOIN users u ON g.owner_id = u.id WHERE g.id = ?
  `, req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const members = await db.all(`
    SELECT gm.*, u.username, u.avatar_color, u.premium, u.premium_expires
    FROM group_members gm JOIN users u ON gm.user_id = u.id
    WHERE gm.group_id = ? ORDER BY gm.role DESC, gm.joined_at ASC
  `, req.params.id);
  const memberList = members.map(m => ({
    ...m,
    is_premium: m.premium === 1 && m.premium_expires && new Date(m.premium_expires) > new Date()
  }));
  const isMember = members.some(m => m.user_id === req.session.userId);
  const userRole = isMember ? members.find(m => m.user_id === req.session.userId)?.role : null;
  res.json({ group, members: memberList, isMember, userRole });
});

app.post('/api/groups/:id/join', requireAuth, async (req, res) => {
  const group = await db.get('SELECT id FROM groups WHERE id = ?', req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const existing = await db.get('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?', req.params.id, req.session.userId);
  if (existing) return res.status(400).json({ error: 'Already a member' });
  await db.run('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)', req.params.id, req.session.userId, 'member');
  await db.run('UPDATE groups SET member_count = member_count + 1 WHERE id = ?', req.params.id);
  const g = await db.get('SELECT owner_id, name FROM groups WHERE id = ?', req.params.id);
  if (g && g.owner_id !== req.session.userId) {
    await addNotification(g.owner_id, 'group_join', `joined your group "${g.name}"`, req.session.userId);
  }
  res.json({ success: true });
});

app.post('/api/groups/:id/leave', requireAuth, async (req, res) => {
  const member = await db.get('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?', req.params.id, req.session.userId);
  if (!member) return res.status(400).json({ error: 'Not a member' });
  if (member.role === 'owner') return res.status(400).json({ error: 'Owner cannot leave. Transfer ownership first.' });
  await db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', req.params.id, req.session.userId);
  await db.run('UPDATE groups SET member_count = member_count - 1 WHERE id = ?', req.params.id);
  res.json({ success: true });
});

app.post('/api/groups/:id/kick', requireAuth, async (req, res) => {
  const { userId } = req.body;
  const caller = await db.get('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', req.params.id, req.session.userId);
  if (!caller || (caller.role !== 'owner' && caller.role !== 'admin')) return res.status(403).json({ error: 'Not authorized' });
  const target = await db.get('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', req.params.id, userId);
  if (!target) return res.status(404).json({ error: 'User not in group' });
  if (target.role === 'owner') return res.status(400).json({ error: 'Cannot kick owner' });
  await db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', req.params.id, userId);
  await db.run('UPDATE groups SET member_count = member_count - 1 WHERE id = ?', req.params.id);
  res.json({ success: true });
});

app.post('/api/groups/:id/role', requireAuth, async (req, res) => {
  const { userId, role } = req.body;
  const caller = await db.get('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', req.params.id, req.session.userId);
  if (!caller || caller.role !== 'owner') return res.status(403).json({ error: 'Only owner can change roles' });
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  await db.run('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?', role, req.params.id, userId);
  res.json({ success: true });
});

app.put('/api/groups/:id', requireAuth, async (req, res) => {
  const group = await db.get('SELECT * FROM groups WHERE id = ?', req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.owner_id !== req.session.userId) return res.status(403).json({ error: 'Not authorized' });
  const { name, description, icon, color } = req.body;
  await db.run('UPDATE groups SET name = COALESCE(?, name), description = COALESCE(?, description), icon = COALESCE(?, icon), color = COALESCE(?, color) WHERE id = ?',
    name, description, icon, color, req.params.id);
  res.json({ success: true });
});

app.delete('/api/groups/:id', requireAuth, async (req, res) => {
  const group = await db.get('SELECT * FROM groups WHERE id = ?', req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.owner_id !== req.session.userId) return res.status(403).json({ error: 'Not authorized' });
  await db.run('DELETE FROM group_members WHERE group_id = ?', req.params.id);
  await db.run('DELETE FROM groups WHERE id = ?', req.params.id);
  res.json({ success: true });
});

app.get('/api/groups/search', async (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 2) return res.json({ groups: [] });
  const groups = await db.all(`
    SELECT g.*, u.username as owner_name
    FROM groups g JOIN users u ON g.owner_id = u.id
    WHERE g.name LIKE ? ORDER BY g.member_count DESC LIMIT 20
  `, `%${q}%`);
  res.json({ groups });
});

// --- Trade History ---
app.get('/api/trade/history', requireAuth, async (req, res) => {
  const trades = await db.all(`
    SELECT t.*,
      u1.username as from_username, u1.avatar_color as from_color,
      u2.username as to_username, u2.avatar_color as to_color
    FROM trades t
    JOIN users u1 ON t.from_user_id = u1.id
    JOIN users u2 ON t.to_user_id = u2.id
    WHERE (t.from_user_id = ? OR t.to_user_id = ?)
    ORDER BY t.created_at DESC LIMIT 20
  `, req.session.userId, req.session.userId);
  res.json({ trades });
});

// --- Flux Store ---
const GEMZ_BUNDLES = [
  { id: 'starter', name: 'Starter', flux: 100, price: '$0.99' },
  { id: 'value', name: 'Value Pack', flux: 500, price: '$4.99' },
  { id: 'premium', name: 'Premium', flux: 1200, price: '$9.99' },
  { id: 'mega', name: 'Mega Pack', flux: 3000, price: '$19.99' },
  { id: 'ultimate', name: 'Ultimate', flux: 10000, price: '$49.99' },
];

app.get('/api/flux/bundles', (req, res) => {
  res.json({ bundles: GEMZ_BUNDLES });
});

app.post('/api/flux/buy', requireAuth, async (req, res) => {
  const { bundleId } = req.body;
  const bundle = GEMZ_BUNDLES.find(b => b.id === bundleId);
  if (!bundle) return res.status(404).json({ error: 'Bundle not found' });
  await addFlux(req.session.userId, bundle.flux, `Purchased ${bundle.name}`);
  const user = await db.get('SELECT flux FROM users WHERE id = ?', req.session.userId);
  res.json({ success: true, flux: user.flux });
});

app.get('/api/health', (req, res) => res.status(200).send('ok'));

// --- Parties REST ---
app.get('/api/parties', (req, res) => {
  const list = [];
  parties.forEach((p) => list.push({ id: p.id, name: p.name, memberCount: p.members.length, maxMembers: p.maxMembers, owner: p.owner.username, gameId: p.gameId }));
  res.json({ parties: list });
});

process.on('uncaughtException', (err) => { console.error('Uncaught:', err.message); });
process.on('unhandledRejection', (err) => { console.error('Unhandled:', err); });

// Start
initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Arcadia running at http://0.0.0.0:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
