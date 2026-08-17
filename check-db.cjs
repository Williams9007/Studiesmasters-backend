const https = require("https");
const dns = require("dns");
const net = require("net");
const fs = require("fs");
require("dotenv").config();

// 1. Get current public IP
function getPublicIP() {
  return new Promise((resolve) => {
    https.get("https://api.ipify.org", (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data.trim()));
    }).on("error", (e) => {
      console.log("IP_LOOKUP_ERROR:", e.message);
      resolve(null);
    });
  });
}

// 2. Test TCP connection to a port
function testPort(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 5000);
    socket.connect(port, host, () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

// Main
(async () => {
  const results = [];

  const ip = await getPublicIP();
  results.push("=== Public IP ===");
  results.push(ip ? `Current Public IP: ${ip}` : "Could not determine public IP (no internet access?)");

  results.push("\n=== DNS Resolution (SRV record) ===");
  try {
    const records = dns.resolveSrv("_mongodb._tcp.cluster0.lbihmuj.mongodb.net");
    results.push(`SRV records found: ${records.length}`);
    records.forEach((r) => results.push(`  ${r.name} -> ${r.target}:${r.port} (priority: ${r.priority}, weight: ${r.weight})`));
  } catch (e) {
    results.push(`SRV resolution error: ${e.message}`);
  }

  results.push("\n=== Port Connectivity Tests ===");
  // Atlas SRV typically points to: cluster0-shard-00-00/01/02.lbihmuj.mongodb.net on port 27017
  const atlasHosts = [
    "cluster0-shard-00-00.lbihmuj.mongodb.net",
    "cluster0-shard-00-01.lbihmuj.mongodb.net",
    "cluster0-shard-00-02.lbihmuj.mongodb.net",
  ];

  for (const host of atlasHosts) {
    try {
      const addresses = await new Promise((resolve, reject) => {
        dns.lookup(host, { all: true }, (err, addrs) => {
          if (err) reject(err);
          else resolve(addrs);
        });
      });
      for (const addr of addresses) {
        if (addr.family === 4) {
          const open = await testPort(addr.address, 27017);
          results.push(`  ${host} (${addr.address}):27017 -> ${open ? "OPEN" : "CLOSED/FILTERED"}`);
        }
      }
    } catch (e) {
      results.push(`  ${host}: DNS resolution failed - ${e.message}`);
    }
  }

  results.push("\n=== .env Configuration ===");
  results.push(`MONGO_USER: ${process.env.MONGO_USER || "(not set)"}`);
  results.push(`MONGO_PASSWORD: ${process.env.MONGO_PASSWORD ? "***" + process.env.MONGO_PASSWORD.length + " chars ***" : "(not set)"}`);
  results.push(`MONGO_HOST: ${process.env.MONGO_HOST || "(not set)"}`);
  results.push(`MONGO_DB_NAME: ${process.env.MONGO_DB_NAME || "(not set)"}`);

  const MONGO_URI = `mongodb+srv://${encodeURIComponent(process.env.MONGO_USER)}:${encodeURIComponent(process.env.MONGO_PASSWORD)}@${process.env.MONGO_HOST}/${encodeURIComponent(process.env.MONGO_DB_NAME)}`;
  results.push(`Constructed MONGO_URI: ${MONGO_URI.replace(/:[^:@]+@/, ":***@")}`);

  const output = results.join("\n");
  console.log(output);
  fs.writeFileSync("check-db-results.txt", output);
})();
