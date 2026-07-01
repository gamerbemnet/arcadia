const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(path.join(DATA_DIR, 'uploads'))) fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'Arcadia.db'));
db.pragma('journal_mode = WAL');

// Auto-backup database
try {
  const backupPath = path.join(DATA_DIR, 'Arcadia.db.backup');
  if (fs.existsSync(path.join(DATA_DIR, 'Arcadia.db'))) {
    fs.copyFileSync(path.join(DATA_DIR, 'Arcadia.db'), backupPath);
    console.log('Database backed up');
  }
} catch(e) { console.log('Backup skipped:', e.message); }

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
`);

// Migrate gemz -> flux column names
try { db.exec("ALTER TABLE users RENAME COLUMN gemz TO flux"); } catch(e) {}
try { db.exec("ALTER TABLE trades RENAME COLUMN from_gemz TO from_flux"); } catch(e) {}
try { db.exec("ALTER TABLE trades RENAME COLUMN to_gemz TO to_flux"); } catch(e) {}

// Add premium columns
try { db.exec("ALTER TABLE users ADD COLUMN premium INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN premium_expires TEXT"); } catch(e) {}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
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

const onlineUsers = new Map();

wss.on('connection', (ws, req) => {
  let userId = null;
  let username = null;
  let avatarColor = '#00a2ff';

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'auth') {
        userId = msg.userId;
        username = msg.username;
        avatarColor = msg.avatarColor || '#00a2ff';
        onlineUsers.set(userId, { ws, username, avatarColor });
        broadcastOnline();
      } else if (msg.type === 'chat' && userId) {
        const id = uuidv4();
        const channel = msg.channel || 'global';
        db.prepare('INSERT INTO chat_messages (id, user_id, channel, message) VALUES (?, ?, ?, ?)').run(id, userId, channel, msg.message);
        const chatMsg = JSON.stringify({ type: 'chat', user: username, avatarColor, message: msg.message, channel, timestamp: Date.now() });
        if (channel === 'global') {
          wss.clients.forEach(c => { if (c.readyState === 1) c.send(chatMsg); });
        } else {
          const target = onlineUsers.get(channel);
          if (target && target.ws.readyState === 1) target.ws.send(chatMsg);
          ws.send(chatMsg);
        }
      } else if (msg.type === 'typing' && userId) {
        const target = onlineUsers.get(msg.channel);
        if (target && target.ws.readyState === 1) {
          target.ws.send(JSON.stringify({ type: 'typing', user: username }));
        }
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    if (userId) onlineUsers.delete(userId);
    broadcastOnline();
  });
});

function broadcastOnline() {
  const users = [];
  onlineUsers.forEach((v, k) => users.push({ id: k, username: v.username, avatarColor: v.avatarColor }));
  const msg = JSON.stringify({ type: 'online', users });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

app.get('/api/chat/history', (req, res) => {
  const channel = req.query.channel || 'global';
  const messages = db.prepare(`
    SELECT c.*, u.username, u.avatar_color
    FROM chat_messages c JOIN users u ON c.user_id = u.id
    WHERE c.channel = ? ORDER BY c.created_at DESC LIMIT 50
  `).all(channel).reverse();
  res.json({ messages });
});

app.post('/api/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Username must be 3-20 characters' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) return res.status(400).json({ error: 'Username or email already taken' });

  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  const colors = ['#00a2ff','#e74c3c','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#3498db','#ff6b6b','#00cec9','#6c5ce7','#fd79a8'];
  const color = colors[Math.floor(Math.random() * colors.length)];

  db.prepare('INSERT INTO users (id, username, email, password, avatar_color) VALUES (?, ?, ?, ?, ?)').run(id, username, email, hash, color);
  req.session.userId = id;
  res.json({ success: true, user: { id, username, email, avatar_color: color } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
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

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare('SELECT id, username, email, avatar_color, avatar_data, inventory, flux, premium, premium_expires, created_at FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  let avatarData = {};
  try { avatarData = JSON.parse(user.avatar_data || '{}'); } catch(e) {}
  let inventory = [];
  try { inventory = JSON.parse(user.inventory || '[]'); } catch(e) {}
  const isPremium = user.premium === 1 && user.premium_expires && new Date(user.premium_expires) > new Date();
  res.json({ user: { ...user, avatar_data: avatarData, inventory, isPremium } });
});

app.get('/api/friends', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const friends = db.prepare(`
    SELECT u.id, u.username, u.avatar_color
    FROM friends f
    JOIN users u ON (u.id = f.friend_id AND f.user_id = ?) OR (u.id = f.user_id AND f.friend_id = ?)
    WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 'accepted'
  `).all(userId, userId, userId, userId);
  const pending = db.prepare(`
    SELECT u.id, u.username, u.avatar_color, f.user_id as from_user_id
    FROM friends f
    JOIN users u ON u.id = f.user_id
    WHERE f.friend_id = ? AND f.status = 'pending'
  `).all(userId);
  res.json({ friends, pending });
});

app.post('/api/friends/add', requireAuth, (req, res) => {
  const { username } = req.body;
  const target = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.session.userId) return res.status(400).json({ error: 'Cannot add yourself' });

  const existing = db.prepare('SELECT * FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)').get(req.session.userId, target.id, target.id, req.session.userId);
  if (existing) return res.status(400).json({ error: 'Friend request already exists' });

  db.prepare('INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)').run(req.session.userId, target.id, 'pending');
  res.json({ success: true });
});

app.post('/api/friends/accept', requireAuth, (req, res) => {
  const { userId } = req.body;
  db.prepare('UPDATE friends SET status = ? WHERE user_id = ? AND friend_id = ?').run('accepted', userId, req.session.userId);
  const existing = db.prepare('SELECT * FROM friends WHERE user_id = ? AND friend_id = ?').get(req.session.userId, userId);
  if (!existing) {
    db.prepare('INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)').run(req.session.userId, userId, 'accepted');
  }
  res.json({ success: true });
});

app.post('/api/friends/remove', requireAuth, (req, res) => {
  const { userId } = req.body;
  db.prepare('DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)').run(req.session.userId, userId, userId, req.session.userId);
  res.json({ success: true });
});

app.get('/api/users/search', requireAuth, (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ users: [] });
  const users = db.prepare('SELECT id, username, avatar_color FROM users WHERE username LIKE ? AND id != ? LIMIT 10').all(`%${q}%`, req.session.userId);
  res.json({ users });
});

app.get('/api/games', (req, res) => {
  const games = db.prepare(`
    SELECT g.*, u.username as owner_name, u.avatar_color as owner_color
    FROM games g JOIN users u ON g.owner_id = u.id
    ORDER BY g.plays DESC LIMIT 50
  `).all();
  res.json({ games });
});

app.get('/api/games/:id', (req, res) => {
  const game = db.prepare(`
    SELECT g.*, u.username as owner_name, u.avatar_color as owner_color
    FROM games g JOIN users u ON g.owner_id = u.id
    WHERE g.id = ?
  `).get(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  res.json({ game });
});

app.post('/api/games', requireAuth, (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Game name required' });
  const id = uuidv4();
  db.prepare('INSERT INTO games (id, owner_id, name, description) VALUES (?, ?, ?, ?)').run(id, req.session.userId, name, description || '');
  res.json({ success: true, game: { id, name } });
});

app.put('/api/games/:id', requireAuth, (req, res) => {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (game.owner_id !== req.session.userId) return res.status(403).json({ error: 'Not authorized' });

  const { name, description, data, genre } = req.body;
  db.prepare('UPDATE games SET name = COALESCE(?, name), description = COALESCE(?, description), data = COALESCE(?, data), genre = COALESCE(?, genre), updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(name, description, data ? JSON.stringify(data) : null, genre, req.params.id);
  res.json({ success: true });
});

app.delete('/api/games/:id', requireAuth, (req, res) => {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (game.owner_id !== req.session.userId) return res.status(403).json({ error: 'Not authorized' });
  db.prepare('DELETE FROM games WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/games/:id/play', (req, res) => {
  db.prepare('UPDATE games SET plays = plays + 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/games/:id/like', requireAuth, (req, res) => {
  db.prepare('UPDATE games SET likes = likes + 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/my-games', requireAuth, (req, res) => {
  const games = db.prepare('SELECT * FROM games WHERE owner_id = ? ORDER BY updated_at DESC').all(req.session.userId);
  res.json({ games });
});

// Avatar routes
app.get('/api/avatar', requireAuth, (req, res) => {
  const user = db.prepare('SELECT avatar_data, avatar_color FROM users WHERE id = ?').get(req.session.userId);
  let data = {};
  try { data = JSON.parse(user.avatar_data || '{}'); } catch(e) {}
  res.json({ avatar: data, color: user.avatar_color });
});

app.put('/api/avatar', requireAuth, (req, res) => {
  const { avatar, color } = req.body;
  if (avatar) {
    db.prepare('UPDATE users SET avatar_data = ? WHERE id = ?').run(JSON.stringify(avatar), req.session.userId);
  }
  if (color) {
    db.prepare('UPDATE users SET avatar_color = ? WHERE id = ?').run(color, req.session.userId);
  }
  res.json({ success: true });
});

app.get('/api/users/:id/avatar', (req, res) => {
  const user = db.prepare('SELECT avatar_data, avatar_color, username FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  let data = {};
  try { data = JSON.parse(user.avatar_data || '{}'); } catch(e) {}
  res.json({ avatar: data, color: user.avatar_color, username: user.username });
});

// Leaderboard routes
app.get('/api/leaderboard/games', (req, res) => {
  const games = db.prepare(`
    SELECT g.id, g.name, g.plays, g.likes, g.genre, u.username as owner_name, u.avatar_color as owner_color
    FROM games g JOIN users u ON g.owner_id = u.id
    ORDER BY g.plays DESC LIMIT 20
  `).all();
  res.json({ games });
});

app.get('/api/leaderboard/creators', (req, res) => {
  const creators = db.prepare(`
    SELECT u.id, u.username, u.avatar_color,
      COUNT(g.id) as game_count,
      COALESCE(SUM(g.plays), 0) as total_plays,
      COALESCE(SUM(g.likes), 0) as total_likes
    FROM users u
    LEFT JOIN games g ON g.owner_id = u.id
    GROUP BY u.id
    ORDER BY total_plays DESC LIMIT 20
  `).all();
  res.json({ creators });
});

app.get('/api/leaderboard/popular', (req, res) => {
  const games = db.prepare(`
    SELECT g.id, g.name, g.plays, g.likes, g.genre, u.username as owner_name, u.avatar_color as owner_color
    FROM games g JOIN users u ON g.owner_id = u.id
    ORDER BY g.likes DESC LIMIT 20
  `).all();
  res.json({ games });
});

// Shop items
const SHOP_ITEMS = [
  { id: 'crown_gold', name: 'Golden Crown', price: 100, category: 'hat', preview: '👑' },
  { id: 'crown_diamond', name: 'Diamond Crown', price: 250, category: 'hat', preview: '💎' },
  { id: 'tophat_purple', name: 'Purple Top Hat', price: 150, category: 'hat', preview: '🎩' },
  { id: 'hat_wizard', name: 'Wizard Hat', price: 200, category: 'hat', preview: '🧙' },
  { id: 'headphones_gold', name: 'Gold Headphones', price: 180, category: 'hat', preview: '🎧' },
  { id: 'halo_golden', name: 'Golden Halo', price: 300, category: 'hat', preview: '😇' },
  { id: 'sword_flame', name: 'Flame Sword', price: 200, category: 'accessory', preview: '🔥' },
  { id: 'sword_ice', name: 'Ice Sword', price: 200, category: 'accessory', preview: '❄️' },
  { id: 'shield_gold', name: 'Gold Shield', price: 175, category: 'accessory', preview: '🛡️' },
  { id: 'wings_angel', name: 'Angel Wings', price: 350, category: 'accessory', preview: '😇' },
  { id: 'wings_demon', name: 'Demon Wings', price: 350, category: 'accessory', preview: '😈' },
  { id: 'cape_royal', name: 'Royal Cape', price: 150, category: 'accessory', preview: '👑' },
  { id: 'backpack_gold', name: 'Gold Backpack', price: 120, category: 'accessory', preview: '🎒' },
  { id: 'face_ninja', name: 'Ninja Face', price: 80, category: 'face', preview: '🥷' },
  { id: 'face_robot', name: 'Robot Face', price: 100, category: 'face', preview: '🤖' },
  { id: 'face_skull', name: 'Skull Face', price: 120, category: 'face', preview: '💀' },
  { id: 'color_neon_green', name: 'Neon Green Body', price: 150, category: 'color', preview: '🟢', value: '#39ff14' },
  { id: 'color_neon_pink', name: 'Neon Pink Body', price: 150, category: 'color', preview: '🩷', value: '#ff1493' },
  { id: 'color_gold', name: 'Gold Body', price: 250, category: 'color', preview: '🥇', value: '#ffd700' },
  { id: 'color_rainbow', name: 'Rainbow Body', price: 500, category: 'color', preview: '🌈', value: '#ff0000' },
];

app.get('/api/shop', (req, res) => {
  res.json({ items: SHOP_ITEMS });
});

app.get('/api/shop/my-items', requireAuth, (req, res) => {
  const user = db.prepare('SELECT inventory FROM users WHERE id = ?').get(req.session.userId);
  let inventory = [];
  try { inventory = JSON.parse(user.inventory || '[]'); } catch(e) {}
  res.json({ inventory });
});

app.post('/api/shop/buy', requireAuth, (req, res) => {
  const { itemId } = req.body;
  const item = SHOP_ITEMS.find(i => i.id === itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const user = db.prepare('SELECT flux, inventory FROM users WHERE id = ?').get(req.session.userId);
  let inventory = [];
  try { inventory = JSON.parse(user.inventory || '[]'); } catch(e) {}

  if (inventory.includes(itemId)) return res.status(400).json({ error: 'Already owned' });
  if (user.flux < item.price) return res.status(400).json({ error: 'Not enough flux' });

  inventory.push(itemId);
  db.prepare('UPDATE users SET flux = flux - ?, inventory = ? WHERE id = ?').run(item.price, JSON.stringify(inventory), req.session.userId);
  addFlux(req.session.userId, -item.price, `Bought ${item.name}`);
  res.json({ success: true, flux: user.flux - item.price });
});

app.post('/api/shop/equip', requireAuth, (req, res) => {
  const { itemId } = req.body;
  const item = SHOP_ITEMS.find(i => i.id === itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const user = db.prepare('SELECT inventory, avatar_data FROM users WHERE id = ?').get(req.session.userId);
  let inventory = [];
  try { inventory = JSON.parse(user.inventory || '[]'); } catch(e) {}
  let avatarData = {};
  try { avatarData = JSON.parse(user.avatar_data || '{}'); } catch(e) {}

  if (!inventory.includes(itemId)) return res.status(400).json({ error: 'Not owned' });

  if (item.category === 'hat') avatarData.hat = itemId.replace(/^(crown_|tophat_|hat_|headphones_|halo_)/, '');
  else if (item.category === 'accessory') avatarData.accessory = itemId.replace(/^(sword_|shield_|wings_|cape_|backpack_)/, '');
  else if (item.category === 'face') avatarData.face = itemId.replace('face_', '');
  else if (item.category === 'color' && item.value) avatarData.bodyColor = item.value;

  db.prepare('UPDATE users SET avatar_data = ? WHERE id = ?').run(JSON.stringify(avatarData), req.session.userId);
  res.json({ success: true, avatar: avatarData });
});

// --- Currency: Flux ---
function addFlux(userId, amount, description, type = 'earn') {
  const id = uuidv4();
  db.prepare('UPDATE users SET flux = flux + ? WHERE id = ?').run(amount, userId);
  db.prepare('INSERT INTO transactions (id, user_id, type, amount, description) VALUES (?, ?, ?, ?, ?)').run(id, userId, type, amount, description);
}

app.get('/api/flux', requireAuth, (req, res) => {
  const user = db.prepare('SELECT flux FROM users WHERE id = ?').get(req.session.userId);
  res.json({ flux: user.flux });
});

app.post('/api/flux/claim-daily', requireAuth, (req, res) => {
  const user = db.prepare('SELECT flux, premium, premium_expires FROM users WHERE id = ?').get(req.session.userId);
  const isPremium = user.premium === 1 && user.premium_expires && new Date(user.premium_expires) > new Date();
  const bonus = isPremium ? 100 : 50;
  addFlux(req.session.userId, bonus, isPremium ? 'Daily bonus (Premium 2x)' : 'Daily login bonus');
  const updated = db.prepare('SELECT flux FROM users WHERE id = ?').get(req.session.userId);
  res.json({ success: true, flux: updated.flux, earned: bonus, isPremium });
});

app.get('/api/flux/transactions', requireAuth, (req, res) => {
  const txns = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.session.userId);
  res.json({ transactions: txns });
});

// --- Premium Membership ---
const PREMIUM_PLANS = [
  { id: 'monthly', name: 'Premium Monthly', price: '$4.99/mo', days: 30, flux: 500 },
  { id: 'yearly', name: 'Premium Yearly', price: '$39.99/yr', days: 365, flux: 6000 },
];

app.get('/api/premium/plans', (req, res) => {
  res.json({ plans: PREMIUM_PLANS });
});

app.get('/api/premium/status', requireAuth, (req, res) => {
  const user = db.prepare('SELECT premium, premium_expires FROM users WHERE id = ?').get(req.session.userId);
  const isPremium = user.premium === 1 && user.premium_expires && new Date(user.premium_expires) > new Date();
  res.json({ isPremium, expires: user.premium_expires });
});

app.post('/api/premium/subscribe', requireAuth, (req, res) => {
  const { planId } = req.body;
  const plan = PREMIUM_PLANS.find(p => p.id === planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const user = db.prepare('SELECT premium, premium_expires FROM users WHERE id = ?').get(req.session.userId);
  let expires = new Date();
  if (user.premium === 1 && user.premium_expires && new Date(user.premium_expires) > new Date()) {
    expires = new Date(user.premium_expires);
  }
  expires.setDate(expires.getDate() + plan.days);

  db.prepare('UPDATE users SET premium = 1, premium_expires = ? WHERE id = ?').run(expires.toISOString(), req.session.userId);
  addFlux(req.session.userId, plan.flux, `Premium bonus: ${plan.name}`);
  const updated = db.prepare('SELECT flux, premium, premium_expires FROM users WHERE id = ?').get(req.session.userId);
  res.json({ success: true, flux: updated.flux, expires: updated.premium_expires });
});

app.post('/api/premium/cancel', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET premium = 0, premium_expires = NULL WHERE id = ?').run(req.session.userId);
  res.json({ success: true });
});

// --- Assets ---
const ASSET_TYPES = ['avatar', 'model', 'texture', 'mesh', 'audio', 'script'];

app.post('/api/assets/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { name, type, preview } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'Name and type required' });
  if (!ASSET_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid asset type' });

  const user = db.prepare('SELECT flux FROM users WHERE id = ?').get(req.session.userId);
  if (user.flux < 10) return res.status(400).json({ error: 'Not enough Flux (10 required)' });

  const id = uuidv4();
  const filepath = `/${req.file.path.replace(/\\/g, '/')}`;
  db.prepare('INSERT INTO assets (id, user_id, name, type, filename, filepath, preview, flux_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.session.userId, name, type, req.file.filename, filepath, preview || '', 10);
  addFlux(req.session.userId, -10, `Uploaded asset: ${name}`);

  const updated = db.prepare('SELECT flux FROM users WHERE id = ?').get(req.session.userId);
  res.json({ success: true, asset: { id, name, type, filepath }, flux: updated.flux });
});

app.get('/api/assets', (req, res) => {
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

  const assets = db.prepare(query).all(...params);
  res.json({ assets });
});

app.get('/api/assets/:id', (req, res) => {
  const asset = db.prepare(`
    SELECT a.*, u.username, u.avatar_color
    FROM assets a JOIN users u ON a.user_id = u.id WHERE a.id = ?
  `).get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  res.json({ asset });
});

app.post('/api/assets/:id/download', (req, res) => {
  db.prepare('UPDATE assets SET downloads = downloads + 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.delete('/api/assets/:id', requireAuth, (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (asset.user_id !== req.session.userId) return res.status(403).json({ error: 'Not authorized' });

  const filePath = path.join(__dirname, asset.filepath);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  db.prepare('DELETE FROM assets WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Earn flux for game milestones
app.post('/api/games/:id/play', (req, res) => {
  db.prepare('UPDATE games SET plays = plays + 1 WHERE id = ?').run(req.params.id);
  const game = db.prepare('SELECT owner_id, plays FROM games WHERE id = ?').get(req.params.id);
  if (game && game.plays % 10 === 0) {
    addFlux(game.owner_id, 5, `Game milestone: ${game.plays} plays`);
  }
  res.json({ success: true });
});

app.post('/api/games/:id/like', requireAuth, (req, res) => {
  db.prepare('UPDATE games SET likes = likes + 1 WHERE id = ?').run(req.params.id);
  const game = db.prepare('SELECT owner_id FROM games WHERE id = ?').get(req.params.id);
  if (game) {
    addFlux(game.owner_id, 2, 'Someone liked your game');
  }
  addFlux(req.session.userId, 1, 'Liked a game');
  res.json({ success: true });
});

// Trading
app.post('/api/trade/send', requireAuth, (req, res) => {
  const { toUserId, myItems, myFlux, theirItems, theirFlux } = req.body;
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(toUserId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (toUserId === req.session.userId) return res.status(400).json({ error: 'Cannot trade with yourself' });

  const user = db.prepare('SELECT inventory, flux FROM users WHERE id = ?').get(req.session.userId);
  let inventory = [];
  try { inventory = JSON.parse(user.inventory || '[]'); } catch(e) {}

  if (myItems && myItems.length > 0) {
    for (const itemId of myItems) {
      if (!inventory.includes(itemId)) return res.status(400).json({ error: `You don't own ${itemId}` });
    }
  }
  if (myFlux > user.flux) return res.status(400).json({ error: 'Not enough Flux' });

  const id = uuidv4();
  db.prepare('INSERT INTO trades (id, from_user_id, to_user_id, from_items, to_items, from_flux, to_flux) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.session.userId, toUserId, JSON.stringify(myItems || []), JSON.stringify(theirItems || []), myFlux || 0, theirFlux || 0);
  res.json({ success: true, tradeId: id });
});

