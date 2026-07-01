const API = '';
let currentUser = null;
let ws = null;
let onlineUsers = [];
let chatOpen = false;
let allShopItems = [];

async function api(url, options = {}) {
  const res = await fetch(API + url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return res.json();
}

// --- Sidebar ---
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('collapsed');
}

function scrollToSection(id) {
  document.querySelectorAll('.sidebar-item[data-section]').forEach(i => i.classList.toggle('active', i.dataset.section === id));
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
}

function scrollToTop() { window.scrollTo({ top: 0, behavior: 'smooth' }); }

// --- Screens ---
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
  const el = document.getElementById('screen-' + name);
  if (el) el.style.display = 'block';
  const isAuth = name === 'login' || name === 'register';
  document.getElementById('topbar').style.display = isAuth ? 'none' : 'flex';
  document.getElementById('sidebar').style.display = isAuth ? 'none' : 'flex';
  document.getElementById('app-page').style.display = isAuth ? 'none' : 'block';
}

// --- Auth ---
async function checkAuth() {
  const data = await api('/api/me');
  if (data.user) {
    currentUser = data.user;
    initApp();
  } else {
    showScreen('login');
  }
}

function initApp() {
  showScreen('app');
  document.getElementById('user-name').textContent = currentUser.username;
  document.getElementById('user-avatar').style.background = currentUser.avatar_color;
  document.getElementById('user-avatar').textContent = currentUser.username[0].toUpperCase();
  document.getElementById('flux-display').textContent = currentUser.flux || 0;
  if (currentUser.isPremium) {
    document.getElementById('premium-badge').style.display = 'inline';
    document.getElementById('premium-banner').style.display = 'none';
  } else {
    document.getElementById('premium-badge').style.display = 'none';
    document.getElementById('premium-banner').style.display = 'block';
  }
  connectWS();
  loadHomeGames();
  loadShopItems();
  loadLeaderboardTab('popular');
}

async function login() {
  const username = document.getElementById('login-user').value;
  const password = document.getElementById('login-pass').value;
  const err = document.getElementById('login-error');
  err.textContent = '';
  const data = await api('/api/login', { method: 'POST', body: { username, password } });
  if (data.error) { err.textContent = data.error; return; }
  currentUser = data.user;
  initApp();
}

async function register() {
  const username = document.getElementById('reg-user').value;
  const email = document.getElementById('reg-email').value;
  const password = document.getElementById('reg-pass').value;
  const err = document.getElementById('reg-error');
  err.textContent = '';
  const data = await api('/api/register', { method: 'POST', body: { username, email, password } });
  if (data.error) { err.textContent = data.error; return; }
  currentUser = data.user;
  initApp();
}

async function logout() {
  if (ws) ws.close();
  await api('/api/logout', { method: 'POST' });
  currentUser = null;
  showScreen('login');
}

// --- WebSocket ---
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', userId: currentUser.id, username: currentUser.username, avatarColor: currentUser.avatar_color }));
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'chat') appendChat(msg);
    if (msg.type === 'online') { onlineUsers = msg.users; updateOnlineCount(); }
    if (msg.type === 'typing') showTyping(msg.user);
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
}

// --- Chat ---
function toggleChat() {
  chatOpen = !chatOpen;
  document.getElementById('chat-panel').classList.toggle('open', chatOpen);
  if (chatOpen) loadChatHistory();
}

function loadChatHistory() {
  api('/api/chat/history?channel=global').then(data => {
    const el = document.getElementById('chat-messages');
    el.innerHTML = '';
    data.messages.forEach(m => appendChat({ user: m.username, avatarColor: m.avatar_color, message: m.message, timestamp: new Date(m.created_at).getTime() }));
    el.scrollTop = el.scrollHeight;
  });
}

function appendChat(msg) {
  const el = document.getElementById('chat-messages');
  const time = new Date(msg.timestamp || Date.now());
  const t = time.getHours().toString().padStart(2, '0') + ':' + time.getMinutes().toString().padStart(2, '0');
  el.innerHTML += `
    <div class="chat-msg">
      <div class="avatar" style="background:${msg.avatarColor || '#00a2ff'}">${(msg.user || '?')[0].toUpperCase()}</div>
      <div class="content">
        <span class="user">${esc(msg.user)}</span>
        <div class="text">${esc(msg.message)}</div>
      </div>
    </div>`;
  el.scrollTop = el.scrollHeight;
}

