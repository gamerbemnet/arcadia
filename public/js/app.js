const API = '';
let currentUser = null;
let ws = null;
let onlineUsers = [];
let chatOpen = false;
let allShopItems = [];
let currentCommentGameId = null;

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
  loadNotifications();
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
    if (msg.type === 'party_joined') handlePartyJoined(msg.party);
    if (msg.type === 'party_left') handlePartyLeft();
    if (msg.type === 'party_update') handlePartyUpdate(msg.party);
    if (msg.type === 'party_kicked') handlePartyKicked();
    if (msg.type === 'party_error') showToast(msg.error);
    if (msg.type === 'chat_error') {
      if (msg.reason === 'links_not_allowed') showToast('Links are not allowed in chat');
      else if (msg.reason === 'spam_detected') showToast('Slow down! Spam detected');
      else if (msg.reason === 'too_long') showToast('Message too long');
      else showToast('Message blocked by filter');
    }
    if (msg.type === 'voice_offer' || msg.type === 'voice_answer' || msg.type === 'voice_ice') handleVoiceSignal(msg);
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
    data.messages.forEach(m => appendChat({ user: m.username, avatarColor: m.avatar_color, message: m.message, timestamp: new Date(m.created_at).getTime(), isPremium: m.is_premium }));
    el.scrollTop = el.scrollHeight;
  });
}

function appendChat(msg) {
  const el = document.getElementById('chat-messages');
  const time = new Date(msg.timestamp || Date.now());
  const t = time.getHours().toString().padStart(2, '0') + ':' + time.getMinutes().toString().padStart(2, '0');
  const isPremium = msg.isPremium;
  el.innerHTML += `
    <div class="chat-msg">
      <div class="avatar" style="background:${msg.avatarColor || '#00a2ff'}">${(msg.user || '?')[0].toUpperCase()}</div>
      <div class="content">
        <span class="user">${esc(msg.user)}${isPremium ? ' <span style="background:linear-gradient(135deg,#ffd700,#ffaa00);color:#333;padding:1px 5px;border-radius:4px;font-size:9px;font-weight:700;vertical-align:middle">👑</span>' : ''}</span>
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

// --- Notifications ---
let notifOpen = false;
function toggleNotifications() {
  notifOpen = !notifOpen;
  document.getElementById('notif-dropdown').classList.toggle('open', notifOpen);
  if (notifOpen) loadNotifications();
}
function openNotifications() { toggleNotifications(); }

async function loadNotifications() {
  const data = await api('/api/notifications');
  const badge = document.getElementById('notif-badge');
  const list = document.getElementById('notif-list');
  const unread = data.unread || 0;
  if (unread > 0) { badge.style.display = 'flex'; badge.textContent = unread; }
  else { badge.style.display = 'none'; }
  const notifs = data.notifications || [];
  if (notifs.length === 0) {
    list.innerHTML = '<p style="padding:20px;text-align:center;color:#999;font-size:13px">No notifications</p>';
    return;
  }
  const icons = { comment: '💬', like: '❤️', friend_request: '👋', friend_accept: '🤝', trade: '🔄' };
  list.innerHTML = notifs.map(n => `
    <div class="notif-item ${n.read ? '' : 'unread'}">
      ${n.read ? '' : '<div class="notif-dot"></div>'}
      <div style="font-size:18px">${icons[n.type] || '📢'}</div>
      <div class="notif-text">${esc(n.message)}${n.from_username ? ` <b>${esc(n.from_username)}</b>` : ''}</div>
      <div class="notif-time">${timeAgo(n.created_at)}</div>
    </div>
  `).join('');
}

async function markAllRead() {
  await api('/api/notifications/read', { method: 'POST' });
  loadNotifications();
}

function timeAgo(d) {
  const s = Math.floor((Date.now() - new Date(d)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
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
        <div style="display:flex;gap:4px;margin-top:6px">
          <button class="btn btn-sm btn-primary" onclick="event.stopPropagation();likeGame('${g.id}')" style="font-size:11px;padding:3px 8px">❤ Like</button>
          <button class="btn btn-sm" onclick="event.stopPropagation();openComments('${g.id}')" style="font-size:11px;padding:3px 8px">💬</button>
          <button class="btn btn-sm" onclick="event.stopPropagation();toggleFavorite('${g.id}')" style="font-size:11px;padding:3px 8px">⭐</button>
        </div>
        ${owned ? `
        <div class="game-actions" onclick="event.stopPropagation()" style="margin-top:8px;display:flex;gap:4px">
          <button class="btn btn-sm btn-primary" onclick="editGame('${g.id}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteGame('${g.id}')">Delete</button>
        </div>` : ''}
      </div>
    </div>`;
}

async function likeGame(id) {
  const data = await api(`/api/games/${id}/like`, { method: 'POST' });
  if (data.error) { showToast(data.error); return; }
  showToast('+1 ❤ Liked!');
  loadHomeGames();
}

