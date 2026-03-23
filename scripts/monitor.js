import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { Blob } from "node:buffer";

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "monitor.config.json");

const BASELINES_DIR = path.join(ROOT, "baselines");
const TMP_DIR = path.join(ROOT, ".tmp");
const RUN_DIR = path.join(TMP_DIR, "run");
const DIFF_DIR = path.join(TMP_DIR, "diffs");

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function safeSlug(url) {
  const u = new URL(url);
  const raw = `${u.hostname}${u.pathname}`.replace(/\/+$/, "/");
  const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 10);
  const normalised = raw
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return `${normalised}__${hash}`;
}

async function ensureDirs() {
  await fsp.mkdir(BASELINES_DIR, { recursive: true });
  await fsp.mkdir(RUN_DIR, { recursive: true });
  await fsp.mkdir(DIFF_DIR, { recursive: true });
}

async function writeFileAtomic(filePath, buf) {
  const tmp = `${filePath}.tmp-${Date.now()}`;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, filePath);
}

async function fileExists(p) {
  try {
    await fsp.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function gitCommitIfNeeded(message) {
  const { execSync } = await import("node:child_process");
  const status = execSync("git status --porcelain", { encoding: "utf8" }).trim();
  if (!status) return false;

  execSync("git add -A", { stdio: "inherit" });
  execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { stdio: "inherit" });
  execSync("git push", { stdio: "inherit" });
  return true;
}

function pngFromBuffer(buf) {
  return PNG.sync.read(buf);
}

function pngToBuffer(png) {
  return PNG.sync.write(png, { colorType: 6 });
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function acceptCookieYesIfPresent(page) {
  const selectors = [
    ".cky-btn-accept",
    ".cky-btn-accept-all",
    "button.cky-btn-accept",
    "button:has-text('Accept')",
    "button:has-text('Accept All')",
    "button:has-text('I Accept')"
  ];

  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0) {
        await el.click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(500);
        return;
      }
    } catch {
      // ignore
    }
  }
}

