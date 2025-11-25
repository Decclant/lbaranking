const express = require("express");
const rateLimit = require("express-rate-limit");
const rbx = require("noblox.js");
const http = require("http");
const https = require("https");
const url = require("url");

const app = express();

const cookie = process.env.COOKIE;
const apiKey = process.env.API_KEY;
const groupId = parseInt(process.env.GROUP_ID);
const SELF_URL = process.env.SELF_URL?.startsWith("http") ? process.env.SELF_URL : `https://${process.env.SELF_URL}`;

const PING_INTERVAL = 4 * 60 * 1000;
const RESTART_INTERVAL = 60 * 60 * 1000;

rbx.setOptions({ show_deprecation_warnings: false });
app.set("trust proxy", 1);
app.use(express.json());

const limiter = rateLimit({
  windowMs: 60000,
  max: 500,
  message: { error: "Too many requests" }
});
app.use(limiter);

async function startApp() {
  try {
    await rbx.setCookie(cookie);
    await rbx.getAuthenticatedUser();
  } catch {
    process.exit(1);
  }
}
startApp();

app.get("/api/status", (req, res) => {
  res.json({ online: true, time: new Date().toISOString() });
});

app.use((req, res, next) => {
  const key = req.query.key || req.headers["authorization"];
  if (key !== apiKey) return res.status(403).json({ error: "Invalid API key" });
  next();
});

app.get("/api/roles", async (req, res) => {
  try {
    const roles = await rbx.getRoles(groupId);
    res.json(roles.map(r => ({ rank: r.rank, name: r.name })));
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/api/:action(promote|demote|setrank)", async (req, res) => {
  const { userid, rank } = req.body;
  if (!userid) return res.status(400).json({ error: "Missing userid" });

  try {
    let targetUserId = isNaN(userid) ? await rbx.getIdFromUsername(userid) : parseInt(userid);
    const currentRank = await rbx.getRankInGroup(groupId, targetUserId);
    const roles = await rbx.getRoles(groupId);

    let targetRank;
    if (req.params.action === "promote") targetRank = roles.find(r => r.rank > currentRank)?.rank;
    else if (req.params.action === "demote") targetRank = [...roles].reverse().find(r => r.rank < currentRank)?.rank;
    else if (req.params.action === "setrank") {
      if (!rank) return res.status(400).json({ error: "Rank required" });
      targetRank = parseInt(rank);
    }

    if (!targetRank) return res.status(400).json({ error: "Invalid" });
    if (currentRank === targetRank) return res.json({ success: true });

    await rbx.setRank(groupId, targetUserId, targetRank);
    const username = await rbx.getUsernameFromId(targetUserId);
    res.json({ success: true, user: username, rank: targetRank });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/:action(promote|demote|setrank)", async (req, res) => {
  const userid = req.query.userid;
  const rank = req.query.rank;

  if (!userid) return res.status(400).json({ error: "Missing userid" });

  try {
    let targetUserId = isNaN(userid) ? await rbx.getIdFromUsername(userid) : parseInt(userid);
    const currentRank = await rbx.getRankInGroup(groupId, targetUserId);
    const roles = await rbx.getRoles(groupId);

    let targetRank;
    if (req.params.action === "promote") targetRank = roles.find(r => r.rank > currentRank)?.rank;
    else if (req.params.action === "demote") targetRank = [...roles].reverse().find(r => r.rank < currentRank)?.rank;
    else if (req.params.action === "setrank") {
      if (!rank) return res.status(400).json({ error: "Rank required" });
      targetRank = parseInt(rank);
    }

    if (!targetRank) return res.status(400).json({ error: "Invalid" });
    if (currentRank === targetRank) return res.json({ success: true });

    await rbx.setRank(groupId, targetUserId, targetRank);
    const username = await rbx.getUsernameFromId(targetUserId);
    res.json({ success: true, user: username, rank: targetRank });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  if (SELF_URL) {
    const parsedUrl = url.parse(SELF_URL);
    const getModule = parsedUrl.protocol === "https:" ? https : http;

    setInterval(() => {
      getModule.get(SELF_URL, () => {}).on("error", () => {});
    }, PING_INTERVAL);
  }
})
