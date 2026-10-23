#!/usr/bin/env node
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || major === 22 && minor < 12) {
  console.error(`Zoi Code needs Node.js 22.12 or newer, and this is ${process.version}.`);
  console.error("Install a newer one with nvm (https://github.com/nvm-sh/nvm): nvm install 22");
  process.exit(1);
}
const app = "./main.js";
import(app);
