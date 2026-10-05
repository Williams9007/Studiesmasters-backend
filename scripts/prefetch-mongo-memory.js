// One-off helper: pre-download the mongodb-memory-server binary into a stable
// local cache (MONGOMS_DOWNLOAD_DIR) so the test suite does not re-fetch the
// ~500MB mongod binary on every run.
import mongodbMemoryServer from "mongodb-memory-server";

const { MongoMemoryServer } = mongodbMemoryServer;
const server = await MongoMemoryServer.create();
console.log("MONGO_READY", server.getUri());
await server.stop();
