'use strict';

const { config } = require('./config');

/**
 * Content-Security-Policy.
 *
 * Everything is same-origin: scripts and styles are files, images are inline
 * SVG data URIs, and the realtime connection is a same-origin websocket. Only
 * the web font is external, which is why fonts.googleapis.com appears.
 */
function contentSecurityPolicy(secure) {
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'none'",
  ];
  // Only meaningful when the page itself arrived over HTTPS: sending it on a
  // plain-HTTP request would make the browser upgrade (and break) every asset.
  if (secure) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

/**
 * Baseline hardening headers for every response.
 *
 * `req.secure` is true when the request arrived over TLS - including behind
 * Render's proxy, where the X-Forwarded-Proto header is trusted via
 * `app.set('trust proxy', 1)`.
 */
function securityHeaders(req, res, next) {
  const secure = Boolean(req.secure);
  res.setHeader('Content-Security-Policy', contentSecurityPolicy(secure));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Origin-Agent-Cluster', '?1');
  // Browsers ignore HSTS over http:// anyway, and we do not want to advertise
  // it on a deployment that is not actually behind TLS.
  if (secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}

/**
 * Fixed-window rate limiter.
 *
 * Deliberately tiny and dependency-free. It is per-process, so a multi-instance
 * deployment needs a shared store (Redis) to enforce limits globally - noted in
 * the README.
 */
class RateLimiter {
  /**
   * @param {{windowMs: number, max: number, name: string}} options
   */
  constructor({ windowMs, max, name }) {
    this.windowMs = windowMs;
    this.max = max;
    this.name = name;
    this.hits = new Map();
    this.sweeper = setInterval(() => this.sweep(), Math.max(windowMs, 30_000));
    if (this.sweeper.unref) this.sweeper.unref();
  }

  /**
   * Register one attempt.
   * @returns {{allowed: boolean, retryAfterMs: number, remaining: number}}
   */
  check(key) {
    const now = Date.now();
    const bucket = this.hits.get(key);

    if (!bucket || now >= bucket.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterMs: 0, remaining: this.max - 1 };
    }

    bucket.count += 1;
    if (bucket.count > this.max) {
      return { allowed: false, retryAfterMs: bucket.resetAt - now, remaining: 0 };
    }
    return { allowed: true, retryAfterMs: 0, remaining: this.max - bucket.count };
  }

  /** Drop a key entirely (e.g. after the room it belongs to is gone). */
  reset(key) {
    this.hits.delete(key);
  }

  sweep() {
    const now = Date.now();
    for (const [key, bucket] of this.hits) {
      if (now >= bucket.resetAt) this.hits.delete(key);
    }
  }

  get size() {
    return this.hits.size;
  }

  stop() {
    clearInterval(this.sweeper);
    this.hits.clear();
  }
}

/** Express middleware wrapper around a limiter. */
function httpRateLimit(limiter, keyFn) {
  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : req.ip;
    const result = limiter.check(key);
    if (result.allowed) return next();

    res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  };
}

module.exports = { securityHeaders, contentSecurityPolicy, RateLimiter, httpRateLimit };
