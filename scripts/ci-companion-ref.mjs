import { appendFileSync, readFileSync } from "node:fs";

const ref = JSON.parse(readFileSync(new URL("../companion-ref.json", import.meta.url), "utf8"));
if (!/^[a-f0-9]{40}$/.test(ref.revision) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ref.repository) ||
    !/^\d+\.\d+\.\d+$/.test(ref.piVersion)) {
  throw new Error("Malformed tested companion reference.");
}
if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
appendFileSync(process.env.GITHUB_OUTPUT,
  `repository=${ref.repository}\nrevision=${ref.revision}\npiVersion=${ref.piVersion}\n`);