async function toggleFavorite(id) {
  const data = await api(`/api/games/${id}/favorite`, { method: 'POST' });
  showToast(data.favorited ? '⭐ Added to favorites' : 'Removed from favorites');
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
  const genre = document.getElementById('new-game-genre').value;
  if (!name) return;
  api('/api/games', { method: 'POST', body: { name, description: desc, genre } }).then(data => {
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
  const sidebarBadge = document.getElementById('friends-badge');

  if (data.pending.length > 0) {
    badge.style.display = 'flex';
    badge.textContent = data.pending.length;
    if (sidebarBadge) { sidebarBadge.style.display = 'flex'; sidebarBadge.textContent = data.pending.length; }
  } else {
    badge.style.display = 'none';
    if (sidebarBadge) sidebarBadge.style.display = 'none';
  }

  list.innerHTML = data.friends.length === 0
    ? '<p style="color:#999;font-size:13px">No friends yet. Search for players above!</p>'
    : data.friends.map(f => `
      <div class="friend-item">
        <div class="friend-avatar" style="background:${f.avatar_color};cursor:pointer" onclick="openProfile('${f.id}')">${f.username[0].toUpperCase()}</div>
        <span class="name" style="cursor:pointer" onclick="openProfile('${f.id}')">${esc(f.username)}</span>
        <button class="btn btn-sm" onclick="openTradeWith('${f.username}')" style="font-size:11px">🔄</button>
        <button class="btn btn-sm btn-danger" onclick="removeFriend('${f.id}')">Remove</button>
      </div>
    `).join('');

  pending.innerHTML = data.pending.length === 0
    ? '<p style="color:#999;font-size:13px">No pending requests</p>'
    : data.pending.map(f => `
      <div class="friend-item">
        <div class="friend-avatar" style="background:${f.avatar_color};cursor:pointer" onclick="openProfile('${f.from_user_id}')">${f.username[0].toUpperCase()}</div>
        <span class="name" style="cursor:pointer" onclick="openProfile('${f.from_user_id}')">${esc(f.username)}</span>
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
  const isPremium = currentUser?.isPremium;
  const items = allShopItems.filter(i => i.category === category && (!i.premium || isPremium));
  const ownedData = await api('/api/shop/my-items');
  const owned = ownedData.inventory || [];
  const grid = document.getElementById('shop-items');
  grid.innerHTML = items.map(item => `
    <div class="game-card" style="cursor:default">
      <div class="game-thumb" style="background:linear-gradient(135deg, ${item.premium ? '#1a1a2e' : '#1a1a2e'}, ${item.premium ? '#2a1a3e' : '#16213e'});font-size:48px;display:flex;align-items:center;justify-content:center;position:relative">
        ${item.preview}
        ${item.premium ? '<span style="position:absolute;top:4px;right:4px;background:linear-gradient(135deg,#ffd700,#ffaa00);color:#333;padding:1px 6px;border-radius:4px;font-size:9px;font-weight:700">👑 PREMIUM</span>' : ''}
      </div>
      <div class="game-info">
        <div class="game-name">${esc(item.name)}</div>
        <div class="game-meta">
          <span style="color:var(--primary);font-weight:700">${item.premium ? '👑 Premium' : '⚡ ' + item.price}</span>
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

// --- User Profile click from topbar ---
function openOwnProfile() {
  if (currentUser) openProfile(currentUser.id);
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
    <div style="display:flex;align-items:center;gap:12px;background:var(--card);padding:12px 16px;border-radius:var(--radius);box-shadow:var(--shadow);margin-bottom:8px;cursor:pointer" onclick="openProfile('${c.id}')">
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
  accessory: 'none',
  hair: 'none',
  shirt: 'none',
  pants: 'none'
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

const HAIR = [
  { id: 'none', label: 'None' },
  { id: 'spiky', label: '💇 Spiky' },
  { id: 'ponytail', label: '💇‍♀️ Ponytail' },
  { id: 'mohawk', label: '🤘 Mohawk' },
  { id: 'afro', label: '🫧 Afro' },
  { id: 'bun', label: '🎀 Bun' }
];

const SHIRTS = [
  { id: 'none', label: 'None' },
  { id: 'hero', label: '🦸 Hero' },
  { id: 'ninja', label: '🥷 Ninja' },
  { id: 'pirate', label: '🏴‍☠️ Pirate' },
  { id: 'space', label: '🚀 Space' },
  { id: 'armor', label: '🛡️ Armor' }
];

const PANTS = [
  { id: 'none', label: 'None' },
  { id: 'jeans', label: '👖 Jeans' },
  { id: 'shorts', label: '🩳 Shorts' },
  { id: 'robe', label: '🧙 Robe' },
  { id: 'armor', label: '🦾 Armor' }
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

  document.getElementById('hair-picker').innerHTML = HAIR.map(h => `
    <button class="option-btn ${h.id === avatarData.hair ? 'active' : ''}" onclick="setAvatarHair('${h.id}')">${h.label}</button>
  `).join('');

  document.getElementById('hat-picker').innerHTML = HATS.map(h => `
    <button class="option-btn ${h.id === avatarData.hat ? 'active' : ''}" onclick="setAvatarHat('${h.id}')">${h.label}</button>
  `).join('');

  document.getElementById('shirt-picker').innerHTML = SHIRTS.map(s => `
    <button class="option-btn ${s.id === avatarData.shirt ? 'active' : ''}" onclick="setAvatarShirt('${s.id}')">${s.label}</button>
  `).join('');

  document.getElementById('pants-picker').innerHTML = PANTS.map(p => `
    <button class="option-btn ${p.id === avatarData.pants ? 'active' : ''}" onclick="setAvatarPants('${p.id}')">${p.label}</button>
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

function setAvatarHair(id) {
  avatarData.hair = id;
  document.querySelectorAll('#hair-picker .option-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  renderAvatarPreview();
}

function setAvatarShirt(id) {
  avatarData.shirt = id;
  document.querySelectorAll('#shirt-picker .option-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  renderAvatarPreview();
}

function setAvatarPants(id) {
  avatarData.pants = id;
  document.querySelectorAll('#pants-picker .option-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  renderAvatarPreview();
}

function renderAvatarPreview() {
  if (typeof render3DAvatar === 'function') {
    render3DAvatar(avatarData);
  }
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

// --- Assets ---
let currentAssetType = 'all';

function openAssetUpload() {
  document.getElementById('asset-upload-modal').classList.add('active');
}

async function uploadAsset() {
  const name = document.getElementById('asset-name').value.trim();
  const type = document.getElementById('asset-type').value;
  const fileInput = document.getElementById('asset-file');
  const err = document.getElementById('asset-upload-error');
  err.textContent = '';

  if (!name) { err.textContent = 'Asset name required'; return; }
  if (!fileInput.files.length) { err.textContent = 'Please select a file'; return; }

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('name', name);
  formData.append('type', type);

  try {
    const res = await fetch('/api/assets/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.error) { err.textContent = data.error; return; }
    currentUser.flux = data.flux;
    document.getElementById('flux-display').textContent = data.flux;
    document.getElementById('asset-upload-modal').classList.remove('active');
    document.getElementById('asset-name').value = '';
    document.getElementById('asset-file').value = '';
    showToast('Asset uploaded! -10 Flux');
    browseAssets(currentAssetType);
  } catch (e) {
    err.textContent = 'Upload failed. Try again.';
  }
}

async function browseAssets(type, btn) {
  currentAssetType = type || 'all';
  if (btn) {
    document.querySelectorAll('#asset-filter-tabs .tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  const search = document.getElementById('asset-search')?.value || '';
  let url = '/api/assets?';
  if (type && type !== 'all') url += `type=${type}&`;
  if (search) url += `search=${encodeURIComponent(search)}`;

  const data = await api(url);
  const grid = document.getElementById('asset-grid');
  const noMsg = document.getElementById('no-assets-msg');
  const assets = data.assets || [];

  if (assets.length === 0) {
    grid.innerHTML = '';
    noMsg.style.display = 'block';
    return;
  }
  noMsg.style.display = 'none';

  const typeIcons = { avatar: '👤', model: '🧊', texture: '🎨', mesh: '🔷', audio: '🎵', script: '📜' };
  const typeColors = { avatar: '#9b59b6', model: '#3498db', texture: '#2ecc71', mesh: '#e67e22', audio: '#e74c3c', script: '#f39c12' };

  grid.innerHTML = assets.map(a => `
    <div class="game-card" style="cursor:default">
      <div class="game-thumb" style="background:linear-gradient(135deg, ${typeColors[a.type] || '#333'}33, ${typeColors[a.type] || '#333'}22);font-size:42px;display:flex;align-items:center;justify-content:center">
        ${a.preview ? `<img src="${esc(a.preview)}" style="max-width:100%;max-height:100%;object-fit:cover">` : typeIcons[a.type] || '📦'}
      </div>
      <div class="game-info">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
          <div class="friend-avatar" style="background:${a.avatar_color};width:22px;height:22px;font-size:9px">${(a.username||'?')[0].toUpperCase()}</div>
          <span style="font-size:11px;color:#999">${esc(a.username)}</span>
        </div>
        <div class="game-name">${esc(a.name)}</div>
        <div class="game-meta">
          <span class="asset-type-badge" style="background:${typeColors[a.type] || '#333'}22;color:${typeColors[a.type] || '#333'};padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600">${a.type}</span>
          <span>⬇ ${a.downloads || 0}</span>
        </div>
        <div style="margin-top:8px;display:flex;gap:4px">
          <button class="btn btn-sm btn-primary" onclick="downloadAsset('${a.id}')">Download</button>
          ${a.user_id === currentUser?.id ? `<button class="btn btn-sm btn-danger" onclick="deleteAsset('${a.id}')">Delete</button>` : ''}
        </div>
      </div>
    </div>
  `).join('');
}

function searchAssets() {
  browseAssets(currentAssetType);
}

async function downloadAsset(id) {
  await api(`/api/assets/${id}/download`, { method: 'POST' });
  showToast('Download counted!');
  browseAssets(currentAssetType);
}

async function deleteAsset(id) {
  if (!confirm('Delete this asset? This cannot be undone.')) return;
  await api(`/api/assets/${id}`, { method: 'DELETE' });
  showToast('Asset deleted');
  browseAssets(currentAssetType);
}

// --- Comments ---
async function openComments(gameId) {
  currentCommentGameId = gameId;
  document.getElementById('comments-modal').classList.add('active');
  loadComments(gameId);
}

async function loadComments(gameId) {
  const data = await api(`/api/games/${gameId}/comments`);
  const list = document.getElementById('comments-list');
  const comments = data.comments || [];
  if (comments.length === 0) {
    list.innerHTML = '<p style="color:#999;text-align:center;padding:20px;font-size:13px">No comments yet. Be the first!</p>';
    return;
  }
  list.innerHTML = comments.map(c => `
    <div class="comment-item">
      <div class="comment-avatar" style="background:${c.avatar_color}">${c.username[0].toUpperCase()}</div>
      <div>
        <div class="comment-meta">
          <b onclick="openProfile('${c.user_id}')" style="cursor:pointer;color:var(--primary)">${esc(c.username)}</b>
          · ${timeAgo(c.created_at)}
          <span class="comment-rating">${'★'.repeat(c.rating)}${'☆'.repeat(5 - c.rating)}</span>
        </div>
        <div class="comment-text">${esc(c.text)}</div>
      </div>
    </div>
  `).join('');
}

async function postComment() {
  const text = document.getElementById('comment-text').value.trim();
  if (!text) return;
  const data = await api(`/api/games/${currentCommentGameId}/comments`, { method: 'POST', body: { text, rating: 5 } });
  if (data.error) { showToast(data.error); return; }
  document.getElementById('comment-text').value = '';
  loadComments(currentCommentGameId);
  showToast('Comment posted!');
}

// --- User Profile ---
async function openProfile(userId) {
  const data = await api(`/api/users/${userId}`);
  if (data.error) { showToast('User not found'); return; }
  const u = data.user;
  const stats = data.stats;
  const games = data.games || [];
  const isPremium = u.isPremium;
  document.getElementById('profile-content').innerHTML = `
    <div class="profile-header">
      <div class="profile-avatar" style="background:${u.avatar_color}">${u.username[0].toUpperCase()}</div>
      <div>
        <div class="profile-name">${esc(u.username)} ${isPremium ? '<span style="background:linear-gradient(135deg,#ffd700,#ffaa00);color:#333;padding:2px 8px;border-radius:8px;font-size:12px;font-weight:700">👑 Premium</span>' : ''}</div>
        <div class="profile-meta">Joined ${new Date(u.created_at).toLocaleDateString()}</div>
        <div class="profile-stats">
          <div class="profile-stat"><strong>${stats.gameCount}</strong> games</div>
          <div class="profile-stat"><strong>${formatNum(stats.totalPlays)}</strong> plays</div>
          <div class="profile-stat"><strong>${stats.friendCount}</strong> friends</div>
        </div>
      </div>
    </div>
    <h4 style="margin-bottom:10px;font-size:14px">Their Games</h4>
    <div style="max-height:200px;overflow-y:auto">
      ${games.length === 0 ? '<p style="color:#999;font-size:13px;text-align:center;padding:16px">No games yet</p>' :
        games.map(g => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #e3e5e7;cursor:pointer" onclick="document.getElementById('profile-modal').classList.remove('active');playGame('${g.id}')">
            <div style="width:40px;height:40px;border-radius:8px;background:linear-gradient(135deg,#00a2ff,#7b2ff7);display:flex;align-items:center;justify-content:center;font-size:18px">🎮</div>
            <div style="flex:1">
              <div style="font-weight:700;font-size:13px">${esc(g.name)}</div>
              <div style="font-size:11px;color:#999">▶ ${formatNum(g.plays)} · ❤ ${formatNum(g.likes)} · ${g.genre}</div>
            </div>
          </div>
        `).join('')}
    </div>
  `;
  document.getElementById('profile-modal').classList.add('active');
}

// --- Trading ---
let myInventory = [];

function openTradeWith(username) {
  scrollToSection('sec-trading');
  setTimeout(() => {
    document.getElementById('trade-target').value = username;
  }, 300);
}

async function loadTradeItems() {
  const data = await api('/api/shop/my-items');
  const owned = data.inventory || [];
  myInventory = owned;
  const shopData = await api('/api/shop');
  const allItems = shopData.items || [];
  const ownedItems = allItems.filter(i => owned.includes(i.id));

  document.getElementById('trade-my-items').innerHTML = ownedItems.map(item => `
    <label class="option-btn" style="display:flex;align-items:center;gap:4px;cursor:pointer">
      <input type="checkbox" value="${item.id}" class="trade-my-item"> ${item.preview} ${esc(item.name)}
    </label>
  `).join('') || '<p style="color:#999;font-size:12px">No items to trade</p>';

  document.getElementById('trade-their-items').innerHTML = allItems.filter(i => !i.premium).map(item => `
    <label class="option-btn" style="display:flex;align-items:center;gap:4px;cursor:pointer">
      <input type="checkbox" value="${item.id}" class="trade-their-item"> ${item.preview} ${esc(item.name)}
    </label>
  `).join('');
}

async function sendTradeOffer() {
  const targetUsername = document.getElementById('trade-target').value.trim();
  if (!targetUsername) { showToast('Enter a username'); return; }

  const targetData = await api(`/api/users/search?q=${encodeURIComponent(targetUsername)}`);
  const target = (targetData.users || []).find(u => u.username.toLowerCase() === targetUsername.toLowerCase());
  if (!target) { showToast('User not found'); return; }

  const myItems = [...document.querySelectorAll('.trade-my-item:checked')].map(cb => cb.value);
  const theirItems = [...document.querySelectorAll('.trade-their-item:checked')].map(cb => cb.value);
  const myFlux = parseInt(document.getElementById('trade-my-flux').value) || 0;
  const theirFlux = parseInt(document.getElementById('trade-their-flux').value) || 0;

  if (myItems.length === 0 && myFlux === 0) { showToast('Add items or Flux to trade'); return; }
  if (theirItems.length === 0 && theirFlux === 0) { showToast('Add items or Flux you want'); return; }

  const data = await api('/api/trade/send', { method: 'POST', body: {
    toUserId: target.id, myItems, myFlux, theirItems, theirFlux
  }});
  if (data.error) { showToast(data.error); return; }
  showToast('Trade offer sent!');
  document.getElementById('trade-target').value = '';
  loadPendingTrades();
}

async function loadPendingTrades() {
  const data = await api('/api/trade/pending');
  const list = document.getElementById('trade-pending-list');
  const trades = data.trades || [];
  if (trades.length === 0) {
    list.innerHTML = '<p style="color:#999;font-size:13px">No pending trades</p>';
    return;
  }
  list.innerHTML = trades.map(t => {
    let fromItems = []; try { fromItems = JSON.parse(t.from_items || '[]'); } catch(e) {}
    let toItems = []; try { toItems = JSON.parse(t.to_items || '[]'); } catch(e) {}
    const shopData = allShopItems;
    const getItemName = id => { const item = shopData.find(i => i.id === id); return item ? item.preview + ' ' + item.name : id; };
    return `
      <div class="trade-offer">
        <div class="friend-avatar" style="background:${t.from_color}">${t.from_username[0].toUpperCase()}</div>
        <div style="flex:1">
          <div style="font-weight:700;font-size:12px">${esc(t.from_username)} offers:</div>
          <div class="trade-items">${fromItems.map(id => `<span class="trade-item-badge">${getItemName(id)}</span>`).join('')}</div>
          ${t.from_flux > 0 ? `<span class="trade-flux-badge">⚡ ${t.from_flux}</span>` : ''}
          <div style="font-size:11px;color:#999;margin-top:4px">Wants:</div>
          <div class="trade-items">${toItems.map(id => `<span class="trade-item-badge">${getItemName(id)}</span>`).join('')}</div>
          ${t.to_flux > 0 ? `<span class="trade-flux-badge">⚡ ${t.to_flux}</span>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <button class="btn btn-sm btn-success" onclick="acceptTrade('${t.id}')">Accept</button>
          <button class="btn btn-sm btn-danger" onclick="declineTrade('${t.id}')">Decline</button>
        </div>
      </div>`;
  }).join('');
}

async function acceptTrade(tradeId) {
  const data = await api('/api/trade/accept', { method: 'POST', body: { tradeId } });
  if (data.error) { showToast(data.error); return; }
  showToast('Trade accepted!');
  loadPendingTrades();
  loadTradeHistory();
  checkAuth();
}

async function declineTrade(tradeId) {
  await api('/api/trade/decline', { method: 'POST', body: { tradeId } });
  showToast('Trade declined');
  loadPendingTrades();
}

async function loadTradeHistory() {
  const data = await api('/api/trade/history');
  const list = document.getElementById('trade-history-list');
  const trades = data.trades || [];
  if (trades.length === 0) {
    list.innerHTML = '<p style="color:#999;font-size:13px">No trade history</p>';
    return;
  }
  list.innerHTML = trades.map(t => {
    let fromItems = []; try { fromItems = JSON.parse(t.from_items || '[]'); } catch(e) {}
    let toItems = []; try { toItems = JSON.parse(t.to_items || '[]'); } catch(e) {}
    const getItemName = id => { const item = allShopItems.find(i => i.id === id); return item ? item.preview + ' ' + item.name : id; };
    const statusColor = t.status === 'accepted' ? '#2ecc71' : t.status === 'declined' ? '#e74c3c' : '#f39c12';
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #e3e5e7">
        <div style="font-size:12px;flex:1">
          <b style="color:var(--primary)">${esc(t.from_username)}</b> → <b style="color:var(--primary)">${esc(t.to_username)}</b>
          <div style="font-size:11px;color:#999;margin-top:2px">
            ${fromItems.map(getItemName).join(', ')}${t.from_flux > 0 ? ` + ⚡${t.from_flux}` : ''}
            → ${toItems.map(getItemName).join(', ')}${t.to_flux > 0 ? ` + ⚡${t.to_flux}` : ''}
          </div>
        </div>
        <span style="font-size:11px;font-weight:600;color:${statusColor};text-transform:capitalize">${t.status}</span>
      </div>`;
  }).join('');
}

// --- Inventory ---
async function loadInventory() {
  const data = await api('/api/shop/my-items');
  const owned = data.inventory || [];
  const shopData = await api('/api/shop');
  const allItems = shopData.items || [];
  const ownedItems = allItems.filter(i => owned.includes(i.id));
  const grid = document.getElementById('inventory-items');
  const noMsg = document.getElementById('no-inventory-msg');
  const count = document.getElementById('inventory-count');
  count.textContent = `${ownedItems.length} items`;
  if (ownedItems.length === 0) {
    grid.innerHTML = '';
    noMsg.style.display = 'block';
    return;
  }
  noMsg.style.display = 'none';
  grid.innerHTML = ownedItems.map(item => `
    <div class="game-card" style="cursor:default">
      <div class="game-thumb" style="background:linear-gradient(135deg, #1a1a2e, #16213e);font-size:48px;display:flex;align-items:center;justify-content:center">
        ${item.preview}
      </div>
      <div class="game-info">
        <div class="game-name">${esc(item.name)}</div>
        <div class="game-meta"><span style="text-transform:capitalize">${item.category}</span></div>
        <div style="margin-top:8px">
          <button class="btn btn-sm btn-success" onclick="equipItem('${item.id}')">Equip</button>
        </div>
      </div>
    </div>
  `).join('');
}

// --- Global Search ---
let searchTimeout;
function globalSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(async () => {
    const q = document.getElementById('global-search').value.trim();
    if (q.length < 2) { document.getElementById('search-dropdown')?.remove(); return; }
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    let dropdown = document.getElementById('search-dropdown');
    if (!dropdown) {
      dropdown = document.createElement('div');
      dropdown.id = 'search-dropdown';
      dropdown.className = 'notif-dropdown open';
      dropdown.style.cssText = 'position:absolute;top:48px;left:60px;width:300px;max-height:400px;background:#fff;border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,0.08);z-index:250;overflow:hidden';
      document.querySelector('.topbar').appendChild(dropdown);
    }
    const users = data.users || [];
    const games = data.games || [];
    if (users.length === 0 && games.length === 0) {
      dropdown.innerHTML = '<p style="padding:16px;text-align:center;color:#999;font-size:13px">No results</p>';
      return;
    }
    let html = '';
    if (users.length > 0) {
      html += '<div style="padding:8px 12px;font-size:11px;font-weight:700;color:#999;text-transform:uppercase">Players</div>';
      html += users.map(u => `
        <div class="notif-item" onclick="openProfile('${u.id}')" style="cursor:pointer">
          <div class="friend-avatar" style="background:${u.avatar_color};width:28px;height:28px;font-size:10px">${u.username[0].toUpperCase()}</div>
          <div class="notif-text" style="font-weight:600">${esc(u.username)}</div>
        </div>
      `).join('');
    }
    if (games.length > 0) {
      html += '<div style="padding:8px 12px;font-size:11px;font-weight:700;color:#999;text-transform:uppercase">Games</div>';
      html += games.map(g => `
        <div class="notif-item" onclick="playGame('${g.id}')" style="cursor:pointer">
          <div style="font-size:18px">🎮</div>
          <div class="notif-text"><b>${esc(g.name)}</b><br><span style="font-size:10px;color:#999">by ${esc(g.owner_name)} · ▶ ${formatNum(g.plays)}</span></div>
        </div>
      `).join('');
    }
    dropdown.innerHTML = html;
  }, 300);
}

// Close search dropdown on outside click
document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('search-dropdown');
  if (dropdown && !e.target.closest('.topbar-search') && !e.target.closest('#search-dropdown')) {
    dropdown.remove();
  }
  const notifDropdown = document.getElementById('notif-dropdown');
  if (notifDropdown && !e.target.closest('.topbar-icon-btn') && !e.target.closest('#notif-dropdown')) {
    notifDropdown.classList.remove('open');
    notifOpen = false;
  }
});

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
  const sections = ['sec-home', 'sec-chart', 'sec-creations', 'sec-friends', 'sec-shop', 'sec-inventory', 'sec-trading', 'sec-groups', 'sec-parties', 'sec-assets', 'sec-avatar'];
  let current = sections[0];
  for (const id of sections) {
    const el = document.getElementById(id);
    if (el && el.getBoundingClientRect().top <= 120) current = id;
  }
  document.querySelectorAll('.sidebar-item[data-section]').forEach(i => i.classList.toggle('active', i.dataset.section === current));
});

// Load sections when they come into view
const sectionObserver = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (!e.isIntersecting) return;
    if (e.target.id === 'sec-friends') loadFriends();
    if (e.target.id === 'sec-avatar') loadAvatarEditor();
    if (e.target.id === 'sec-creations') loadMyGames();
    if (e.target.id === 'sec-assets') browseAssets('all');
    if (e.target.id === 'sec-inventory') loadInventory();
    if (e.target.id === 'sec-trading') { loadTradeItems(); loadPendingTrades(); loadTradeHistory(); }
    if (e.target.id === 'sec-groups') { loadMyGroups(); loadBrowseGroups(); }
    if (e.target.id === 'sec-parties') { loadOpenParties(); }
  });
}, { threshold: 0.1 });