async function injectStabilisation(page) {
  // STEP 1: Scroll the entire page to trigger lazy-loaded images AND entrance animations.
  // We let everything load and animate BEFORE freezing, so nothing is stuck mid-transition.
  await page.evaluate(async () => {
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const step = window.innerHeight;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await delay(200);
    }
    // Stay at bottom briefly to let final animations trigger
    await delay(500);
    // Scroll back to top
    window.scrollTo(0, 0);
    await delay(500);
  });

  // STEP 2: Wait for all animations and image loads to settle
  await page.waitForTimeout(2000);

  // STEP 3: NOW freeze everything with CSS — animations have already completed
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        animation: none !important;
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        transition: none !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
        scroll-behavior: auto !important;
        caret-color: transparent !important;
      }

      /* Hide CookieYes / overlays / revisit buttons */
      .cky-consent-container,
      .cky-overlay,
      .cky-consent-bar,
      .cky-revisit-bottom-left,
      .cky-btn-revisit-wrapper {
        visibility: hidden !important;
        opacity: 0 !important;
      }
    `
  });

  // STEP 4: Cover videos with a solid grey overlay (most reliable method —
  // stripping sources doesn't work because browsers cache the last frame)
  await page.evaluate(() => {
    for (const video of document.querySelectorAll("video")) {
      video.pause();

      // Find the positioning parent so we can overlay correctly
      const parent = video.parentElement;
      if (!parent) continue;

      const parentStyle = getComputedStyle(parent);
      if (parentStyle.position === "static") {
        parent.style.position = "relative";
      }

      // Create a grey overlay that sits exactly on top of the video
      const overlay = document.createElement("div");
      overlay.style.cssText = `
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        background: #808080;
        z-index: 9999;
        pointer-events: none;
      `;
      parent.appendChild(overlay);
    }
  });
}

/**
 * Capture a full-page screenshot using a FRESH page each time.
 * This avoids stacking route handlers and leftover state between URLs.
 */
async function captureFullPage(context, url, viewport) {
  const page = await context.newPage();

  try {
    await page.setViewportSize(viewport);

    // Register cache-busting route handler ONCE for this page
    await page.route("**/*", (route) => {
      const req = route.request();
      const headers = {
        ...req.headers(),
        "cache-control": "no-cache",
        pragma: "no-cache"
      };
      route.continue({ headers }).catch(() => {});
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await acceptCookieYesIfPresent(page);

    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

    // Stabilisation scrolls the page, lets animations complete, then freezes state
    await injectStabilisation(page);

    // Brief final settle after freezing
    await page.waitForTimeout(500);

    const buf = await page.screenshot({ fullPage: true, type: "png" });
    return buf;
  } finally {
    await page.close();
  }
}

/**
 * Capture with retry logic — tries up to maxRetries times with a delay between.
 */
async function captureWithRetry(context, url, viewport, maxRetries = 2) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await captureFullPage(context, url, viewport);
    } catch (e) {
      lastError = e;
      console.warn(`[attempt ${attempt}/${maxRetries}] Capture failed for ${url}: ${e.message}`);
      if (attempt < maxRetries) {
        // Wait a bit before retrying (escalating delay)
        await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
    }
  }
  throw lastError;
}

function diffPngs(baselineBuf, currentBuf, pixelmatchThreshold) {
  const img1 = pngFromBuffer(baselineBuf);
  const img2 = pngFromBuffer(currentBuf);

  const width = Math.max(img1.width, img2.width);
  const height = Math.max(img1.height, img2.height);

  function padTo(img) {
    if (img.width === width && img.height === height) return img;
    const out = new PNG({ width, height });
    PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
    return out;
  }

  const a = padTo(img1);
  const b = padTo(img2);

  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, width, height, {
    threshold: pixelmatchThreshold,
    includeAA: false,
    alpha: 0.1
  });

  const totalPixels = width * height;
  const ratio = diffPixels / totalPixels;

  return { diffBuf: pngToBuffer(diff), diffPixels, totalPixels, ratio };
}

async function sendMailgunEmail({ subject, text, attachments }) {
  const apiKey = mustEnv("MAILGUN_API_KEY");
  const domain = mustEnv("MAILGUN_DOMAIN");
  const baseUrl = (process.env.MAILGUN_BASE_URL || "https://api.mailgun.net").replace(/\/+$/, "");
  const to = mustEnv("ALERT_EMAIL_TO");
  const from = process.env.MAIL_FROM || `Milltech Monitor <postmaster@${domain}>`;

  const form = new FormData();
  form.set("from", from);
  form.set("to", to);
  form.set("subject", subject);
  form.set("text", text);

  for (const a of attachments) {
    const buf = await fsp.readFile(a.path);
    form.append("attachment", new Blob([buf]), a.name);
  }

  const auth = Buffer.from(`api:${apiKey}`).toString("base64");
  const res = await fetch(`${baseUrl}/v3/${domain}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`
    },
    body: form
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Mailgun send failed: ${res.status} ${res.statusText}\n${body}`);
  }
}

