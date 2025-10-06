// src/automator.js
// Fast & stateless watcher that ONLY targets rows whose form has an
// accept control (#ctrl_accept or [name="accept"]) and NEVER submits cancel.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const AUTH_STATE_PATH = path.resolve(process.cwd(), "auth.json");

class UmzugAutomator {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;

    this.browser = null;
    this.context = null;
    this.page = null;

    this.ready = false;
    this.isLoggedIn = false;
    this.keepAliveTimer = null;

    this._watcherRunning = false;
    this._watcherPromise = null;
    this._consoleHooked = false;

    this.stats = {
      lastTick: 0,
      accepted: 0,
      tried: 0,
      errors: 0,
      lastError: null,
      lastAcceptKey: null,
    };
  }

  async initialize() {
    this.log.info("Launching Chromium… ");

    if (!this.cfg.username || !this.cfg.password) {
      throw new Error("LOGIN_USERNAME and LOGIN_PASSWORD must be provided");
    }

    this.browser = await chromium.launch({
      headless: this.cfg.headless,
      args: [
        "--headless=new",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--disable-gpu",
        "--use-gl=disabled",
        "--no-zygote",
      ],
    });

    const ctxOpts = fs.existsSync(AUTH_STATE_PATH)
      ? { storageState: AUTH_STATE_PATH }
      : {};
    this.context = await this.browser.newContext(ctxOpts);

    this.page = await this.context.newPage({
      viewport: { width: 1280, height: 800 },
    });
    this.page.setDefaultTimeout(25000);
    await this._blockNonEssentialRequests();

    await this.page.goto(this.cfg.baseUrl + "/", {
      waitUntil: "networkidle",
    });
    await this._dismissOverlays();
    await this._ensureAuthenticated();

    const ok = await this._openMeineJobsViaMeineDaten();
    if (!ok) throw new Error("Could not open Meine Jobs");

    this.ready = true;
    this.isLoggedIn = true;
    this._startKeepAlive();

    this.log.info("Automator ready");
  }

  /* -------------------------------- LOGIN ---------------------------------- */

  async _ensureAuthenticated() {
    const atLogin =
      this.page.url().includes("/login") ||
      (await this.page
        .locator('input[name="username"], #username')
        .first()
        .isVisible()
        .catch(() => false));

    if (atLogin) {
      this.log.warn("Session expired — logging in…");
      await this._login();
    }
  }

  async _login() {
    await this.page.goto(this.cfg.baseUrl + "/login", {
      waitUntil: "networkidle",
    });
    await this._dismissOverlays();

    await this.page.fill(
      'input[name="username"], #username',
      this.cfg.username
    );
    await this.page.fill(
      'input[name="password"], #password',
      this.cfg.password
    );

    await this.page.evaluate(() => {
      const killers = [
        "cms-accept-tags",
        ".mod_cms_accept_tags",
        ".cookiebar",
        ".mod_cookiebar",
      ];
      for (const sel of killers)
        document.querySelectorAll(sel).forEach((el) => el.remove());
      document.body.classList.remove("cookie-bar-visible");
    });

    await this.page.evaluate(() => {
      const form =
        document.querySelector('form[id^="tl_login_"]') ||
        document.querySelector('form[action*="/login"]') ||
        document.querySelector("form");
      if (!form) throw new Error("Login form not found");
      const btn = form.querySelector(
        'button[type="submit"], input[type="submit"]'
      );
      if (form.requestSubmit) form.requestSubmit(btn || undefined);
      else form.submit();
    });

    const moved = await Promise.race([
      this.page
        .waitForURL(/\/intern\/(meine-(daten|jobs))/, { timeout: 8000 })
        .then(() => true)
        .catch(() => false),
      this.page
        .waitForNavigation({ waitUntil: "networkidle", timeout: 8000 })
        .then(() => true)
        .catch(() => false),
    ]);

    if (!moved || this.page.url().includes("/login")) {
      throw new Error("Login failed - still on /login");
    }

    await this.context.storageState({ path: AUTH_STATE_PATH });
    this.isLoggedIn = true;
    this.log.info("Logged in");
  }

  /* --------------------- NAVIGATION TO MEINE JOBS PAGE --------------------- */

  async _openMeineJobsViaMeineDaten() {
    if (this.page.url().includes("/intern/meine-jobs")) {
      const has = await this._hasJobsInLiveDOM(true);
      if (has) return true;
    }

    await this.page.goto(this.cfg.baseUrl + "/intern/meine-daten", {
      waitUntil: "networkidle",
    });
    await this._dismissOverlays();
    await this._ensureAuthenticated();

    const link = this.page.locator('a[href*="intern/meine-jobs"]').first();
    const hasLink = await link.isVisible().catch(() => false);

    if (hasLink) {
      await Promise.allSettled([
        this.page.waitForURL(/\/intern\/meine-jobs/, { timeout: 10000 }),
        this.page.waitForLoadState("networkidle", { timeout: 10000 }),
        link.click(),
      ]);
    } else {
      await this.page.goto(this.cfg.baseUrl + "/intern/meine-jobs", {
        waitUntil: "networkidle",
      });
    }

    await this._dismissOverlays();
    await this._ensureAuthenticated();

    // Include accept button as a readiness signal
    await this.page
      .waitForSelector(
        "span.date.location, div.entry, form button#ctrl_accept",
        { timeout: 8000 }
      )
      .catch(() => {});
    const live = await this._hasJobsInLiveDOM(true);
    if (live) return true;

    await this.page.reload({ waitUntil: "networkidle" }).catch(() => {});
    await this._dismissOverlays();
    await this._ensureAuthenticated();
    return await this._hasJobsInLiveDOM(true);
  }

  async _hasJobsInLiveDOM(trySoft = false) {
    // Strongest signal: there are entries with an ACCEPT control (and not cancel)
    const acceptCount = await this.page
      .locator(
        'div.entry form button#ctrl_accept, div.entry form [name="accept"]'
      )
      .count()
      .catch(() => 0);
    if (acceptCount > 0) return true;

    const liveCount = await this.page
      .locator("span.date.location")
      .count()
      .catch(() => 0);
    if (liveCount > 0) return true;

    const entryCount = await this.page
      .locator("div.entry")
      .count()
      .catch(() => 0);
    if (entryCount > 0) return true;

    if (trySoft) {
      try {
        const rows = await this._softRefreshJobsInPage();
        return rows && rows.length > 0;
      } catch (_) {}
    }
    return false;
  }

  /* ------------------------------- WATCHER --------------------------------- */

  async startWatcher() {
    if (this._watcherRunning) return;
    this._watcherRunning = true;

    if (!this._consoleHooked) {
      this.page.on("console", (msg) => {
        const t = msg.type();
        if (["log", "info", "warn", "error"].includes(t)) {
          const text = msg.text();
          if (/^\[WATCHER]/.test(text)) this.log.info(text);
        }
      });
      this._consoleHooked = true;
    }

    const loop = async () => {
      while (this._watcherRunning) {
        try {
          const ok = await this._refreshMeineJobs();
          if (!ok) {
            await this._sleep(this.cfg.pollMs);
            continue;
          }

          // One scan+accept pass inside the page
          const result = await this.page.evaluate(
            async ({ maxPerTick }) => {
              const keyOf = (el) => {
                const loc =
                  el.querySelector("span.date.location")?.textContent?.trim() ||
                  "";
                const id =
                  (el.textContent || "").match(/#\s?(\d{4,7})/)?.[1] || "";
                return id ? `#${id}` : loc;
              };

              if (!window.__seenKeys) window.__seenKeys = new Set();

              const resp = await fetch("/intern/meine-jobs", {
                credentials: "include",
                cache: "no-store",
              });
              if (!resp.ok) {
                console.log(`[WATCHER] fetch list failed: ${resp.status}`);
                return { accepted: 0, tried: 0, errors: 1 };
              }
              const html = await resp.text();

              // bounced to login?
              if (
                /name=["']username["']|id=["']username["']/i.test(html) &&
                /type=["']password["']/i.test(html)
              ) {
                return { accepted: 0, tried: 0, errors: 0, needLogin: true };
              }

              const doc = new DOMParser().parseFromString(html, "text/html");

              // ONLY entries whose form has an ACCEPT control; NEVER cancel
              let entries = [...doc.querySelectorAll("div.entry")].filter(
                (e) => {
                  const form = e.querySelector("form");
                  if (!form) return false;
                  if (form.querySelector("#ctrl_cancel,[name='cancel']"))
                    return false; // <- guard
                  return !!form.querySelector("#ctrl_accept,[name='accept']");
                }
              );

              // Prefer unseen entries in this session
              const newbies = [];
              for (const el of entries) {
                const k = keyOf(el);
                if (!k) continue;
                if (!window.__seenKeys.has(k)) newbies.push({ key: k, el });
              }

              let accepted = 0,
                tried = 0,
                errors = 0,
                lastAcceptKey = null;

              for (const { key, el } of newbies.slice(0, maxPerTick)) {
                tried++;

                const form = el.querySelector("form");
                if (!form) {
                  errors++;
                  window.__seenKeys.add(key);
                  continue;
                }

                // Must be the accept control (no generic submit fallback)
                const acceptBtn = form.querySelector(
                  "#ctrl_accept,[name='accept']"
                );
                if (!acceptBtn) {
                  errors++;
                  window.__seenKeys.add(key);
                  continue;
                }

                const fd = new FormData(form);
                if (acceptBtn.name)
                  fd.set(acceptBtn.name, acceptBtn.value || "1");

                const action = form.getAttribute("action") || location.href;
                const method = (
                  form.getAttribute("method") || "POST"
                ).toUpperCase();

                try {
                  const r = await fetch(action, {
                    method,
                    body: fd,
                    credentials: "include",
                    redirect: "follow",
                  });
                  if (r.ok) {
                    accepted++;
                    lastAcceptKey = key;
                  } else {
                    errors++;
                  }
                } catch (_) {
                  errors++;
                } finally {
                  window.__seenKeys.add(key);
                }
              }

              // mark everything we looked at this tick
              for (const el of entries) {
                const k = keyOf(el);
                if (k) window.__seenKeys.add(k);
              }

              return { accepted, tried, errors, lastAcceptKey };
            },
            { maxPerTick: this.cfg.maxPerTick }
          );

          if (result?.needLogin) {
            await this._ensureAuthenticated();
          } else if (result) {
            this.stats.accepted += result.accepted || 0;
            this.stats.tried += result.tried || 0;
            this.stats.errors += result.errors || 0;
            if (result.lastAcceptKey)
              this.stats.lastAcceptKey = result.lastAcceptKey;
          }
        } catch (err) {
          this.stats.lastError = String(err?.message || err);
          await this._ensureAuthenticated();
        } finally {
          this.stats.lastTick = Date.now();
          const jitter = Math.floor(Math.random() * 150);
          await this._sleep(this.cfg.pollMs + jitter);
        }
      }
    };

    this._watcherPromise = loop();
    this.log.info(
      `Watcher started @ ${this.cfg.pollMs}ms, maxPerTick=${this.cfg.maxPerTick}`
    );
  }

  async stopWatcher() {
    this._watcherRunning = false;
    try {
      await this._watcherPromise;
    } catch {}
    this._watcherPromise = null;
  }

  /* ------------------------------- HELPERS --------------------------------- */

  // Return only rows that have an ACCEPT control (never cancel)
  async _softRefreshJobsInPage() {
    return await this.page.evaluate(async () => {
      const r = await fetch("/intern/meine-jobs", {
        credentials: "include",
        cache: "no-store",
      });
      if (!r.ok) return [];
      const html = await r.text();
      const d = new DOMParser().parseFromString(html, "text/html");
      const entries = [...d.querySelectorAll("div.entry")].filter((e) => {
        const form = e.querySelector("form");
        if (!form) return false;
        if (form.querySelector("#ctrl_cancel,[name='cancel']")) return false; // <- guard
        return !!form.querySelector("#ctrl_accept,[name='accept']");
      });
      return entries.map((el) => ({
        text: el.querySelector(".date.location")?.textContent?.trim() || "",
        status: el.getAttribute("data-status") || "",
        id: (el.textContent || "").match(/#\s?(\d{4,7})/)?.[1] || null,
      }));
    });
  }

  async _refreshMeineJobs() {
    if (!this.page.url().includes("/intern/meine-jobs")) {
      return await this._openMeineJobsViaMeineDaten();
    }
    try {
      const rows = await this._softRefreshJobsInPage();
      return rows && rows.length > 0;
    } catch {
      await this.page.reload({ waitUntil: "networkidle" }).catch(() => {});
      await this._dismissOverlays();
      await this._ensureAuthenticated();
      return await this._hasJobsInLiveDOM(true);
    }
  }

  async _dismissOverlays() {
    try {
      const candidates = [
        'cms-accept-tags button:has-text("Akzeptieren")',
        'cms-accept-tags button:has-text("Verstanden")',
        'cms-accept-tags button:has-text("Zustimmen")',
        'cms-accept-tags button:has-text("OK")',
        '.cookiebar button:has-text("OK")',
        '#cookiebar button:has-text("OK")',
        'button:has-text("Alle akzeptieren")',
        'button[aria-label="Akzeptieren"]',
      ];
      for (const sel of candidates) {
        const btn = this.page.locator(sel);
        if (await btn.count()) {
          await btn
            .first()
            .click({ timeout: 800 })
            .catch(() => {});
          await this.page.waitForTimeout(120);
        }
      }
      await this.page
        .evaluate(() => {
          const kill = (q) => document.querySelector(q)?.remove();
          kill("cms-accept-tags");
          document
            .querySelectorAll(".mod_cms_accept_tags")
            .forEach((n) => n.remove());
          const cb = document.querySelector(
            "#cookiebar, .cookiebar, #cookie-bar, .cookie-bar"
          );
          if (cb) cb.remove();
          document.body.classList.remove("cookie-bar-visible");
        })
        .catch(() => {});
    } catch {}
  }

  async _blockNonEssentialRequests() {
    await this.page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "font", "media"].includes(type)) return route.abort();
      route.continue();
    });
  }

  _startKeepAlive() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    const every = Math.max(2, Number(this.cfg.keepAliveMin || 4)) * 60 * 1000;
    this.keepAliveTimer = setInterval(async () => {
      try {
        if (!this.page) return;
        await this.page.evaluate(async () => {
          try {
            await fetch("/intern/meine-daten", {
              method: "HEAD",
              credentials: "include",
            });
          } catch (_) {}
        });
      } catch {}
    }, every);
  }

  async _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /* ------------------------------- LIFECYCLE -------------------------------- */

  async cleanup() {
    try {
      await this.stopWatcher();
      if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
      if (this.page) await this.page.close();
      if (this.context) await this.context.close();
      if (this.browser) await this.browser.close();
    } catch {}
    this.ready = false;
    this.isLoggedIn = false;
  }
}

module.exports = { UmzugAutomator, AUTH_STATE_PATH };