function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg || !ws) return;
  ws.send(JSON.stringify({ type: 'chat', message: msg, channel: 'global' }));
  input.value = '';
  document.getElementById('typing-indicator').textContent = '';
}

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('chat-input');
  if (input) input.addEventListener('input', () => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'typing', channel: 'global' }));
  });
});

let typingTimeout;
function showTyping(user) {
  const el = document.getElementById('typing-indicator');
  el.textContent = user + ' is typing...';
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => el.textContent = '', 2000);
}

function updateOnlineCount() {
  document.getElementById('online-count').textContent = onlineUsers.length + ' online';
}

// --- Games ---
function gameCard(g, owned = false) {
  const thumbColors = ['#00a2ff','#e74c3c','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#ff6b6b'];
  const color = thumbColors[Math.abs(hashStr(g.name)) % thumbColors.length];
  return `
    <div class="game-card" onclick="playGame('${g.id}')">
      <div class="game-thumb" style="background:linear-gradient(135deg, ${color}, ${color}dd)">
        <span class="game-icon">🎮</span>
        <span class="game-badge">${g.genre || 'Adventure'}</span>
      </div>
      <div class="game-info">
        <div class="game-name">${esc(g.name)}</div>
        <div class="game-meta">
          <span class="plays">▶ ${formatNum(g.plays)}</span>
          <span>❤ ${formatNum(g.likes)}</span>
        </div>
        ${owned ? `
        <div class="game-actions" onclick="event.stopPropagation()" style="margin-top:8px;display:flex;gap:4px">
          <button class="btn btn-sm btn-primary" onclick="editGame('${g.id}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteGame('${g.id}')">Delete</button>
        </div>` : ''}
      </div>
    </div>`;
}

async function loadHomeGames() {
  const data = await api('/api/games');
  const games = data.games || [];
  const popular = [...games].sort((a, b) => b.plays - a.plays).slice(0, 10);
  const recent = [...games].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 10);

  const popularEl = document.getElementById('home-popular');
  const recentEl = document.getElementById('home-recent');

  if (popular.length === 0) {
    popularEl.innerHTML = '<p style="color:#999;padding:20px">No games yet. Create the first one!</p>';
    recentEl.innerHTML = '';
    return;
  }
  popularEl.innerHTML = popular.map(g => gameCard(g)).join('');
  recentEl.innerHTML = recent.map(g => gameCard(g)).join('');
}

async function loadMyGames() {
  const data = await api('/api/my-games');
  const grid = document.getElementById('my-games-list');
  const noMsg = document.getElementById('no-games-msg');
  if (!data.games || data.games.length === 0) {
    grid.innerHTML = '';
    noMsg.style.display = 'block';
    return;
  }
  noMsg.style.display = 'none';
  grid.innerHTML = data.games.map(g => gameCard(g, true)).join('');
}

function createGame() {
  const name = document.getElementById('new-game-name').value;
  const desc = document.getElementById('new-game-desc').value;
  if (!name) return;
  api('/api/games', { method: 'POST', body: { name, description: desc } }).then(data => {
    if (data.success) {
      document.getElementById('create-modal').classList.remove('active');
      document.getElementById('new-game-name').value = '';
      document.getElementById('new-game-desc').value = '';
      window.location.href = `/editor.html?id=${data.game.id}`;
    }
  });
}

function playGame(id) { window.location.href = `/play.html?id=${id}`; }
function editGame(id) { window.location.href = `/editor.html?id=${id}`; }

async function deleteGame(id) {
  if (!confirm('Delete this game? This cannot be undone.')) return;
  await api(`/api/games/${id}`, { method: 'DELETE' });
  loadMyGames();
  showToast('Game deleted');
}

function showAllGames() { scrollToSection('sec-chart'); }

