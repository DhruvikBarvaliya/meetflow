/**
 * Email delivery port and its adapters.
 *
 * The rest of the application depends on `EmailProvider`, never on nodemailer
 * or any vendor, so swapping SMTP for a transactional API later is a new
 * adapter and one config value — not a change to any business rule.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env';
import { createLogger } from '../../config/logger';

const log = createLogger('email');

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Correlates the send with the notification row that produced it. */
  referenceId?: string;
}

export interface EmailResult {
  messageId: string;
  provider: 'console' | 'smtp';
}

export interface EmailProvider {
  readonly name: 'console' | 'smtp';
  send(message: EmailMessage): Promise<EmailResult>;
  verify(): Promise<boolean>;
}

/**
 * Development adapter. Renders the message into the structured log and reports
 * success — it never contacts a mail server.
 *
 * This is a real, honest no-op: the notification row is still written, still
 * processed by the worker and still transitions to SENT, so the whole pipeline
 * is exercised locally. It is not a stand-in for delivery in production, which
 * is why EMAIL_PROVIDER must be `smtp` there.
 */
class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console' as const;

  async send(message: EmailMessage): Promise<EmailResult> {
    const messageId = `console-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    log.info(
      {
        to: message.to,
        subject: message.subject,
        referenceId: message.referenceId,
        body: message.text,
      },
      'email rendered to log (EMAIL_PROVIDER=console)',
    );
    return { messageId, provider: 'console' };
  }

  async verify(): Promise<boolean> {
    return true;
  }
}

class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp' as const;
  private transporter: Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
      // Bounded so a hanging provider cannot pin a worker slot indefinitely.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      pool: true,
      maxConnections: 5,
    });
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    const info = await this.transporter.sendMail({
      from: env.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { messageId: info.messageId, provider: 'smtp' };
  }

  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch (error) {
      log.error({ err: error }, 'SMTP verification failed');
      return false;
    }
  }
}

let provider: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (!provider) {
    provider = env.EMAIL_PROVIDER === 'smtp' ? new SmtpEmailProvider() : new ConsoleEmailProvider();
    log.info({ provider: provider.name }, 'email provider initialised');
  }
  return provider;
}

/** Test seam: lets the integration suite capture messages without SMTP. */
export function setEmailProvider(next: EmailProvider | null): void {
  provider = next;
}
