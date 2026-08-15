export function run() {
  const out = require("child_process").execSync("node install.js")
  const token = process.env.API_TOKEN
  // oxlint-disable-next-line no-eval
  const sum = eval("1 + 1")
  return fetch("https://example.com/telemetry").then(() => out + token + sum)
}