document.addEventListener('DOMContentLoaded', () => {
  ['sec-friends', 'sec-avatar', 'sec-creations', 'sec-assets', 'sec-inventory', 'sec-trading', 'sec-groups', 'sec-parties'].forEach(id => {
    const el = document.getElementById(id);
    if (el) sectionObserver.observe(el);
  });
  const searchInput = document.getElementById('global-search');
  if (searchInput) searchInput.addEventListener('input', globalSearch);
});

// --- Groups ---
function openCreateGroup() {
  document.getElementById('create-group-modal').classList.add('active');
}

async function createGroup() {
  const name = document.getElementById('new-group-name').value.trim();
  const desc = document.getElementById('new-group-desc').value.trim();
  const icon = document.getElementById('new-group-icon').value.trim() || '🎮';
  if (!name) { showToast('Group name required'); return; }
  const data = await api('/api/groups', { method: 'POST', body: { name, description: desc, icon } });
  if (data.error) { showToast(data.error); return; }
  document.getElementById('create-group-modal').classList.remove('active');
  document.getElementById('new-group-name').value = '';
  document.getElementById('new-group-desc').value = '';
  showToast('Group created!');
  loadMyGroups();
  loadBrowseGroups();
}

async function loadMyGroups() {
  const data = await api('/api/groups/mine');
  const list = document.getElementById('my-groups-list');
  const groups = data.groups || [];
  if (groups.length === 0) {
    list.innerHTML = '<p style="color:#999;font-size:13px">You haven\'t joined any groups yet</p>';
    return;
  }
  list.innerHTML = groups.map(g => `
    <div class="friend-item" style="cursor:pointer" onclick="openGroupDetail('${g.id}')">
      <div class="friend-avatar" style="background:${g.color};font-size:18px">${g.icon}</div>
      <div style="flex:1">
        <div style="font-weight:700;font-size:13px">${esc(g.name)}</div>
        <div style="font-size:11px;color:#999">${g.member_count} members · ${g.role}</div>
      </div>
    </div>
  `).join('');
}