// --- Friends ---
async function loadFriends() {
  const data = await api('/api/friends');
  const list = document.getElementById('friends-list');
  const pending = document.getElementById('pending-list');
  const badge = document.getElementById('notif-badge');

  if (data.pending.length > 0) {
    badge.style.display = 'flex';
    badge.textContent = data.pending.length;
  } else {
    badge.style.display = 'none';
  }

  list.innerHTML = data.friends.length === 0
    ? '<p style="color:#999;font-size:13px">No friends yet. Search for players above!</p>'
    : data.friends.map(f => `
      <div class="friend-item">
        <div class="friend-avatar" style="background:${f.avatar_color}">${f.username[0].toUpperCase()}</div>
        <span class="name">${esc(f.username)}</span>
        <button class="btn btn-sm btn-danger" onclick="removeFriend('${f.id}')">Remove</button>
      </div>
    `).join('');

  pending.innerHTML = data.pending.length === 0
    ? '<p style="color:#999;font-size:13px">No pending requests</p>'
    : data.pending.map(f => `
      <div class="friend-item">
        <div class="friend-avatar" style="background:${f.avatar_color}">${f.username[0].toUpperCase()}</div>
        <span class="name">${esc(f.username)}</span>
        <button class="btn btn-sm btn-success" onclick="acceptFriend('${f.from_user_id}')">Accept</button>
        <button class="btn btn-sm btn-danger" onclick="removeFriend('${f.from_user_id}')">Decline</button>
      </div>
    `).join('');
}

async function searchUsers() {
  const q = document.getElementById('friend-search').value;
  if (!q) { document.getElementById('search-results').innerHTML = ''; return; }
  const data = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
  document.getElementById('search-results').innerHTML = data.users.map(u => `
    <div class="friend-item">
      <div class="friend-avatar" style="background:${u.avatar_color}">${u.username[0].toUpperCase()}</div>
      <span class="name">${esc(u.username)}</span>
      <button class="btn btn-sm btn-primary" onclick="addFriend('${u.username}')">Add</button>
    </div>
  `).join('');
}

async function addFriend(username) {
  const data = await api('/api/friends/add', { method: 'POST', body: { username } });
  showToast(data.error || 'Friend request sent!');
}

async function acceptFriend(userId) {
  await api('/api/friends/accept', { method: 'POST', body: { userId } });
  loadFriends();
}

async function removeFriend(userId) {
  await api('/api/friends/remove', { method: 'POST', body: { userId } });
  loadFriends();
}

// --- Shop ---
async function loadShopItems() {
  const data = await api('/api/shop');
  allShopItems = data.items || [];
}

