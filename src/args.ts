import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";

export const usage = `usage: auto-qa run [playwright test args...] --base-url <url>
         [--scratch <spec file or dir>]... [--out <dir>] [--allow-remote]
       auto-qa triage <manifest.json> [--base <git ref>]
       auto-qa guard [--base <git ref>] [paths...]
       auto-qa cleanup

run passes other flags to \`playwright test\` (--headed, --grep, --workers).
With --allow-remote, only tests with @prod-safe in their title run.`;

// Removes `--name <value>` from args and returns the value.
export const option = (args: string[], name: string) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args.splice(at, 2)[1];
};

// Local means served from this machine: a loopback name, or a name whose
// every address is one of this machine's own, such as its LAN or tailnet name.
const isLocal = async (hostname: string) => {
  if (/(^|\.)localhost$|^127\.0\.0\.1$|^\[::1\]$/.test(hostname)) return true;
  const own = Object.values(networkInterfaces()).flatMap((addresses) =>
    addresses!.map(({ address }) => address)
  );
  const found = await lookup(hostname.replace(/^\[|\]$/g, ""), {
    all: true,
  }).catch(() => []);
  return (
    found.length > 0 && found.every(({ address }) => own.includes(address))
  );
};

export const parse = async (args: string[]) => {
  const baseUrl = option(args, "--base-url");
  const out = option(args, "--out");
  const scratch: string[] = [];
  for (let spec; (spec = option(args, "--scratch"));)
    scratch.push(resolve(spec));
  const playwright = args.filter((arg) => arg !== "--allow-remote");
  if (playwright.includes("--")) throw new Error("`--` is not supported");
  if (!baseUrl) throw new Error(`--base-url is required\n${usage}`);
  const local = await isLocal(new URL(baseUrl).hostname);
  if (!local && !args.includes("--allow-remote")) {
    throw new Error(
      `${baseUrl} is not served from this machine; pass --allow-remote to run only @prod-safe tests`
    );
  }
  return { baseUrl, out, local, scratch, playwright };
};