async function loadBrowseGroups() {
  const data = await api('/api/groups');
  const list = document.getElementById('browse-groups-list');
  const groups = data.groups || [];
  if (groups.length === 0) {
    list.innerHTML = '<p style="color:#999;font-size:13px">No groups yet. Create the first one!</p>';
    return;
  }
  list.innerHTML = groups.map(g => `
    <div class="friend-item" style="cursor:pointer" onclick="openGroupDetail('${g.id}')">
      <div class="friend-avatar" style="background:${g.color};font-size:18px">${g.icon}</div>
      <div style="flex:1">
        <div style="font-weight:700;font-size:13px">${esc(g.name)}</div>
        <div style="font-size:11px;color:#999">${g.member_count} members · by ${esc(g.owner_name)}</div>
      </div>
    </div>
  `).join('');
}

async function searchGroups() {
  const q = document.getElementById('group-search').value.trim();
  if (q.length < 2) { loadBrowseGroups(); return; }
  const data = await api(`/api/groups/search?q=${encodeURIComponent(q)}`);
  const list = document.getElementById('browse-groups-list');
  const groups = data.groups || [];
  if (groups.length === 0) {
    list.innerHTML = '<p style="color:#999;font-size:13px">No groups found</p>';
    return;
  }
  list.innerHTML = groups.map(g => `
    <div class="friend-item" style="cursor:pointer" onclick="openGroupDetail('${g.id}')">
      <div class="friend-avatar" style="background:${g.color};font-size:18px">${g.icon}</div>
      <div style="flex:1">
        <div style="font-weight:700;font-size:13px">${esc(g.name)}</div>
        <div style="font-size:11px;color:#999">${g.member_count} members · by ${esc(g.owner_name)}</div>
      </div>
    </div>
  `).join('');
}

