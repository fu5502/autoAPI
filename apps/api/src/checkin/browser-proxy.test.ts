import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerBrowserProxy } from "./browser-proxy.js";

describe("check-in browser proxy", () => {
  it("issues a short-lived cookie only for an authenticated admin", async () => {
    const app = Fastify({ logger: false });
    const proxy = await registerBrowserProxy(app, (token) => token === "admin-session");

    const unauthorized = await app.inject({
      method: "POST",
      url: "/admin/checkin/browser/session",
    });
    expect(unauthorized.statusCode).toBe(401);

    const session = await app.inject({
      method: "POST",
      url: "/admin/checkin/browser/session",
      headers: { authorization: "Bearer admin-session" },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().url).toContain("/admin/checkin/browser/vnc.html");
    expect(session.headers["set-cookie"]).toMatch(/autoapi_checkin_browser=.*HttpOnly/);

    const blockedResource = await app.inject({
      method: "GET",
      url: "/admin/checkin/browser/vnc.html",
    });
    expect(blockedResource.statusCode).toBe(401);

    proxy.close();
    await app.close();
  });
});
