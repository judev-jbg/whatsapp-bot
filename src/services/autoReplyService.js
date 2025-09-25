const logger = require("../utils/logger");
const BusinessHoursService = require("./businessHoursService");

class AutoReplyService {
  constructor(whatsappService) {
    this.whatsappService = whatsappService;
    this.businessHours = new BusinessHoursService();
    this.repliedNumbers = new Map(); // Para evitar responder múltiples veces
    this.pendingReplies = new Map(); // Para almacenar timeouts pendientes
    this.replyTimeout = 3600000; // 1 hora - no responder de nuevo por 1 hora
    this.replyDelay = 5000; // 5 segundos de espera antes de responder automáticamente

    // Limpiar números respondidos cada hora
    setInterval(() => this.cleanupRepliedNumbers(), 3600000);
  }

  /**
   * Procesa un mensaje entrante y responde si es necesario
   */
  async handleIncomingMessage(message) {
    try {
      // Ignorar mensajes de grupos
      if (message.from.includes("@g.us")) {
        logger.info("Ignoring group message");
        return;
      }

      // Ignorar mensajes propios
      if (message.fromMe) {
        logger.info("Ignoring own message");
        return;
      }

      const phoneNumber = message.from;
      // Cancelar respuesta automática pendiente si existe
      this.cancelPendingReply(phoneNumber);

      // Verificar si es horario de atención
      const autoReplyMessage = this.businessHours.getAutoReplyMessage();

      if (!autoReplyMessage) {
        logger.info("Within business hours - no auto-reply needed");
        return;
      }

      // Verificar si ya respondimos recientemente a este número
      if (this.hasRecentlyReplied(phoneNumber)) {
        logger.info(`Already replied to ${phoneNumber} recently`);
        return;
      }

      // Programar respuesta automática después del delay
      this.scheduleAutoReply(message, autoReplyMessage);

      logger.info(
        `⏰ Auto-reply scheduled for ${phoneNumber} in ${this.replyDelay}ms`
      );
    } catch (error) {
      logger.error("Error handling incoming message:", error);
    }
  }

  /**
   * Programa una respuesta automática después del delay especificado
   */
  scheduleAutoReply(message, replyText) {
    const phoneNumber = message.from;

    const timeoutId = setTimeout(async () => {
      try {
        // Verificar nuevamente si ya respondimos (por si acaso)
        if (this.hasRecentlyReplied(phoneNumber)) {
          logger.info(
            `Already replied to ${phoneNumber} - canceling scheduled reply`
          );
          return;
        }

        // Enviar respuesta automática
        await this.sendAutoReply(message, replyText);

        // Marcar como respondido
        this.markAsReplied(phoneNumber);

        // Marcar mensaje como no leído
        await this.markAsUnread(message);

        logger.info(`✅ Auto-reply sent to ${phoneNumber}`);
      } catch (error) {
        logger.error("Error in scheduled auto-reply:", error);
      } finally {
        // Limpiar el timeout del Map
        this.pendingReplies.delete(phoneNumber);
      }
    }, this.replyDelay);

    // Almacenar el timeout para poder cancelarlo si es necesario
    this.pendingReplies.set(phoneNumber, timeoutId);
  }

  /**
   * Cancela una respuesta automática pendiente
   */
  cancelPendingReply(phoneNumber) {
    const pendingTimeout = this.pendingReplies.get(phoneNumber);
    if (pendingTimeout) {
      clearTimeout(pendingTimeout);
      this.pendingReplies.delete(phoneNumber);
      logger.info(`⏹️ Canceled pending auto-reply for ${phoneNumber}`);
    }
  }

  /**
   * Envía la respuesta automática
   */
  async sendAutoReply(originalMessage, replyText) {
    try {
      const chat = await originalMessage.getChat();

      // Pequeña demora para parecer más natural
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Enviar mensaje
      await chat.sendMessage(replyText);

      logger.info(`📤 Auto-reply sent to ${originalMessage.from}`);
    } catch (error) {
      logger.error("Error sending auto-reply:", error);
      throw error;
    }
  }

  /**
   * Marca un mensaje como no leído
   */
  async markAsUnread(message) {
    try {
      const chat = await message.getChat();
      await chat.markUnread();
      logger.info(`📌 Message marked as unread for ${message.from}`);
    } catch (error) {
      logger.error("Error marking message as unread:", error);
    }
  }

  /**
   * Verifica si ya respondimos recientemente
   */
  hasRecentlyReplied(phoneNumber) {
    const lastReply = this.repliedNumbers.get(phoneNumber);
    if (!lastReply) return false;

    const timeSinceReply = Date.now() - lastReply;
    return timeSinceReply < this.replyTimeout;
  }

  /**
   * Marca un número como respondido
   */
  markAsReplied(phoneNumber) {
    this.repliedNumbers.set(phoneNumber, Date.now());
  }

  /**
   * Limpia números respondidos antiguos
   */
  cleanupRepliedNumbers() {
    const now = Date.now();
    for (const [phone, timestamp] of this.repliedNumbers.entries()) {
      if (now - timestamp > this.replyTimeout) {
        this.repliedNumbers.delete(phone);
      }
    }
    logger.debug(
      `Cleaned up replied numbers. Current count: ${this.repliedNumbers.size}`
    );
  }

  /**
   * Obtiene estadísticas de respuestas automáticas
   */
  getStats() {
    return {
      repliedNumbersCount: this.repliedNumbers.size,
      pendingRepliesCount: this.pendingReplies.size,
      businessHoursStatus: this.businessHours.isBusinessHours(),
      nextBusinessDay: this.businessHours.getNextBusinessDay(),
    };
  }
}

module.exports = AutoReplyService;