async function openGroupDetail(groupId) {
  const data = await api(`/api/groups/${groupId}`);
  if (data.error) { showToast('Group not found'); return; }
  const g = data.group;
  const members = data.members || [];
  const isMember = data.isMember;
  const userRole = data.userRole;
  const isOwner = userRole === 'owner';
  const isAdmin = userRole === 'owner' || userRole === 'admin';

  document.getElementById('group-detail-content').innerHTML = `
    <div style="display:flex;align-items:center;gap:16px;padding:16px;background:var(--bg);border-radius:10px;margin-bottom:14px">
      <div style="width:56px;height:56px;border-radius:14px;background:${g.color};display:flex;align-items:center;justify-content:center;font-size:28px;flex-shrink:0">${g.icon}</div>
      <div style="flex:1">
        <div style="font-size:20px;font-weight:800">${esc(g.name)}</div>
        <div style="font-size:12px;color:#999;margin-top:2px">${g.description ? esc(g.description) : 'No description'} · ${g.member_count} members</div>
        <div style="font-size:11px;color:#999;margin-top:2px">Created by <b style="color:var(--primary)">${esc(g.owner_name)}</b></div>
      </div>
      <div>
        ${isMember
          ? (isOwner
            ? `<button class="btn btn-sm btn-danger" onclick="deleteGroup('${g.id}')">Delete</button>`
            : `<button class="btn btn-sm btn-danger" onclick="leaveGroup('${g.id}')">Leave</button>`)
          : `<button class="btn btn-sm btn-primary" onclick="joinGroup('${g.id}')">Join</button>`
        }
      </div>
    </div>
    <h4 style="margin-bottom:10px;font-size:14px">Members (${members.length})</h4>
    <div style="max-height:250px;overflow-y:auto">
      ${members.map(m => `
        <div class="friend-item">
          <div class="friend-avatar" style="background:${m.avatar_color};cursor:pointer" onclick="document.getElementById('group-detail-modal').classList.remove('active');openProfile('${m.user_id}')">${m.username[0].toUpperCase()}</div>
          <div style="flex:1;cursor:pointer" onclick="document.getElementById('group-detail-modal').classList.remove('active');openProfile('${m.user_id}')">
            <div style="font-weight:700;font-size:13px">${esc(m.username)} ${m.is_premium ? '<span style="background:linear-gradient(135deg,#ffd700,#ffaa00);color:#333;padding:1px 5px;border-radius:4px;font-size:9px;font-weight:700">👑</span>' : ''}</div>
            <div style="font-size:11px;color:#999;text-transform:capitalize">${m.role}</div>
          </div>
          ${isAdmin && m.user_id !== currentUser.id && m.role !== 'owner' ? `
            <div style="display:flex;gap:4px">
              ${!isOwner ? '' : `<button class="btn btn-sm" onclick="setGroupRole('${g.id}','${m.user_id}','admin')" style="font-size:10px">Make Admin</button>`}
              <button class="btn btn-sm btn-danger" onclick="kickMember('${g.id}','${m.user_id}')" style="font-size:10px">Kick</button>
            </div>
          ` : ''}
        </div>
      `).join('')}
    </div>
  `;
  document.getElementById('group-detail-modal').classList.add('active');
}

