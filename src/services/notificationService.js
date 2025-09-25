const nodemailer = require("nodemailer");
const { IncomingWebhook } = require("@slack/webhook");
const logger = require("../utils/logger");

class NotificationService {
  constructor() {
    // Configuración de email
    this.emailEnabled = process.env.EMAIL_NOTIFICATIONS_ENABLED === "true";
    this.emailTransporter = null;

    // Configuración de Slack
    this.slackEnabled = process.env.SLACK_NOTIFICATIONS_ENABLED === "true";
    this.slackWebhook = null;

    this.setupEmail();
    this.setupSlack();
  }

  setupEmail() {
    if (!this.emailEnabled) return;

    try {
      this.emailTransporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || "smtp.office365.com",
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: false, // true para 465, false para otros puertos
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASSWORD,
        },
        tls: {
          rejectUnauthorized: false,
        },
      });

      // Verificar configuración
      this.emailTransporter.verify((error, success) => {
        if (error) {
          logger.error("❌ Email configuration failed:", error);
          this.emailEnabled = false;
        } else {
          logger.info("✅ Email service ready");
        }
      });
    } catch (error) {
      logger.error("❌ Error setting up email service:", error);
      this.emailEnabled = false;
    }
  }

  setupSlack() {
    if (!this.slackEnabled || !process.env.SLACK_WEBHOOK_URL) return;

    try {
      this.slackWebhook = new IncomingWebhook(process.env.SLACK_WEBHOOK_URL, {
        username: "WhatsApp Bot Monitor",
        icon_emoji: ":robot_face:",
      });
      logger.info("✅ Slack webhook ready");
    } catch (error) {
      logger.error("❌ Error setting up Slack webhook:", error);
      this.slackEnabled = false;
    }
  }

  async sendNotification(type, title, message, details = {}) {
    const notifications = [];

    // Enviar por email si está habilitado
    if (this.emailEnabled) {
      notifications.push(this.sendEmail(type, title, message, details));
    }

    // Enviar por Slack si está habilitado
    if (this.slackEnabled) {
      notifications.push(this.sendSlack(type, title, message, details));
    }

    if (notifications.length === 0) {
      logger.warn("⚠️ No notification channels enabled");
      return;
    }

    try {
      await Promise.allSettled(notifications);
    } catch (error) {
      logger.error("❌ Error sending notifications:", error);
    }
  }

  async sendEmail(type, title, message, details) {
    if (!this.emailTransporter) return;

    try {
      const subject = `${this.getTypeEmoji(
        type
      )} [${type.toUpperCase()}] ${title}`;
      const htmlContent = this.generateEmailHTML(type, title, message, details);

      const mailOptions = {
        from: process.env.SMTP_USER,
        to: process.env.NOTIFICATION_EMAIL_TO || process.env.SMTP_USER,
        subject,
        html: htmlContent,
        text: `${title}\n\n${message}\n\nDetalles: ${JSON.stringify(
          details,
          null,
          2
        )}`,
      };

      const info = await this.emailTransporter.sendMail(mailOptions);
      logger.info(`📧 Email notification sent: ${info.messageId}`);
    } catch (error) {
      logger.error("❌ Failed to send email notification:", error);
    }
  }

  async sendSlack(type, title, message, details) {
    if (!this.slackWebhook) return;

    try {
      const color = this.getSlackColor(type);
      const emoji = this.getTypeEmoji(type);

      const payload = {
        text: `${emoji} *${title}*`,
        attachments: [
          {
            color,
            fields: [
              {
                title: "Mensaje",
                value: message,
                short: false,
              },
              {
                title: "Timestamp",
                value: new Date().toLocaleString("es-ES", {
                  timeZone: "Europe/Madrid",
                }),
                short: true,
              },
              {
                title: "Tipo",
                value: type.toUpperCase(),
                short: true,
              },
            ],
          },
        ],
      };

      // Agregar detalles si existen
      if (Object.keys(details).length > 0) {
        payload.attachments[0].fields.push({
          title: "Detalles",
          value: "```" + JSON.stringify(details, null, 2) + "```",
          short: false,
        });
      }

      await this.slackWebhook.send(payload);
      logger.info("💬 Slack notification sent");
    } catch (error) {
      logger.error("❌ Failed to send Slack notification:", error);
    }
  }

  generateEmailHTML(type, title, message, details) {
    const color =
      type === "error" ? "#dc3545" : type === "warning" ? "#ffc107" : "#28a745";

    return `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
            .header { background-color: ${color}; color: white; padding: 15px; border-radius: 5px 5px 0 0; }
            .content { background-color: #f8f9fa; padding: 20px; border: 1px solid #dee2e6; }
            .details { background-color: #e9ecef; padding: 10px; margin-top: 15px; border-radius: 3px; }
            .footer { font-size: 12px; color: #6c757d; margin-top: 20px; }
        </style>
    </head>
    <body>
        <div class="header">
            <h2>${this.getTypeEmoji(type)} ${title}</h2>
        </div>
        <div class="content">
            <p><strong>Mensaje:</strong></p>
            <p>${message}</p>
            
            ${
              Object.keys(details).length > 0
                ? `
            <div class="details">
                <p><strong>Detalles técnicos:</strong></p>
                <pre>${JSON.stringify(details, null, 2)}</pre>
            </div>
            `
                : ""
            }
            
            <div class="footer">
                <p>Timestamp: ${new Date().toLocaleString("es-ES", {
                  timeZone: "Europe/Madrid",
                })}</p>
                <p>Sistema: WhatsApp Bot Monitor</p>
            </div>
        </div>
    </body>
    </html>
    `;
  }

  getTypeEmoji(type) {
    switch (type) {
      case "error":
        return "🚨";
      case "warning":
        return "⚠️";
      case "info":
        return "ℹ️";
      case "success":
        return "✅";
      case "reconnection":
        return "🔄";
      case "disconnection":
        return "📱❌";
      default:
        return "📋";
    }
  }

  getSlackColor(type) {
    switch (type) {
      case "error":
        return "danger";
      case "warning":
        return "warning";
      case "success":
        return "good";
      case "info":
        return "#17a2b8";
      default:
        return "#6c757d";
    }
  }

  // Métodos de conveniencia para tipos específicos
  async notifyError(title, message, details = {}) {
    await this.sendNotification("error", title, message, details);
  }

  async notifyWarning(title, message, details = {}) {
    await this.sendNotification("warning", title, message, details);
  }

  async notifyInfo(title, message, details = {}) {
    await this.sendNotification("info", title, message, details);
  }

  async notifySuccess(title, message, details = {}) {
    await this.sendNotification("success", title, message, details);
  }

  async notifyReconnection(title, message, details = {}) {
    await this.sendNotification("reconnection", title, message, details);
  }

  async notifyDisconnection(title, message, details = {}) {
    await this.sendNotification("disconnection", title, message, details);
  }
}

module.exports = NotificationService;
