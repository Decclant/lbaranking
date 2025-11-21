{"variant":"standard","title":"Index.js for LBA API","id":"70321"}
const express = require("express");
const rateLimit = require("express-rate-limit");
const axios = require("axios");
const rbx = require("noblox.js");
const http = require("http");
const https = require("https");
const url = require("url");

const app = express();

const cookie = process.env.COOKIE;
const maintainerKey = process.env.MAINTAINER_KEY;
const webhookURL = process.env.WEBHOOK;
const groupId = 279033175; // Liams British Army group ID
const SELF_URL = process.env.SELF_URL || "https://your-app-name.onrender.com";

const PING_INTERVAL = 4 * 60 * 1000;
const RESTART_INTERVAL = 60 * 60 * 1000;

rbx.setOptions({ show_deprecation_warnings: false });
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.static("public"));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many requests, slow down." }
});
app.use(limiter);

async function startApp() {
  try {
    await rbx.setCookie(cookie);
    const currentUser = await rbx.getAuthenticatedUser();
    console.log(`✅ Logged in as ${currentUser.name}`);
  } catch (err) {
    console.error("❌ Failed to log in:", err);
    process.exit(1);
  }
}
startApp();

function logToDiscord(embed) {
  if (!webhookURL) return;
  axios.post(webhookURL, { embeds: [embed] }).catch(() => {});
}

async function createEmbed(action, userId, username, rankName, rankId, trainerId) {
  return {
    title: `📋 ${action.toUpperCase()} Action`,
    color:
      action === "promote" ? 0x2ecc71 :
      action === "demote" ? 0xe74c3c :
      0xf1c40f,
    fields: [
      { name: "👤 Target User", value: `${username} (${userId})`, inline: true },
      { name: "🎖 Rank", value: `${rankName} (Rank ${rankId})`, inline: true },
      { name: "🛠 Executor", value: `<@${trainerId}>`, inline: true },
      { name: "⏱ Time", value: new Date().toLocaleString(), inline: false }
    ],
    timestamp: new Date()
  };
}

app.use((req, res, next) => {
  if (req.path.startsWith("/api") && req.headers.authorization !== `Bearer ${maintainerKey}`) {
    return res.status(403).json({ error: "MaintainerKey required" });
  }
  next();
});

app.get("/api/status", (req, res) => {
  res.json({ online: true, message: "API is online", time: new Date().toISOString() });
});

app.get("/api/roles", async (req, res) => {
  try {
    const roles = await rbx.getRoles(groupId);
    res.json(roles.map(r => ({ rank: r.rank, name: r.name })));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch roles", details: err.message });
  }
});

app.post("/api/:action(promote|demote|setrank)", async (req, res) => {
  const { userid, trainerid, rank } = req.body;
  if (!userid || !trainerid) return res.status(400).json({ error: "Missing parameters" });

  try {
    const targetUserId = isNaN(userid) ? await rbx.getIdFromUsername(userid) : parseInt(userid);
    const roles = await rbx.getRoles(groupId);
    const currentRank = await rbx.getRankInGroup(groupId, targetUserId);

    let targetRank;
    if (req.params.action === "promote") targetRank = roles.find(r => r.rank > currentRank)?.rank;
    else if (req.params.action === "demote") targetRank = [...roles].reverse().find(r => r.rank < currentRank)?.rank;
    else if (req.params.action === "setrank") targetRank = parseInt(rank);

    if (!targetRank) return res.status(400).json({ error: "Invalid rank change" });

    await rbx.setRank(groupId, targetUserId, targetRank);
    const username = await rbx.getUsernameFromId(targetUserId);
    const rankInfo = roles.find(r => r.rank === targetRank);
    const embed = await createEmbed(req.params.action, targetUserId, username, rankInfo.name, targetRank, trainerid);
    logToDiscord(embed);

    res.json({ success: true, message: `User ${req.params.action}d to ${rankInfo.name} (Rank ${targetRank})` });
  } catch (err) {
    res.status(500).json({ error: "Failed to change rank", details: err.message });
  }
});

app.get("/api/userinfo", async (req, res) => {
  const { identifier } = req.query;
  if (!identifier) return res.status(400).json({ error: "Missing identifier" });

  try {
    const userId = isNaN(identifier) ? await rbx.getIdFromUsername(identifier) : parseInt(identifier);
    const username = await rbx.getUsernameFromId(userId);
    const avatar = await rbx.getPlayerThumbnail(userId, 150, "png", true, "headshot");
    res.json({ success: true, user: { id: userId, username, avatar: avatar[0]?.imageUrl || "" } });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch user info" });
  }
});

app.post("/api/restart", (req, res) => {
  res.json({ message: "Restarting service..." });
  setTimeout(() => process.exit(0), 1000);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌍 Server running on port ${PORT}`);

  const parsedUrl = url.parse(SELF_URL);
  const getModule = parsedUrl.protocol === "https:" ? https : http;

  setInterval(() => {
    getModule.get(SELF_URL, res => console.log(`🔔 Self-ping responded with status ${res.statusCode}`))
      .on("error", err => console.error(`❌ Self-ping error: ${err.message}`));
  }, PING_INTERVAL);

  setTimeout(() => {
    console.log("🔄 Restarting process to avoid idle...");
    process.exit(0);
  }, RESTART_INTERVAL);
});