async function joinGroup(groupId) {
  const data = await api(`/api/groups/${groupId}/join`, { method: 'POST' });
  if (data.error) { showToast(data.error); return; }
  showToast('Joined group!');
  openGroupDetail(groupId);
  loadMyGroups();
}

async function leaveGroup(groupId) {
  if (!confirm('Leave this group?')) return;
  const data = await api(`/api/groups/${groupId}/leave`, { method: 'POST' });
  if (data.error) { showToast(data.error); return; }
  showToast('Left group');
  document.getElementById('group-detail-modal').classList.remove('active');
  loadMyGroups();
}

async function deleteGroup(groupId) {
  if (!confirm('Delete this group? This cannot be undone.')) return;
  const data = await api(`/api/groups/${groupId}`, { method: 'DELETE' });
  if (data.error) { showToast(data.error); return; }
  showToast('Group deleted');
  document.getElementById('group-detail-modal').classList.remove('active');
  loadMyGroups();
  loadBrowseGroups();
}

async function kickMember(groupId, userId) {
  const data = await api(`/api/groups/${groupId}/kick`, { method: 'POST', body: { userId } });
  if (data.error) { showToast(data.error); return; }
  showToast('Member kicked');
  openGroupDetail(groupId);
}

async function setGroupRole(groupId, userId, role) {
  const data = await api(`/api/groups/${groupId}/role`, { method: 'POST', body: { userId, role } });
  if (data.error) { showToast(data.error); return; }
  showToast('Role updated');
  openGroupDetail(groupId);
}

