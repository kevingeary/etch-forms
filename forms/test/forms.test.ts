import { describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

function incoming(input: string, init?: RequestInit): Parameters<typeof worker.fetch>[0] {
  return new Request(input, init) as Parameters<typeof worker.fetch>[0];
}

interface RecordedStatement {
  query: string;
  values: unknown[];
}

function fakeDatabase(recent = 0): {
  db: D1Database;
  writes: RecordedStatement[];
} {
  const writes: RecordedStatement[] = [];

  function statement(query: string): D1PreparedStatement {
    let values: unknown[] = [];
    const prepared = {
      bind(...next: unknown[]) {
        values = next;
        return prepared;
      },
      async first<T>(column?: string): Promise<T | null> {
        if (query.startsWith("SELECT COUNT")) {
          return (column ? recent : { n: recent }) as T;
        }
        return null;
      },
      async run() {
        writes.push({ query, values });
        return { success: true, meta: {} };
      }
    };
    return prepared as unknown as D1PreparedStatement;
  }

  const db = {
    prepare: statement,
    async batch(statements: D1PreparedStatement[]) {
      return Promise.all(statements.map((item) => item.run()));
    }
  } as unknown as D1Database;
  return { db, writes };
}

function makeEnv(overrides: Partial<Env> = {}) {
  const database = fakeDatabase();
  const send = vi.fn().mockResolvedValue({ ok: true, id: "message-123" });
  const env: Env = {
    SITE_NAME: "Acme Studio",
    SITE_DOMAIN: "acme.example",
    RECIPIENT_EMAIL: "owner@acme.example",
    DB: database.db,
    MAILER: { send },
    BURST_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    ...overrides
  };
  return { env, send, writes: database.writes };
}

describe("forms Worker", () => {
  it("shows the deployment URL and health status", async () => {
    const { env } = makeEnv();
    const page = await worker.fetch(incoming("https://forms.example/"), env);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("https://forms.example/api/contact");

    const health = await worker.fetch(
      incoming("https://forms.example/health"),
      env
    );
    expect(await health.json()).toEqual({
      ok: true,
      service: "forms",
      site: "Acme Studio"
    });
  });

  it("accepts a valid form, stores it, and calls the stubbed mailer", async () => {
    const { env, send, writes } = makeEnv();
    const body = new URLSearchParams({
      name: "Jamie Example",
      email: "jamie@example.net",
      phone: "555-0100",
      company: "Example Co",
      message: "Please tell me more about your services.",
      website: ""
    });
    const response = await worker.fetch(
      incoming("https://forms.example/api/contact", {
        method: "POST",
        headers: {
          Origin: "https://acme.example",
          "Content-Type": "application/x-www-form-urlencoded",
          "CF-Connecting-IP": "203.0.113.8"
        },
        body
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        fromName: "Acme Studio",
        to: "owner@acme.example",
        replyTo: { email: "jamie@example.net", name: "Jamie Example" }
      })
    );
    expect(writes.some(({ query }) => query.includes("INSERT INTO form_submissions"))).toBe(true);
    expect(writes.some(({ query }) => query.includes("INSERT INTO mail_log"))).toBe(true);
    expect(writes.some(({ query }) => query.includes("UPDATE form_submissions"))).toBe(true);
  });

  it("blocks an origin that is not the configured site", async () => {
    const { env, send } = makeEnv();
    const response = await worker.fetch(
      incoming("https://forms.example/api/contact", {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "Content-Type": "application/json"
        },
        body: "{}"
      }),
      env
    );

    expect(response.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });
});