app.get('/api/trade/pending', requireAuth, (req, res) => {
  const trades = db.prepare(`
    SELECT t.*, u.username as from_username, u.avatar_color as from_color
    FROM trades t JOIN users u ON t.from_user_id = u.id
    WHERE t.to_user_id = ? AND t.status = 'pending'
  `).all(req.session.userId);
  res.json({ trades });
});

app.post('/api/trade/accept', requireAuth, (req, res) => {
  const { tradeId } = req.body;
  const trade = db.prepare('SELECT * FROM trades WHERE id = ? AND to_user_id = ? AND status = ?').get(tradeId, req.session.userId, 'pending');
  if (!trade) return res.status(404).json({ error: 'Trade not found' });

  const fromUser = db.prepare('SELECT inventory, flux FROM users WHERE id = ?').get(trade.from_user_id);
  const toUser = db.prepare('SELECT inventory, flux FROM users WHERE id = ?').get(trade.to_user_id);

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
    addFlux(trade.from_user_id, -trade.from_flux, `Trade with ${toUser.username}`);
    addFlux(req.session.userId, trade.from_flux, `Trade with ${fromUser.username}`);
  }
  if (trade.to_flux > 0) {
    if (toUser.flux < trade.to_flux) return res.status(400).json({ error: 'You do not have enough Flux' });
    addFlux(req.session.userId, -trade.to_flux, `Trade with ${fromUser.username}`);
    addFlux(trade.from_user_id, trade.to_flux, `Trade with ${toUser.username}`);
  }

  db.prepare('UPDATE users SET inventory = ? WHERE id = ?').run(JSON.stringify(fromInv), trade.from_user_id);
  db.prepare('UPDATE users SET inventory = ? WHERE id = ?').run(JSON.stringify(toInv), req.session.userId);
  db.prepare('UPDATE trades SET status = ? WHERE id = ?').run('accepted', tradeId);
  res.json({ success: true });
});

app.post('/api/trade/decline', requireAuth, (req, res) => {
  const { tradeId } = req.body;
  db.prepare('UPDATE trades SET status = ? WHERE id = ? AND to_user_id = ?').run('declined', tradeId, req.session.userId);
  res.json({ success: true });
});

// Flux store (real money)
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

app.post('/api/flux/buy', requireAuth, (req, res) => {
  const { bundleId } = req.body;
  const bundle = GEMZ_BUNDLES.find(b => b.id === bundleId);
  if (!bundle) return res.status(404).json({ error: 'Bundle not found' });
  addFlux(req.session.userId, bundle.flux, `Purchased ${bundle.name}`);
  const user = db.prepare('SELECT flux FROM users WHERE id = ?').get(req.session.userId);
  res.json({ success: true, flux: user.flux });
});

app.get('/health', (req, res) => res.status(200).send('ok'));

process.on('uncaughtException', (err) => { console.error('Uncaught:', err.message); });
process.on('unhandledRejection', (err) => { console.error('Unhandled:', err); });

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Arcadia running at http://0.0.0.0:${PORT}`);
});