async function loadShopTab(category, btn) {
  document.querySelectorAll('#sec-shop .tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const items = allShopItems.filter(i => i.category === category);
  const ownedData = await api('/api/shop/my-items');
  const owned = ownedData.inventory || [];
  const grid = document.getElementById('shop-items');
  grid.innerHTML = items.map(item => `
    <div class="game-card" style="cursor:default">
      <div class="game-thumb" style="background:linear-gradient(135deg, #1a1a2e, #16213e);font-size:48px;display:flex;align-items:center;justify-content:center">
        ${item.preview}
      </div>
      <div class="game-info">
        <div class="game-name">${esc(item.name)}</div>
        <div class="game-meta">
          <span style="color:var(--primary);font-weight:700">⚡ ${item.price}</span>
        </div>
        <div style="margin-top:8px">
          ${owned.includes(item.id)
            ? `<button class="btn btn-sm btn-success" onclick="equipItem('${item.id}')">Equip</button>`
            : `<button class="btn btn-sm btn-primary" onclick="buyItem('${item.id}')">Buy</button>`
          }
        </div>
      </div>
    </div>
  `).join('');
}

async function buyItem(itemId) {
  const data = await api('/api/shop/buy', { method: 'POST', body: { itemId } });
  if (data.error) { showToast(data.error); return; }
  currentUser.flux = data.flux;
  document.getElementById('flux-display').textContent = data.flux;
  showToast('Item purchased!');
  const cat = allShopItems.find(i => i.id === itemId)?.category || 'hat';
  loadShopTab(cat);
}

async function equipItem(itemId) {
  const data = await api('/api/shop/equip', { method: 'POST', body: { itemId } });
  if (data.error) { showToast(data.error); return; }
  if (data.avatar) currentUser.avatar_data = data.avatar;
  showToast('Item equipped!');
}

async function claimDaily() {
  const data = await api('/api/flux/claim-daily', { method: 'POST' });
  if (data.error) { showToast(data.error); return; }
  currentUser.flux = data.flux;
  document.getElementById('flux-display').textContent = data.flux;
  showToast(`+${data.earned}⚡ Daily bonus claimed!`);
}

// --- Leaderboard ---
async function loadLeaderboardTab(tab) {
  const el = document.getElementById('chart-games');
  const creatorsEl = document.getElementById('chart-creators');
  el.innerHTML = '<p style="color:#999;text-align:center;padding:20px">Loading...</p>';
  creatorsEl.innerHTML = '';

  const [gamesData, creatorsData] = await Promise.all([
    api(`/api/leaderboard/${tab}`),
    api('/api/leaderboard/creators')
  ]);

  el.innerHTML = (gamesData.games || []).map((g, i) => `
    <div style="display:flex;align-items:center;gap:12px;background:var(--card);padding:12px 16px;border-radius:var(--radius);box-shadow:var(--shadow);margin-bottom:8px;cursor:pointer" onclick="playGame('${g.id}')">
      <span style="font-size:18px;font-weight:900;width:28px;text-align:center;color:${i < 3 ? ['#ffd700','#c0c0c0','#cd7f32'][i] : '#999'}">${i < 3 ? ['🥇','🥈','🥉'][i] : '#' + (i + 1)}</span>
      <div class="friend-avatar" style="background:${g.owner_color};width:34px;height:34px;font-size:13px">${g.owner_name[0].toUpperCase()}</div>
      <div style="flex:1">
        <div style="font-weight:700;font-size:13px">${esc(g.name)}</div>
        <div style="font-size:11px;color:#999">by ${esc(g.owner_name)} · ${g.genre}</div>
      </div>
      <div style="text-align:right">
        <div style="font-weight:700;color:var(--primary);font-size:13px">▶ ${formatNum(g.plays)}</div>
        <div style="font-size:11px;color:#999">❤ ${formatNum(g.likes)}</div>
      </div>
    </div>
  `).join('');

  creatorsEl.innerHTML = (creatorsData.creators || []).map((c, i) => `
    <div style="display:flex;align-items:center;gap:12px;background:var(--card);padding:12px 16px;border-radius:var(--radius);box-shadow:var(--shadow);margin-bottom:8px">
      <span style="font-size:18px;font-weight:900;width:28px;text-align:center;color:${i < 3 ? ['#ffd700','#c0c0c0','#cd7f32'][i] : '#999'}">${i < 3 ? ['🥇','🥈','🥉'][i] : '#' + (i + 1)}</span>
      <div class="friend-avatar" style="background:${c.avatar_color};width:34px;height:34px;font-size:13px">${c.username[0].toUpperCase()}</div>
      <div style="flex:1">
        <div style="font-weight:700;font-size:13px">${esc(c.username)}</div>
        <div style="font-size:11px;color:#999">${c.game_count} games created</div>
      </div>
      <div style="text-align:right">
        <div style="font-weight:700;color:var(--primary);font-size:13px">▶ ${formatNum(c.total_plays)}</div>
        <div style="font-size:11px;color:#999">❤ ${formatNum(c.total_likes)}</div>
      </div>
    </div>
  `).join('');
}

// --- Avatar Editor ---
let avatarData = {
  bodyColor: '#00a2ff',
  face: 'smile',
  hat: 'none',
  accessory: 'none'
};

const BODY_COLORS = [
  '#00a2ff','#e74c3c','#2ecc71','#f39c12','#9b59b6','#1abc9c',
  '#e67e22','#e91e63','#00bcd4','#8bc34a','#ff5722','#607d8b',
  '#795548','#ff9800','#4caf50','#2196f3','#f44336','#673ab7',
  '#009688','#cddc39','#ff6b6b','#ffd93d','#c084fc','#38bdf8'
];

const FACES = [
  { id: 'smile', label: '😊' },
  { id: 'cool', label: '😎' },
  { id: 'laugh', label: '😂' },
  { id: 'angry', label: '😠' },
  { id: 'wink', label: '😉' },
  { id: 'star', label: '⭐' }
];

const HATS = [
  { id: 'none', label: 'None' },
  { id: 'crown', label: '👑 Crown' },
  { id: 'cap', label: '🧢 Cap' },
  { id: 'tophat', label: '🎩 Top Hat' },
  { id: 'headphones', label: '🎧 Headphones' },
  { id: 'halo', label: '😇 Halo' }
];

const ACCESSORIES = [
  { id: 'none', label: 'None' },
  { id: 'sword', label: '⚔️ Sword' },
  { id: 'shield', label: '🛡️ Shield' },
  { id: 'wings', label: '🦋 Wings' },
  { id: 'cape', label: '🧣 Cape' },
  { id: 'backpack', label: '🎒 Backpack' }
];

async function loadAvatarEditor() {
  const data = await api('/api/avatar');
  if (data.avatar) avatarData = { ...avatarData, ...data.avatar };
  if (data.color) avatarData.bodyColor = data.color;

  document.getElementById('color-picker').innerHTML = BODY_COLORS.map(c => `
    <div onclick="setAvatarColor('${c}')" class="color-swatch ${c === avatarData.bodyColor ? 'active' : ''}" style="background:${c}"></div>
  `).join('');

  document.getElementById('face-picker').innerHTML = FACES.map(f => `
    <button class="option-btn ${f.id === avatarData.face ? 'active' : ''}" onclick="setAvatarFace('${f.id}')">${f.label}</button>
  `).join('');

  document.getElementById('hat-picker').innerHTML = HATS.map(h => `
    <button class="option-btn ${h.id === avatarData.hat ? 'active' : ''}" onclick="setAvatarHat('${h.id}')">${h.label}</button>
  `).join('');

  document.getElementById('acc-picker').innerHTML = ACCESSORIES.map(a => `
    <button class="option-btn ${a.id === avatarData.accessory ? 'active' : ''}" onclick="setAvatarAccessory('${a.id}')">${a.label}</button>
  `).join('');

  renderAvatarPreview();
}

function setAvatarColor(color) {
  avatarData.bodyColor = color;
  document.querySelectorAll('#color-picker .color-swatch').forEach(s => s.classList.remove('active'));
  event.target.classList.add('active');
  renderAvatarPreview();
}

function setAvatarFace(id) {
  avatarData.face = id;
  document.querySelectorAll('#face-picker .option-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  renderAvatarPreview();
}

function setAvatarHat(id) {
  avatarData.hat = id;
  document.querySelectorAll('#hat-picker .option-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  renderAvatarPreview();
}

function setAvatarAccessory(id) {
  avatarData.accessory = id;
  document.querySelectorAll('#acc-picker .option-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  renderAvatarPreview();
}

function renderAvatarPreview() {
  const canvas = document.getElementById('avatar-preview');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const cx = 140, cy = 180;
  ctx.clearRect(0, 0, 280, 380);

  ctx.fillStyle = 'rgba(0,0,0,0.1)';
  ctx.beginPath(); ctx.ellipse(cx, 350, 45, 10, 0, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = avatarData.bodyColor;
  roundRect(ctx, cx - 32, cy + 20, 64, 72, 8);

  ctx.fillStyle = darkenColor(avatarData.bodyColor, 30);
  ctx.fillRect(cx - 25, cy + 87, 20, 42);
  ctx.fillRect(cx + 5, cy + 87, 20, 42);

  ctx.fillStyle = '#333';
  ctx.fillRect(cx - 27, cy + 122, 24, 8);
  ctx.fillRect(cx + 3, cy + 122, 24, 8);

  ctx.fillStyle = avatarData.bodyColor;
  ctx.fillRect(cx - 48, cy + 25, 16, 50);
  ctx.fillRect(cx + 32, cy + 25, 16, 50);

  ctx.fillStyle = lightenColor(avatarData.bodyColor, 20);
  ctx.beginPath(); ctx.arc(cx - 40, cy + 77, 8, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + 40, cy + 77, 8, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = avatarData.bodyColor;
  ctx.beginPath(); ctx.arc(cx, cy - 12, 38, 0, Math.PI * 2); ctx.fill();

  drawFace(ctx, cx, cy - 12, avatarData.face);
  drawHat(ctx, cx, cy - 50, avatarData.hat);
  drawAccessory(ctx, cx, cy, avatarData.accessory);
}

function drawFace(ctx, cx, cy, face) {
  switch(face) {
    case 'smile':
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(cx - 12, cy - 5, 5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + 12, cy - 5, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#333';
      ctx.beginPath(); ctx.arc(cx - 12, cy - 4, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + 12, cy - 4, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#333'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy + 7, 12, 0.1 * Math.PI, 0.9 * Math.PI); ctx.stroke();
      break;
    case 'cool':
      ctx.fillStyle = '#333';
      ctx.fillRect(cx - 20, cy - 8, 40, 9);
      ctx.fillStyle = '#00a2ff';
      ctx.fillRect(cx - 16, cy - 7, 14, 7);
      ctx.fillRect(cx + 2, cy - 7, 14, 7);
      ctx.strokeStyle = '#333'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy + 7, 12, 0.1 * Math.PI, 0.9 * Math.PI); ctx.stroke();
      break;
    case 'laugh':
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(cx - 12, cy - 7, 5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + 12, cy - 7, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#333';
      ctx.beginPath(); ctx.arc(cx - 12, cy - 6, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + 12, cy - 6, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#333';
      ctx.beginPath(); ctx.ellipse(cx, cy + 8, 12, 9, 0, 0, Math.PI); ctx.fill();
      ctx.fillStyle = '#e74c3c';
      ctx.beginPath(); ctx.ellipse(cx, cy + 8, 8, 5, 0, 0, Math.PI); ctx.fill();
      break;
    case 'angry':
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(cx - 12, cy - 3, 5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + 12, cy - 3, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e74c3c';
      ctx.beginPath(); ctx.arc(cx - 12, cy - 2, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + 12, cy - 2, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#333'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx - 16, cy - 14); ctx.lineTo(cx - 7, cy - 10); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + 16, cy - 14); ctx.lineTo(cx + 7, cy - 10); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy + 8, 7, 0.2 * Math.PI, 0.8 * Math.PI); ctx.stroke();
      break;
    case 'wink':
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(cx - 12, cy - 5, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#333';
      ctx.beginPath(); ctx.arc(cx - 12, cy - 4, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#333'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx + 12, cy - 4, 5, 0, Math.PI); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy + 7, 10, 0.1 * Math.PI, 0.9 * Math.PI); ctx.stroke();
      break;
    case 'star':
      ctx.fillStyle = '#ffd93d';
      drawStar(ctx, cx, cy - 5, 5, 10, 5);
      ctx.fillStyle = '#333';
      ctx.beginPath(); ctx.arc(cx - 5, cy - 7, 2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + 5, cy - 7, 2, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#333'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy + 4, 7, 0.1 * Math.PI, 0.9 * Math.PI); ctx.stroke();
      break;
  }
}

function drawStar(ctx, cx, cy, spikes, outerR, innerR) {
  let rot = Math.PI / 2 * 3;
  const step = Math.PI / spikes;
  ctx.beginPath();
  ctx.moveTo(cx, cy - outerR);
  for (let i = 0; i < spikes; i++) {
    ctx.lineTo(cx + Math.cos(rot) * outerR, cy + Math.sin(rot) * outerR);
    rot += step;
    ctx.lineTo(cx + Math.cos(rot) * innerR, cy + Math.sin(rot) * innerR);
    rot += step;
  }
  ctx.closePath(); ctx.fill();
}

function drawHat(ctx, cx, cy, hat) {
  switch(hat) {
    case 'crown':
      ctx.fillStyle = '#ffd93d';
      ctx.fillRect(cx - 22, cy, 44, 13);
      ctx.beginPath(); ctx.moveTo(cx - 22, cy); ctx.lineTo(cx - 17, cy - 13); ctx.lineTo(cx - 12, cy); ctx.fill();
      ctx.beginPath(); ctx.moveTo(cx - 8, cy); ctx.lineTo(cx, cy - 18); ctx.lineTo(cx + 8, cy); ctx.fill();
      ctx.beginPath(); ctx.moveTo(cx + 12, cy); ctx.lineTo(cx + 17, cy - 13); ctx.lineTo(cx + 22, cy); ctx.fill();
      ctx.fillStyle = '#e74c3c';
      ctx.beginPath(); ctx.arc(cx - 12, cy + 4, 3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy + 4, 3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + 12, cy + 4, 3, 0, Math.PI * 2); ctx.fill();
      break;
    case 'cap':
      ctx.fillStyle = '#e74c3c';
      ctx.beginPath(); ctx.ellipse(cx, cy + 4, 30, 10, 0, Math.PI, 0); ctx.fill();
      ctx.fillRect(cx - 30, cy, 60, 7);
      ctx.fillStyle = '#c0392b';
      ctx.fillRect(cx - 33, cy + 3, 18, 5);
      break;
    case 'tophat':
      ctx.fillStyle = '#333';
      ctx.fillRect(cx - 17, cy - 35, 34, 38);
      ctx.fillRect(cx - 24, cy, 48, 8);
      ctx.fillStyle = '#e74c3c';
      ctx.fillRect(cx - 17, cy - 2, 34, 5);
      break;
    case 'headphones':
      ctx.strokeStyle = '#333'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(cx, cy - 8, 32, Math.PI, 0); ctx.stroke();
      ctx.fillStyle = '#333';
      roundRect(ctx, cx - 36, cy - 6, 12, 18, 3);
      roundRect(ctx, cx + 24, cy - 6, 12, 18, 3);
      ctx.fillStyle = '#00a2ff';
      roundRect(ctx, cx - 33, cy - 3, 7, 11, 2);
      roundRect(ctx, cx + 26, cy - 3, 7, 11, 2);
      break;
    case 'halo':
      ctx.strokeStyle = '#ffd93d'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(cx, cy - 26, 24, 7, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#ffd93d88'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(cx, cy - 29, 24, 7, 0, 0, Math.PI * 2); ctx.stroke();
      break;
  }
}

function drawAccessory(ctx, cx, cy, acc) {
  switch(acc) {
    case 'sword':
      ctx.fillStyle = '#c0c0c0';
      ctx.fillRect(cx + 44, cy - 8, 5, 44);
      ctx.fillStyle = '#8b4513';
      ctx.fillRect(cx + 38, cy + 32, 16, 7);
      ctx.fillStyle = '#ffd93d';
      ctx.fillRect(cx + 44, cy + 36, 5, 5);
      break;
    case 'shield':
      ctx.fillStyle = '#2196f3';
      ctx.beginPath();
      ctx.moveTo(cx - 56, cy + 10); ctx.lineTo(cx - 38, cy + 10);
      ctx.lineTo(cx - 38, cy + 40); ctx.lineTo(cx - 47, cy + 48);
      ctx.lineTo(cx - 56, cy + 40); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffd93d';
      ctx.beginPath(); ctx.arc(cx - 47, cy + 28, 7, 0, Math.PI * 2); ctx.fill();
      break;
    case 'wings':
      ctx.fillStyle = '#fff'; ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.moveTo(cx - 32, cy + 18); ctx.quadraticCurveTo(cx - 70, cy, cx - 62, cy + 35);
      ctx.quadraticCurveTo(cx - 57, cy + 48, cx - 32, cy + 44); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx + 32, cy + 18); ctx.quadraticCurveTo(cx + 70, cy, cx + 62, cy + 35);
      ctx.quadraticCurveTo(cx + 57, cy + 48, cx + 32, cy + 44); ctx.fill();
      ctx.globalAlpha = 1;
      break;
    case 'cape':
      ctx.fillStyle = '#9b59b6';
      ctx.beginPath();
      ctx.moveTo(cx - 26, cy + 18); ctx.quadraticCurveTo(cx - 40, cy + 70, cx - 22, cy + 105);
      ctx.lineTo(cx + 22, cy + 105); ctx.quadraticCurveTo(cx + 40, cy + 70, cx + 26, cy + 18);
      ctx.closePath(); ctx.fill();
      break;
    case 'backpack':
      ctx.fillStyle = '#e67e22';
      roundRect(ctx, cx - 48, cy + 14, 18, 30, 4);
      ctx.fillStyle = '#d35400';
      ctx.fillRect(cx - 46, cy + 20, 14, 3);
      break;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath(); ctx.fill();
}

function darkenColor(hex, amount) {
  const c = hexToRgb(hex);
  return `rgb(${Math.max(0, c.r - amount)},${Math.max(0, c.g - amount)},${Math.max(0, c.b - amount)})`;
}

function lightenColor(hex, amount) {
  const c = hexToRgb(hex);
  return `rgb(${Math.min(255, c.r + amount)},${Math.min(255, c.g + amount)},${Math.min(255, c.b + amount)})`;
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
}

async function saveAvatar() {
  const data = await api('/api/avatar', {
    method: 'PUT',
    body: { avatar: avatarData, color: avatarData.bodyColor }
  });
  if (data.success) {
    currentUser.avatar_color = avatarData.bodyColor;
    document.getElementById('user-avatar').style.background = avatarData.bodyColor;
    showToast('Avatar saved!');
  }
}

// --- Utils ---
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h); return h; }
function formatNum(n) { if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'; if (n >= 1000) return (n / 1000).toFixed(1) + 'K'; return n; }
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// Scroll spy for sidebar
window.addEventListener('scroll', () => {
  if (!currentUser) return;
  const sections = ['sec-home', 'sec-chart', 'sec-creations', 'sec-friends', 'sec-shop', 'sec-avatar'];
  let current = sections[0];
  for (const id of sections) {
    const el = document.getElementById(id);
    if (el && el.getBoundingClientRect().top <= 120) current = id;
  }
  document.querySelectorAll('.sidebar-item[data-section]').forEach(i => i.classList.toggle('active', i.dataset.section === current));
});

// Load friends and avatar when their sections come into view
const sectionObserver = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (!e.isIntersecting) return;
    if (e.target.id === 'sec-friends') loadFriends();
    if (e.target.id === 'sec-avatar') loadAvatarEditor();
    if (e.target.id === 'sec-creations') loadMyGames();
  });
}, { threshold: 0.1 });

document.addEventListener('DOMContentLoaded', () => {
  ['sec-friends', 'sec-avatar', 'sec-creations'].forEach(id => {
    const el = document.getElementById(id);
    if (el) sectionObserver.observe(el);
  });
});

// --- Premium ---
function openPremiumModal() {
  document.getElementById('premium-modal').classList.add('active');
  loadPremiumPlans();
}

async function loadPremiumPlans() {
  const data = await api('/api/premium/plans');
  const el = document.getElementById('premium-plans');
  el.innerHTML = (data.plans || []).map(p => `
    <div class="plan-card ${p.id === 'yearly' ? 'recommended' : ''}" id="plan-${p.id}">
      <div>
        <div class="plan-name">${p.name} ${p.id === 'yearly' ? '<span class="plan-tag">BEST VALUE</span>' : ''}</div>
        <div class="plan-price">${p.price}</div>
        <div class="plan-bonus">+${p.flux} Flux welcome bonus</div>
      </div>
      <div class="paypal-btn-container" id="paypal-btn-${p.id}"></div>
    </div>
  `).join('');

  data.plans.forEach(p => {
    paypal.Buttons({
      style: { layout: 'horizontal', color: 'gold', shape: 'rect', label: 'paypal', height: 36 },
      createOrder: (data, actions) => {
        return actions.order.create({
          purchase_units: [{ description: `Arcadia ${p.name}`, amount: { value: p.price.replace('$','').replace('/mo','').replace('/yr','') } }]
        });
      },
      onApprove: async (data, actions) => {
        const details = await actions.order.capture();
        const res = await api('/api/premium/subscribe', { method: 'POST', body: { planId: p.id } });
        if (res.success) {
          currentUser.flux = res.flux;
          currentUser.isPremium = true;
          document.getElementById('flux-display').textContent = res.flux;
          document.getElementById('premium-badge').style.display = 'inline';
          document.getElementById('premium-banner').style.display = 'none';
          document.getElementById('premium-modal').classList.remove('active');
          showToast('Welcome to Premium! 👑');
        }
      },
      onError: () => showToast('Payment failed. Try again.')
    }).render(`#paypal-btn-${p.id}`);
  });
}

checkAuth();
