const express = require("express");
const rateLimit = require("express-rate-limit");
const axios = require("axios");
const rbx = require("noblox.js");
const http = require("http");
const https = require("https");
const url = require("url");

const app = express();

const cookie = process.env.COOKIE;
const apiKey = process.env.API_KEY;
const maintainerKey = process.env.MAINTAINER_KEY;
const groupId = parseInt(process.env.GROUP_ID);
const SELF_URL = process.env.SELF_URL || "https://your-app-name.onrender.com";

const PING_INTERVAL = 4 * 60 * 1000;
const RESTART_INTERVAL = 60 * 60 * 1000;

rbx.setOptions({ show_deprecation_warnings: false });
app.set("trust proxy", 1);
app.use(express.json());

// Rate Limit
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many requests, slow down." }
});
app.use(limiter);

// Action Rate Limit
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

// Login
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

// ----- Public Status -----
app.get("/api/status", (req, res) => {
  res.json({ online: true, message: "API is online", time: new Date().toISOString() });
});

// ----- Auth Middleware -----
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  const queryKey = req.query.key;

  let authType = null;
  if (authHeader === "Bearer " + maintainerKey) authType = "main";
  else if (queryKey === apiKey) authType = "roblox_api";

  if (!authType) return res.status(403).json({ error: "Unauthorized access: Invalid key." });

  req.authType = authType;
  next();
});

// ----- Roles -----
app.get("/api/roles", async (req, res) => {
  try {
    const roles = await rbx.getRoles(groupId);
    res.json(roles.map(r => ({ rank: r.rank, name: r.name })));
  } catch {
    res.status(500).json({ error: "Failed to fetch roles" });
  }
});

// ----- Maintainer Authentication -----
app.post("/api/auth", (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(403).json({ error: "No key provided" });
  if (key === maintainerKey) return res.json({ success: true, type: "main" });
  res.status(403).json({ error: "Invalid Maintainer Key" });
});

// ----- POST Promote/Demote/SetRank -----
app.post("/api/:action(promote|demote|setrank)", async (req, res) => {
  if (req.authType !== "main") return res.status(403).json({ error: "Only maintainer can perform rank changes." });

  const { userid, trainerid, rank } = req.body;
  if (!userid || !trainerid) return res.status(400).json({ error: "Missing parameters" });

  const count = incrementAction(req.ip);
  if (count > ACTION_LIMIT) return res.status(403).json({ error: "Too many actions." });

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

    res.json({
      success: true,
      message: `User ${username} ${req.params.action}d to ${rankInfo.name} (Rank ${targetRank})`
    });
  } catch (err) {
    console.error("Rank change failed:", err);
    res.status(500).json({ error: "Rank change failed", details: err.message });
  }
});

// ----- GET Promote/Demote/SetRank -----
app.get("/api/:action(promote|demote|setrank)", async (req, res) => {
  if (req.authType !== "roblox_api") return res.status(403).json({ error: "Invalid API key" });

  const { userid, trainerid, rank } = req.query;
  if (!userid || !trainerid) return res.status(400).json({ error: "Missing parameters" });

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

    res.json({
      success: true,
      message: `User ${username} ${req.params.action}d to ${rankInfo.name} (Rank ${targetRank})`
    });
  } catch (err) {
    console.error("GET rank change failed:", err);
    res.status(500).json({ error: "Rank change failed", details: err.message });
  }
});

// ----- User Info -----
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

// ----- Restart -----
app.post("/api/restart", (req, res) => {
  if (req.authType !== "main") return res.status(403).json({ error: "Unauthorized" });
  res.json({ message: "Restarting service..." });
  setTimeout(() => process.exit(0), 1000);
});

// ----- Server -----
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
