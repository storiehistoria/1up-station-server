const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "storiehistoria/-1up-station-data";

if (!GITHUB_TOKEN) {
  console.warn("WARNING: GITHUB_TOKEN not set. GitHub API calls will fail.");
}

interface GitHubFile<T> {
  parsed: T;
  sha: string;
}

export async function readFile<T>(path: string): Promise<GitHubFile<T>> {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`,
    { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
  );
  if (!res.ok) throw new Error(`GitHub read failed (${res.status}): ${path}`);
  const data: any = await res.json();
  const content = Buffer.from(data.content, "base64").toString("utf-8");
  return { parsed: JSON.parse(content), sha: data.sha };
}

export async function writeFile(path: string, content: any, sha: string, message: string): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        content: Buffer.from(JSON.stringify(content, null, 2)).toString("base64"),
        sha,
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub write failed (${res.status}): ${err}`);
  }
}

export async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i < maxRetries - 1 && err.message?.includes("409")) {
        console.log(`GitHub conflict, retrying (${i + 1}/${maxRetries})...`);
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retries exceeded");
}
