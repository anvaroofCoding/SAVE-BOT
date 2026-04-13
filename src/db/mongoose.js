const mongoose = require("mongoose");
const env = require("../config/env");

async function connectMongo() {
  mongoose.set("strictQuery", true);
  await mongoose.connect(env.mongodbUri, {
    maxPoolSize: 10
  });
}

module.exports = { connectMongo };
