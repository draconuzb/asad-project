const http = require("http");
const crypto = require("crypto");
const { execSync } = require("child_process");
const fs = require("fs");

const PORT = 9000;
const SECRET = process.env.WEBHOOK_SECRET || "asad-deploy-secret-2026";
const APP_DIR = "/home/ubuntu/asad-project";
const LOG_FILE = APP_DIR + "/logs/deploy.log";

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  console.log(line.trim());
  fs.appendFileSync(LOG_FILE, line);
}

function verifySignature(payload, signature) {
  if (!signature) return false;
  const hmac = crypto.createHmac("sha256", SECRET);
  hmac.update(payload);
  const digest = "sha256=" + hmac.digest("hex");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/deploy") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      const signature = req.headers["x-hub-signature-256"];
      if (!verifySignature(body, signature)) {
        log("REJECTED: Invalid signature");
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      try {
        const payload = JSON.parse(body);
        if (payload.ref !== "refs/heads/main") {
          log("SKIP: Push to " + payload.ref + " (not main)");
          res.writeHead(200);
          res.end("Skipped: not main branch");
          return;
        }

        log("DEPLOY START: " + (payload.head_commit?.message || "no message"));
        res.writeHead(200);
        res.end("Deploying...");

        // Run deploy in background
        try {
          execSync(`cd ${APP_DIR} && git pull origin main 2>&1`, { timeout: 30000 });
          log("Git pull: OK");
          execSync(`cd ${APP_DIR} && npm ci --production 2>/dev/null || npm install --production 2>&1`, { timeout: 120000 });
          log("npm install: OK");
          execSync(`cd ${APP_DIR}/gui && npm ci --production 2>/dev/null || npm install --production 2>&1`, { timeout: 60000 });
          log("GUI npm install: OK");
          execSync(`cd ${APP_DIR} && pm2 restart ecosystem.config.js --update-env 2>&1`, { timeout: 15000 });
          log("PM2 restart: OK");
          log("DEPLOY COMPLETE!");
        } catch (err) {
          log("DEPLOY ERROR: " + err.message);
        }
      } catch (err) {
        log("Parse error: " + err.message);
        res.writeHead(400);
        res.end("Bad request");
      }
    });
  } else if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    res.end("OK");
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  log("Webhook server listening on port " + PORT);
});
