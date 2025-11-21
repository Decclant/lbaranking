const express = require("express");
const rateLimit = require("express-rate-limit");
const axios = require("axios");
const rbx = require("noblox.js");
const http = require("http");
const https = require("https");
const url = require("url");
const path = require("path");
const fs = require("fs");

const app = express();

const cookie = process.env.COOKIE;
const apiKey = process.env.API_KEY;
const maintainerKey = process.env.MAINTAINER_KEY;
const secondaryKey = process.env.SECONDARY_KEY;
const spectatorKey = process.env.SPECTATOR_KEY;
const webhookURL = process.env.WEBHOOK;
const groupId = parseInt(process.env.GROUP_ID);
const SELF_URL = process.env.SELF_URL || "https://your-app-name.onrender.com";

const PING_INTERVAL = 4 * 60 * 1000;
const RESTART_INTERVAL = 60 * 60 * 1000;

rbx.setOptions({ show_deprecation_warnings: false });
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many requests, slow down." }
});
app.use(limiter);

const PENDING_FILE = "./pendingApprovals.json";
const APPROVED_FILE = "./approvedIPs.json";
const BLOCKED_FILE = "./blockedIPs.json";

function loadJSON(filePath) {
  try {
    const data = fs.readFileSync(filePath, "utf8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

let pendingApprovals = loadJSON(PENDING_FILE);
let approvedIPs = loadJSON(APPROVED_FILE);
let blockedIPs = loadJSON(BLOCKED_FILE);

function savePending() { saveJSON(PENDING_FILE, pendingApprovals); }
function saveApproved() { saveJSON(APPROVED_FILE, approvedIPs); }
function saveBlocked() { saveJSON(BLOCKED_FILE, blockedIPs); }

const actionCounters = {};
const ACTION_LIMIT = 15;
const ACTION_WINDOW = 10 * 60 * 1000;

function incrementAction(ip) {
  if (!actionCounters[ip]) {
    actionCounters[ip] = { count: 1, firstAction: Date.now() };
  } else {
    const elapsed = Date.now() - actionCounters[ip].firstAction;
    if (elapsed > ACTION_WINDOW) {
      actionCounters[ip] = { count: 1, firstAction: Date.now() };
    } else {
      actionCounters[ip].count++;
    }
  }
  return actionCounters[ip].count;
}

function isBlocked(ip) {
  return blockedIPs.includes(ip);
}

function isApproved(ip) {
  return approvedIPs.includes(ip);
}

function addPendingApproval(ip) {
  if (pendingApprovals.some(r => r.ip === ip && !r.approved)) return;
  pendingApprovals.push({
    ip,
    time: Date.now(),
    type: "secondary_login",
    approved: false
  });
  savePending();
}

function approvePendingIp(ip) {
  const req = pendingApprovals.find(r => r.ip === ip && !r.approved);
  if (req) {
    req.approved = true;
    if (!approvedIPs.includes(ip)) {
      approvedIPs.push(ip);
      saveApproved();
    }
    savePending();
    return true;
  }
  return false;
}

function rejectPendingIp(ip) {
  pendingApprovals = pendingApprovals.filter(r => r.ip !== ip);
  savePending();
}

function blockIp(ip) {
  if (!blockedIPs.includes(ip)) {
    blockedIPs.push(ip);
    saveBlocked();
    console.log(`🚫 IP blocked due to suspicious activity: ${ip}`);
  }
}

async function startApp() {
  try {
    await rbx.setCookie(cookie);
    const currentUser = await rbx.getAuthenticatedUser();
    console.log(`✅ Logged in as ${currentUser.name}`);
  } catch (err) {
    console.error("❌ Login failed:", err);
    process.exit(1);
  }
}
startApp();

function logToDiscord(embed) {
  if (!webhookURL) return;
  axios.post(webhookURL, { embeds: [embed] }).catch(() => {});
}

async function createEmbed(action, userId, username, rankName, rankId, trainerId, isRoblox = false) {
  let executor = `<@${trainerId}>`;

  if (isRoblox) {
    try {
      const trainerUsername = await rbx.getUsernameFromId(trainerId);
      executor = `${trainerUsername} (${trainerId})`;
    } catch {
      executor = `Roblox User (${trainerId})`;
    }
  }

  return {
    title: `📋 ${action.toUpperCase()} Action`,
    color:
      action === "promote" ? 0x2ecc71 :
      action === "demote" ? 0xe74c3c :
      0xf1c40f,
    fields: [
      { name: "👤 Target User", value: `${username} (${userId})`, inline: true },
      { name: "🎖 Rank", value: `${rankName} (Rank ${rankId})`, inline: true },
      { name: "🛠 Executor", value: executor, inline: true },
      { name: "⏱ Time", value: new Date().toLocaleString(), inline: false }
    ],
    timestamp: new Date()
  };
}

app.use((req, res, next) => {
  const ip = req.ip;
  if (isBlocked(ip)) {
    return res.status(403).json({ error: "Your IP has been blocked." });
  }
  next();
});

app.use((req, res, next) => {
  if (!req.path.startsWith("/api") || req.path === "/api/auth" || req.path === "/api/status") {
    return next();
  }

  const authHeader = req.headers.authorization;
  const queryKey = req.query.key;
  const ip = req.ip;

  let authType = null;
  if (authHeader === `Bearer ${maintainerKey}`) {
    authType = "main";
  } else if (authHeader === `Bearer ${secondaryKey}` && isApproved(ip)) {
    authType = "secondary";
  } else if (authHeader === `Bearer ${spectatorKey}`) {
    authType = "spectator";
  } else if (queryKey === apiKey) {
    authType = "roblox_api";
  }

  if (!authType) {
    return res.status(403).json({ error: "Unauthorized access: Invalid key or unapproved IP." });
  }

  req.authType = authType;
  next();
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/api/status", (req, res) => {
  res.json({ online: true, message: "API is online", time: new Date().toISOString() });
});

app.get("/api/roles", async (req, res) => {
  try {
    const roles = await rbx.getRoles(groupId);
    res.json(roles.map(r => ({ rank: r.rank, name: r.name })));
  } catch {
    res.status(500).json({ error: "Failed to fetch roles" });
  }
});

app.post("/api/auth", (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(403).json({ error: "No key provided" });

  if (key === maintainerKey) return res.json({ success: true, type: "main" });
  if (key === secondaryKey) {
    const ip = req.ip;
    if (isApproved(ip)) {
      return res.json({ success: true, type: "secondary" });
    } else {
      addPendingApproval(ip);
      return res.status(403).json({ error: "IP not approved. Approval pending." });
    }
  }
  if (key === spectatorKey) {
    return res.json({ success: true, type: "spectator" });
  }

  res.status(403).json({ error: "Invalid Maintainer Key" });
});

app.post("/api/:action(promote|demote|setrank)", async (req, res) => {
  const ip = req.ip;
  
  if (req.authType === "spectator") {
    return res.status(403).json({ error: "This is a spectator key, no ranking permissions are allowed." });
  }

  const { userid, trainerid, rank } = req.body;
  if (!userid || !trainerid) return res.status(400).json({ error: "Missing parameters" });

  const count = incrementAction(ip);
  if (count > ACTION_LIMIT) {
    blockIp(ip);
    console.log(`Blocked IP ${ip} for exceeding action limit.`);
    return res.status(403).json({ error: "Too many actions, your IP has been blocked." });
  }

  try {
    let targetUserId = isNaN(userid) ? await rbx.getIdFromUsername(userid) : parseInt(userid);
    const currentRank = await rbx.getRankInGroup(groupId, targetUserId);
    const roles = await rbx.getRoles(groupId);

    let targetRank;
    if (req.params.action === "promote") {
      targetRank = roles.find(r => r.rank > currentRank)?.rank;
    } else if (req.params.action === "demote") {
      targetRank = [...roles].reverse().find(r => r.rank < currentRank)?.rank;
    } else if (req.params.action === "setrank") {
      if (!rank) return res.status(400).json({ error: "Rank required" });
      targetRank = parseInt(rank);
    }

    if (!targetRank) return res.status(400).json({ error: "Invalid rank change" });

    await rbx.setRank(groupId, targetUserId, targetRank);
    const username = await rbx.getUsernameFromId(targetUserId);
    const rankInfo = roles.find(r => r.rank === targetRank);
    const embed = await createEmbed(req.params.action, targetUserId, username, rankInfo.name, targetRank, trainerid, false);
    logToDiscord(embed);

    res.json({ success: true, message: `User ${req.params.action}d to ${rankInfo.name} (Rank ${targetRank})` });
  } catch (err) {
    console.error("Rank change failed:", err);
    res.status(500).json({ error: "Rank change failed", details: err.message });
  }
});

app.get("/api/:action(promote|demote|setrank)", async (req, res) => {
  const { userid, trainerid, rank, key } = req.query;
  if (!userid || !trainerid || !key) return res.status(400).json({ error: "Missing parameters" });
  if (key !== apiKey) return res.status(403).json({ error: "Invalid API Key" });

  try {
    let targetUserId = isNaN(userid) ? await rbx.getIdFromUsername(userid) : parseInt(userid);
    const currentRank = await rbx.getRankInGroup(groupId, targetUserId);
    const roles = await rbx.getRoles(groupId);

    let targetRank;
    if (req.params.action === "promote") {
      targetRank = roles.find(r => r.rank > currentRank)?.rank;
    } else if (req.params.action === "demote") {
      targetRank = [...roles].reverse().find(r => r.rank < currentRank)?.rank;
    } else if (req.params.action === "setrank") {
      if (!rank) return res.status(400).json({ error: "Rank required" });
      targetRank = parseInt(rank);
    }

    if (!targetRank) return res.status(400).json({ error: "Invalid rank change" });

    await rbx.setRank(groupId, targetUserId, targetRank);
    const username = await rbx.getUsernameFromId(targetUserId);
    const rankInfo = roles.find(r => r.rank === targetRank);
    const embed = await createEmbed(req.params.action, targetUserId, username, rankInfo.name, targetRank, trainerid, true);
    logToDiscord(embed);

    res.json({ success: true, message: `User ${req.params.action}d to ${rankInfo.name} (Rank ${targetRank})` });
  } catch (err) {
    console.error("GET rank change failed:", err);
    res.status(500).json({ error: "Rank change failed", details: err.message });
  }
});

app.get("/api/userinfo", async (req, res) => {
  const { userid } = req.query;
  if (!userid) return res.status(400).json({ error: "No user ID or username provided" });

  try {
    let userId = isNaN(userid) ? await rbx.getIdFromUsername(userid) : parseInt(userid);
    const [username, thumbnail, rankName] = await Promise.all([
      rbx.getUsernameFromId(userId),
      rbx.getPlayerThumbnail(userId, 150, "png", true, "headshot"),
      rbx.getRankNameInGroup(groupId, userId)
    ]);
    res.json({
      userId,
      username,
      rank: rankName,
      headshotUrl: thumbnail[0]?.imageUrl || null
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch user info" });
  }
});

app.get("/api/pending-approvals", (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${maintainerKey}`) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  res.json(pendingApprovals.filter(r => !r.approved));
});

app.post("/api/pending-approvals/approve", (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${maintainerKey}`) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: "IP required" });

  const success = approvePendingIp(ip);
  if (success) {
    res.json({ success: true, message: `IP ${ip} approved.` });
  } else {
    res.status(404).json({ error: "Pending IP not found" });
  }
});

app.post("/api/pending-approvals/reject", (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${maintainerKey}`) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: "IP required" });

  rejectPendingIp(ip);
  res.json({ success: true, message: `IP ${ip} rejected and removed.` });
});

app.post("/api/restart", (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${maintainerKey}`) {
      return res.status(403).json({ error: "Unauthorized" });
  }
  res.json({ message: "Restarting service..." });
  setTimeout(() => process.exit(0), 1000);
});

app.get("/", (req, res) => {
  res.send("<h1>💂 Liam's British Army API</h1><p>The API is online. Contact @woozytheo for support.</p>");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);

  const parsedUrl = url.parse(SELF_URL);
  const getModule = parsedUrl.protocol === "https:" ? https : http;

  setInterval(() => {
    getModule.get(SELF_URL, res => {
      console.log(`🔁 Self-ping responded with ${res.statusCode}`);
    }).on("error", err => {
      console.error(`❌ Self-ping error: ${err.message}`);
    });
  }, PING_INTERVAL);

  setTimeout(() => {
    console.log("♻️ Restarting to avoid Render idle timeout...");
    process.exit(0);
  }, RESTART_INTERVAL);
});
