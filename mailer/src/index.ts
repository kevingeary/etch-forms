import { WorkerEntrypoint } from "cloudflare:workers";

const EMAIL_RE = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]{2,}$/;

interface Env {
  SENDING_DOMAIN: string;
  EMAIL: SendEmail;
}

export interface MailMessage {
  fromName?: string;
  to: string | { email: string; name?: string };
  replyTo?: string | { email: string; name?: string };
  subject: string;
  text: string;
  html?: string;
}

export type MailResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

function addressOf(value: MailMessage["to"] | undefined): string {
  if (!value) return "";
  return typeof value === "string" ? value : value.email;
}

function emailValue(
  value: MailMessage["to"]
): string | { email: string; name: string } {
  if (typeof value === "string") return value;
  return { email: value.email, name: clean(value.name, 100) || value.email };
}

function clean(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, max);
}

function validDomain(value: string): boolean {
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(value);
}

export default class Mailer extends WorkerEntrypoint<Env> {
  override async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  }

  async send(message: MailMessage): Promise<MailResult> {
    const domain = clean(this.env.SENDING_DOMAIN, 253).toLowerCase();
    const to = addressOf(message?.to);
    const replyTo = addressOf(message?.replyTo);
    const subject = clean(message?.subject, 200);
    const text = String(message?.text ?? "");

    if (!validDomain(domain)) return { ok: false, error: "E_SENDING_DOMAIN_INVALID" };
    if (!EMAIL_RE.test(to)) return { ok: false, error: "E_INVALID_TO" };
    if (replyTo && !EMAIL_RE.test(replyTo)) {
      return { ok: false, error: "E_INVALID_REPLY_TO" };
    }
    if (!subject || !text) return { ok: false, error: "E_FIELD_MISSING" };

    const from = {
      email: `forms@${domain}`,
      name: clean(message.fromName, 100) || "Website forms"
    };

    try {
      const result = await this.env.EMAIL.send({
        from,
        to: emailValue(message.to),
        ...(replyTo && message.replyTo ? { replyTo: emailValue(message.replyTo) } : {}),
        subject,
        text,
        ...(message.html ? { html: String(message.html) } : {})
      });
      return { ok: true, id: result.messageId };
    } catch (error) {
      const mailError = error as { code?: string; message?: string };
      console.error("send failed", mailError.code, mailError.message);
      return {
        ok: false,
        error: `${mailError.code || "E_UNKNOWN"}: ${mailError.message || "send failed"}`
      };
    }
  }
}