async function createZip(inputDir, outZipPath) {
  const { execFile } = await import("node:child_process");
  await new Promise((resolve, reject) => {
    execFile(
      "bash",
      ["-lc", `cd "${inputDir.replace(/"/g, '\\"')}" && zip -r "${outZipPath.replace(/"/g, '\\"')}" .`],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

async function main() {
  const cfg = readJson(CONFIG_PATH);
  const urls = cfg.urls;
  const viewport = cfg.viewport;
  const pixelmatchThreshold = cfg.diff.pixelmatchThreshold;
  const changeThresholdRatio = cfg.diff.changeThresholdRatio;

  await ensureDirs();

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox", "--disable-setuid-sandbox"]
  });

  const context = await browser.newContext({
    locale: "en-GB",
    timezoneId: "Europe/London",
    // Use a standard Chrome user agent so sites don't block us
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  });

  const changes = [];
  const failures = [];
  let seededBaselines = 0;

  for (const url of urls) {
    const slug = safeSlug(url);
    const baselinePath = path.join(BASELINES_DIR, `${slug}.png`);
    const currentPath = path.join(RUN_DIR, `${slug}.png`);
    const diffPath = path.join(DIFF_DIR, `${slug}.diff.png`);

    let currentBuf;
    try {
      currentBuf = await captureWithRetry(context, url, viewport);
    } catch (e) {
      console.error(`CAPTURE FAILED (all retries) for ${url}: ${e.message}`);
      failures.push({ url, error: String(e?.message || e) });
      continue;
    }

    await writeFileAtomic(currentPath, currentBuf);

    const hasBaseline = await fileExists(baselinePath);
    if (!hasBaseline) {
      await writeFileAtomic(baselinePath, currentBuf);
      seededBaselines += 1;
      console.log(`Seeded baseline for ${url}`);
      continue;
    }

    const baselineBuf = await fsp.readFile(baselinePath);
    const { diffBuf, ratio, diffPixels, totalPixels } = diffPngs(
      baselineBuf,
      currentBuf,
      pixelmatchThreshold
    );

    const changed = ratio >= changeThresholdRatio;

    if (changed) {
      await writeFileAtomic(diffPath, diffBuf);
      changes.push({ url, ratio, diffPixels, totalPixels });
      await writeFileAtomic(baselinePath, currentBuf);
      console.log(`Change detected: ${url} (${(ratio * 100).toFixed(3)}%)`);
    } else {
      console.log(`No change: ${url}`);
    }
  }

  await context.close();
  await browser.close();

  // Commit baselines if we seeded any, or if we updated baselines due to changes.
  if (seededBaselines > 0 || changes.length > 0) {
    const msg =
      seededBaselines > 0 && changes.length === 0
        ? `Seed baselines (${seededBaselines})`
        : `Update baselines (${changes.length} change(s))`;
    await gitCommitIfNeeded(msg);
  }

  // Only email if there are real visual changes.
  // Capture failures alone don't trigger email (avoids noisy alerts when site is temporarily down).
  if (!changes.length) {
    if (failures.length) {
      console.warn(`${failures.length} URL(s) failed to capture but no visual changes detected. No email sent.`);
    }
    return;
  }

  const emailCfg = cfg.email || {};
  const maxPngs = emailCfg.attachMaxPngs ?? 6;
  const maxBytes = emailCfg.maxAttachmentBytes ?? 20000000;

  const attachments = [];
  let attachmentBytes = 0;

  const diffFilesAll = (await fsp.readdir(DIFF_DIR)).filter((f) => f.endsWith(".diff.png"));
  if (diffFilesAll.length) {
    const zipPath = path.join(TMP_DIR, "diffs.zip");
    await createZip(DIFF_DIR, zipPath);
    const zipStat = await fsp.stat(zipPath);
    attachments.push({ name: "diffs.zip", path: zipPath });
    attachmentBytes += zipStat.size;

    for (const f of diffFilesAll.slice(0, maxPngs)) {
      const p = path.join(DIFF_DIR, f);
      const st = await fsp.stat(p);
      if (attachmentBytes + st.size > maxBytes) break;
      attachments.push({ name: f, path: p });
      attachmentBytes += st.size;
    }
  }

  const lines = [];
  lines.push(`Visual change detected (${changes.length} URL(s)).`);
  lines.push("");

  for (const c of changes) {
    lines.push(`- ${c.url}`);
    lines.push(`  Diff ratio: ${(c.ratio * 100).toFixed(3)}% (${c.diffPixels}/${c.totalPixels})`);
  }

  // Mention failures in the email body if any, but they didn't trigger the email
  if (failures.length) {
    lines.push("");
    lines.push(`Note: ${failures.length} URL(s) failed to capture (timeout/connection error):`);
    for (const f of failures) {
      lines.push(`- ${f.url}`);
    }
  }

  lines.push("");
  if (attachments.length) {
    lines.push(`Attachments: ${attachments.map((a) => a.name).join(", ")} (total ${bytes(attachmentBytes)})`);
  }

  await sendMailgunEmail({
    subject: `Milltech visual change detected (${changes.length})`,
    text: lines.join("\n"),
    attachments
  });

  console.log(`Email sent: ${changes.length} change(s), ${failures.length} failure(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
