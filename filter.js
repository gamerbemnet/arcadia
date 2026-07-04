// Arcadia Chat Filter - profanity, links, spam
const BAD_WORDS = [
  'damn','hell','crap','ass','dick','piss','stfu','wtf','af','stupid','idiot','loser',
  'ugly','dumb','moron','trash','noob','n00b','kill','die','hate','suck','sux',
  'fag','retard','retarded','slut','whore','bitch','bastard','crap','bollocks',
  'penis','vagina','sex','porn','xxx','nude','naked','jerk'
];

const LINK_PATTERN = /https?:\/\/[^\s]+|www\.[^\s]+|discord\.gg\/[^\s]+|t\.me\/[^\s]+/gi;
const SPAM_WINDOW = 5000;
const MAX_REPEAT = 3;

const userMsgHistory = new Map();

function normalizeText(text) {
  return text
    .replace(/@/g, 'a').replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e')
    .replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/8/g, 'b')
    .replace(/\$/g, 's').replace(/!/g, 'i').replace(/\+/g, 't');
}

function containsBadWord(text) {
  const normalized = normalizeText(text.toLowerCase());
  return BAD_WORDS.some(w => normalized.includes(w));
}

function containsLink(text) {
  return LINK_PATTERN.test(text);
}

function isSpam(userId, text) {
  const now = Date.now();
  if (!userMsgHistory.has(userId)) userMsgHistory.set(userId, []);
  const history = userMsgHistory.get(userId);
  
  // Remove old messages
  while (history.length > 0 && now - history[0].time > SPAM_WINDOW) {
    history.shift();
  }
  
  // Check for repeated messages
  const sameCount = history.filter(h => h.text === text).length;
  if (sameCount >= MAX_REPEAT) return true;
  
  // Check for rapid messages (more than 5 in 5 seconds)
  if (history.length >= 5) return true;
  
  history.push({ text, time: now });
  return false;
}

function censorText(text) {
  let censored = text;
  const normalized = normalizeText(censored.toLowerCase());
  
  BAD_WORDS.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    if (regex.test(normalized)) {
      censored = censored.replace(regex, '*'.repeat(word.length));
    }
  });
  
  return censored;
}

function filterMessage(userId, text) {
  if (!text || text.trim().length === 0) return { allowed: false, reason: 'empty' };
  if (text.length > 500) return { allowed: false, reason: 'too_long' };
  
  if (containsLink(text)) {
    return { allowed: false, reason: 'links_not_allowed' };
  }
  
  if (isSpam(userId, text)) {
    return { allowed: false, reason: 'spam_detected' };
  }
  
  if (containsBadWord(text)) {
    const censored = censorText(text);
    return { allowed: true, censored, wasFiltered: true };
  }
  
  return { allowed: true, censored: text, wasFiltered: false };
}

// Clean up old spam history periodically
setInterval(() => {
  const now = Date.now();
  for (const [userId, history] of userMsgHistory) {
    while (history.length > 0 && now - history[0].time > SPAM_WINDOW * 2) {
      history.shift();
    }
    if (history.length === 0) userMsgHistory.delete(userId);
  }
}, 60000);

module.exports = { filterMessage, containsBadWord, containsLink, isSpam, censorText };