// --- Parties ---
let currentParty = null;
let voiceMuted = false;
let localStream = null;
let peerConnections = {};

async function createParty() {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'party_create', name: currentUser.username + "'s Party" }));
  }
}

function handlePartyJoined(party) {
  currentParty = party;
  document.getElementById('party-badge').style.display = 'flex';
  document.getElementById('party-badge').textContent = party.members.length;
  renderMyParty();
  loadOpenParties();
}

function handlePartyLeft() {
  currentParty = null;
  document.getElementById('party-badge').style.display = 'none';
  document.getElementById('my-party-info').innerHTML = '<p style="color:#999;font-size:13px">You\'re not in a party. Create or join one!</p>';
  document.getElementById('voice-panel').style.display = 'none';
  loadOpenParties();
}

function handlePartyUpdate(party) {
  currentParty = party;
  document.getElementById('party-badge').textContent = party.members.length;
  renderMyParty();
  updateVoiceMembers();
  loadOpenParties();
}

function handlePartyKicked() {
  currentParty = null;
  document.getElementById('party-badge').style.display = 'none';
  document.getElementById('my-party-info').innerHTML = '<p style="color:#999;font-size:13px">You were kicked from the party</p>';
  document.getElementById('voice-panel').style.display = 'none';
  showToast('You were kicked from the party');
  loadOpenParties();
}

function renderMyParty() {
  if (!currentParty) return;
  const el = document.getElementById('my-party-info');
  const isOwner = currentParty.owner.id === currentUser.id;
  el.innerHTML = `
    <div class="party-card">
      <div class="party-info">
        <div style="width:40px;height:40px;border-radius:10px;background:var(--primary);display:flex;align-items:center;justify-content:center;font-size:20px;color:#fff;font-weight:900">🎉</div>
        <div>
          <div class="party-name">${esc(currentParty.name)}</div>
          <div class="party-meta">${currentParty.members.length}/${currentParty.maxMembers} members</div>
        </div>
      </div>
      <div class="party-members" style="margin-top:10px">
        ${currentParty.members.map(m => `
          <div class="party-member-dot" style="background:${m.avatarColor}" title="${esc(m.username)}">${m.username[0].toUpperCase()}</div>
        `).join('')}
      </div>
      <div class="party-actions">
        <button class="btn btn-sm" onclick="toggleVoicePanel()" style="font-size:11px">🎤 Voice</button>
        <button class="btn btn-sm" onclick="partyChat()" style="font-size:11px">💬 Chat</button>
        ${isOwner
          ? `<button class="btn btn-sm btn-danger" onclick="deleteParty()" style="font-size:11px">Disband</button>`
          : `<button class="btn btn-sm btn-danger" onclick="leaveParty()" style="font-size:11px">Leave</button>`
        }
      </div>
    </div>
  `;
}

