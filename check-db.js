import https from "https";
import dns from "dns";
import { execSync } from "child_process";

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

// 2. Resolve MongoDB Atlas hostname
function resolveHost(hostname) {
  return new Promise((resolve) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) {
        console.log("DNS_ERROR:", err.message);
        resolve([]);
      } else {
        resolve(addresses);
      }
    });
  });
}

// 3. Test TCP connection to a port
function testPort(host, port) {
  return new Promise((resolve) => {
    const net = require("net");
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
  const fs = require("fs");
  const results = [];

  const ip = await getPublicIP();
  results.push(`=== Public IP ===`);
  results.push(ip ? `Current Public IP: ${ip}` : `Could not determine public IP`);

  results.push(`\n=== DNS Resolution ===`);
  // The mongodb+srv record resolves to a different hostname for the SRV record
  try {
    const records = dns.resolveSrv("_mongodb._tcp.cluster0.lbihmuj.mongodb.net");
    results.push(`SRV records found: ${records.length}`);
    records.forEach((r) => results.push(`  ${r.name} -> ${r.target}:${r.port} (priority: ${r.priority}, weight: ${r.weight})`));
  } catch (e) {
    results.push(`SRV resolution error: ${e.message}`);
  }

  const addresses = await resolveHost("cluster0.lbihmuj.mongodb.net");
  results.push(`\n=== Direct Host Resolution ===`);
  addresses.forEach((a) => results.push(`  ${a.family === 6 ? "IPv6" : "IPv4"}: ${a.address}`));

  // Test connectivity to each resolved address on port 27017 (standard) and 27018 (Atlas SRV alternative)
  results.push(`\n=== Port Connectivity Tests ===`);
  const hosts = addresses.map((a) => a.address).filter((a) => !a.includes(":")); // IPv4 only
  // Also add the SRV targets if available
  const allHosts = [...new Set(hosts)];

  for (const host of allHosts) {
    const port27017 = await testPort(host, 27017);
    const port27018 = await testPort(host, 27018);
    const port27019 = await testPort(host, 27019);
    results.push(`  ${host}:27017 -> ${port27017 ? "OPEN" : "CLOSED/FILTERED"}`);
    results.push(`  ${host}:27018 -> ${port27018 ? "OPEN" : "CLOSED/FILTERED"}`);
    results.push(`  ${host}:27019 -> ${port27019 ? "OPEN" : "CLOSED/FILTERED"}`);
  }

  results.push(`\n=== .env Configuration ===`);
  results.push(`MONGO_USER: ${process.env.MONGO_USER || "(not set)"}`);
  results.push(`MONGO_PASSWORD: ${process.env.MONGO_PASSWORD ? "***" + process.env.MONGO_PASSWORD.length + " chars ***" : "(not set)"}`);
  results.push(`MONGO_HOST: ${process.env.MONGO_HOST || "(not set)"}`);
  results.push(`MONGO_DB_NAME: ${process.env.MONGO_DB_NAME || "(not set)"}`);

  // Build the URI like db.js does
  const MONGO_URI = `mongodb+srv://${encodeURIComponent(process.env.MONGO_USER)}:${encodeURIComponent(process.env.MONGO_PASSWORD)}@${process.env.MONGO_HOST}/${encodeURIComponent(process.env.MONGO_DB_NAME)}`;
  results.push(`Constructed MONGO_URI: ${MONGO_URI.replace(/:[^:@]+@/, ":***@")}`);

  const output = results.join("\n");
  console.log(output);
  fs.writeFileSync("check-db-results.txt", output);
})();
