const https = require("https");
const dns = require("dns");
const net = require("net");
const fs = require("fs");

const results = [];

// 1. Get current public IP
function getPublicIP() {
  return new Promise((resolve) => {
    https.get("https://api.ipify.org", (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data.trim()));
    }).on("error", () => resolve(null));
  });
}

// 2. Test TCP connection
function testPort(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeout = setTimeout(() => { socket.destroy(); resolve(false); }, 5000);
    socket.connect(port, host, () => { clearTimeout(timeout); socket.destroy(); resolve(true); });
    socket.on("error", () => { clearTimeout(timeout); resolve(false); });
  });
}

(async () => {
  // Check if node_modules exists
  results.push("=== Node Modules Check ===");
  results.push("node_modules exists: " + fs.existsSync("node_modules"));
  results.push("dotenv exists: " + (fs.existsSync("node_modules/dotenv") || fs.existsSync("node_modules/dotenv/package.json")));
  results.push("mongoose exists: " + (fs.existsSync("node_modules/mongoose") || fs.existsSync("node_modules/mongoose/package.json")));

  // Load .env manually if dotenv isn't available
  let env = {};
  if (fs.existsSync(".env")) {
    const envContent = fs.readFileSync(".env", "utf8");
    envContent.split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
        const [key, ...rest] = trimmed.split("=");
        let val = rest.join("=").trim();
        // Remove inline comments
        const commentIdx = val.indexOf("#");
        if (commentIdx > 0) val = val.substring(0, commentIdx).trim();
        env[key.trim()] = val;
      }
    });
  }

  results.push("\n=== .env Values ===");
  results.push("MONGO_USER: " + (env.MONGO_USER || "(not set)"));
  results.push("MONGO_HOST: " + (env.MONGO_HOST || "(not set)"));
  results.push("MONGO_DB_NAME: " + (env.MONGO_DB_NAME || "(not set)"));

  // Build URI
  const MONGO_USER = encodeURIComponent(env.MONGO_USER || "");
  const MONGO_PASSWORD = encodeURIComponent(env.MONGO_PASSWORD || "");
  const MONGO_URI = `mongodb+srv://${MONGO_USER}:${MONGO_PASSWORD}@${env.MONGO_HOST}/${encodeURIComponent(env.MONGO_DB_NAME || "")}`;
  results.push("MONGO_URI: " + MONGO_URI.replace(/:[^:@]+@/, ":***@"));

  // Get public IP
  const ip = await getPublicIP();
  results.push("\n=== Public IP ===");
  results.push("Your public IP: " + (ip || "Could not determine (no internet access from this environment)"));

  // DNS resolution
  results.push("\n=== DNS Resolution ===");
  try {
    const records = dns.resolveSrv("_mongodb._tcp.cluster0.lbihmuj.mongodb.net");
    results.push("SRV records found: " + records.length);
    records.forEach((r) => results.push("  -> " + r.target + ":" + r.port + " (priority: " + r.priority + ")"));
  } catch (e) {
    results.push("SRV resolution error: " + e.message);
  }

  // Port tests
  results.push("\n=== Port Connectivity ===");
  const atlasHosts = [
    "cluster0-shard-00-00.lbihmuj.mongodb.net",
    "cluster0-shard-00-01.lbihmuj.mongodb.net",
    "cluster0-shard-00-02.lbihmuj.mongodb.net",
  ];

  for (const host of atlasHosts) {
    try {
      const addrs = await new Promise((resolve, reject) => {
        dns.lookup(host, { all: true }, (err, a) => err ? reject(err) : resolve(a));
      });
      for (const addr of addrs) {
        if (addr.family === 4) {
          const open = await testPort(addr.address, 27017);
          results.push("  " + host + " (" + addr.address + "):27017 -> " + (open ? "OPEN" : "CLOSED/FILTERED"));
        }
      }
    } catch (e) {
      results.push("  " + host + ": DNS failed - " + e.message);
    }
  }

  const output = results.join("\n");
  console.log(output);
  fs.writeFileSync("diag-output.txt", output);
})();