function partyChat() {
  if (!currentParty) return;
  chatOpen = true;
  document.getElementById('chat-panel').classList.add('open');
  document.getElementById('chat-messages').innerHTML = '';
  // Load party chat history
  api(`/api/chat/history?channel=party_${currentParty.id}`).then(data => {
    const el = document.getElementById('chat-messages');
    (data.messages || []).forEach(m => appendChat({ user: m.username, avatarColor: m.avatar_color, message: m.message, timestamp: new Date(m.created_at).getTime(), isPremium: m.is_premium }));
    el.scrollTop = el.scrollHeight;
  });
  // Override sendChat to use party channel
  window._chatChannel = `party_${currentParty.id}`;
}

function leaveParty() {
  if (!currentParty) return;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'party_leave', partyId: currentParty.id }));
  }
}

function deleteParty() {
  if (!currentParty) return;
  if (!confirm('Disband this party?')) return;
  leaveParty();
}

function joinParty(partyId) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'party_join', partyId }));
  }
}

async function loadOpenParties() {
  const data = await api('/api/parties');
  const list = document.getElementById('open-parties-list');
  const parties = (data.parties || []).filter(p => p.id !== currentParty?.id);
  if (parties.length === 0) {
    list.innerHTML = '<p style="color:#999;font-size:13px">No open parties</p>';
    return;
  }
  list.innerHTML = parties.map(p => `
    <div class="party-card">
      <div class="party-info">
        <div style="width:36px;height:36px;border-radius:8px;background:var(--primary);display:flex;align-items:center;justify-content:center;font-size:16px;color:#fff">🎉</div>
        <div style="flex:1">
          <div class="party-name" style="font-size:13px">${esc(p.name)}</div>
          <div class="party-meta">${p.memberCount}/${p.maxMembers} · by ${esc(p.owner)}</div>
        </div>
      </div>
      <div class="party-actions">
        <button class="btn btn-sm btn-primary" onclick="joinParty('${p.id}')" style="font-size:11px">Join</button>
      </div>
    </div>
  `).join('');
}

// --- Voice Chat ---
async function toggleVoicePanel() {
  const panel = document.getElementById('voice-panel');
  if (panel.style.display === 'none') {
    panel.style.display = 'block';
    await startVoice();
    updateVoiceMembers();
  } else {
    panel.style.display = 'none';
    stopVoice();
  }
}

async function startVoice() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (ws && ws.readyState === 1 && currentParty) {
      ws.send(JSON.stringify({ type: 'party_voice_toggle', partyId: currentParty.id }));
    }
  } catch (e) {
    showToast('Microphone access denied');
  }
}

function stopVoice() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  Object.values(peerConnections).forEach(pc => pc.close());
  peerConnections = {};
  if (ws && ws.readyState === 1 && currentParty) {
    ws.send(JSON.stringify({ type: 'party_voice_toggle', partyId: currentParty.id }));
  }
}

function toggleVoiceMute() {
  voiceMuted = !voiceMuted;
  const btn = document.getElementById('voice-mute-btn');
  btn.classList.toggle('muted', voiceMuted);
  btn.textContent = voiceMuted ? '🔇' : '🎤';
  if (localStream) {
    localStream.getAudioTracks().forEach(t => t.enabled = !voiceMuted);
  }
}

function updateVoiceMembers() {
  if (!currentParty) return;
  const el = document.getElementById('voice-members');
  el.innerHTML = currentParty.members.map(m => `
    <div class="voice-member ${m.voiceEnabled ? 'speaking' : ''}">
      <div class="voice-dot"></div>
      <div class="party-member-dot" style="background:${m.avatarColor};width:22px;height:22px;font-size:8px;margin:0;border-width:1px">${m.username[0].toUpperCase()}</div>
      <span>${esc(m.username)}${m.id === currentUser.id ? ' (You)' : ''}</span>
    </div>
  `).join('');
}

// WebRTC peer connection management
async function createPeerConnection(peerId) {
  if (peerConnections[peerId]) return peerConnections[peerId];
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }]
  });
  peerConnections[peerId] = pc;

  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'voice_ice', to: peerId, candidate: e.candidate }));
    }
  };

  pc.ontrack = (e) => {
    // Audio comes from remote peer - browser plays it automatically
  };

  return pc;
}

// Handle voice signaling from WebSocket
function handleVoiceSignal(msg) {
  if (msg.type === 'voice_offer' && localStream) {
    createPeerConnection(msg.from).then(async pc => {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'voice_answer', to: msg.from, answer: pc.localDescription }));
    });
  } else if (msg.type === 'voice_answer') {
    const pc = peerConnections[msg.from];
    if (pc) pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
  } else if (msg.type === 'voice_ice') {
    const pc = peerConnections[msg.from];
    if (pc && msg.candidate) pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
  }
}

// --- Chat Filter (client-side preview) ---
const FILTER_WORDS = ['damn','hell','crap','stfu','wtf','stupid','idiot','loser','ugly','dumb','moron','trash','noob'];
function clientFilter(text) {
  let filtered = text;
  FILTER_WORDS.forEach(w => {
    const regex = new RegExp(`\\b${w}\\b`, 'gi');
    filtered = filtered.replace(regex, '*'.repeat(w.length));
  });
  return filtered;
}

// Patch sendChat to support party channel and filtering
const _realSendChat = sendChat;
sendChat = function() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  const channel = window._chatChannel || 'global';
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'chat', message: msg, channel }));
  }
  input.value = '';
  document.getElementById('typing-indicator').textContent = '';
  window._chatChannel = null;
};
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
