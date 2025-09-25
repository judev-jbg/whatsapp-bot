const { Client, LocalAuth } = require("whatsapp-web.js");
const AutoReplyService = require("./autoReplyService");
const qrcode = require("qrcode-terminal");
const logger = require("../utils/logger");

class WhatsAppService {
  constructor(notificationService = null) {
    this.notifications = notificationService;
    this.client = new Client({
      authStrategy: new LocalAuth({
        clientId: "whatsapp-bot",
      }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
        ],
      },
    });

    this.isReady = false;
    this.isConnecting = false;
    this.isStable = false;
    this.connectionStartTime = null;
    this.setupEventHandlers();
    this.autoReplyService = null;
  }

  setupEventHandlers() {
    this.client.on("qr", (qr) => {
      console.log("Escanea este QR con WhatsApp Business:");
      qrcode.generate(qr, { small: true });

      if (this.notifications) {
        this.notifications.notifyInfo(
          "QR Code Generado",
          "Nuevo código QR generado. Escanea con WhatsApp Business.",
          { timestamp: new Date().toISOString() }
        );
      }
    });

    this.client.on("ready", async () => {
      this.isReady = true;
      this.isConnecting = false;

      logger.info("WhatsApp Client is ready!");

      // Esperar estabilización adicional
      await this.waitForStability();
    });

    this.client.on("authenticated", () => {
      logger.info("WhatsApp authenticated successfully");
    });

    this.client.on("disconnected", (reason) => {
      this.isReady = false;
      this.isConnecting = false;
      this.isStable = false;
      logger.error("WhatsApp disconnected:", reason);

      // La notificación será manejada por ConnectionMonitor
    });

    this.client.on("auth_failure", (msg) => {
      this.isReady = false;
      this.isConnecting = false;
      this.isStable = false;
      logger.error("Authentication failed:", msg);

      // La notificación será manejada por ConnectionMonitor
    });

    this.client.on("message", async (message) => {
      if (this.autoReplyService) {
        await this.autoReplyService.handleIncomingMessage(message);
      }
    });

    this.client.on("message_create", async (message) => {
      logger.debug(`Message created: ${message.body.substring(0, 50)}...`);
    });
  }

  async waitForStability() {
    logger.info("⏳ Waiting for WhatsApp stability...");

    // Esperar 5 segundos adicionales para estabilización
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Verificar que el contexto esté disponible
    try {
      await this.client.getState();
      await this.client.info;
      this.isStable = true;
      logger.info("✅ WhatsApp is now stable and ready");
    } catch (error) {
      logger.warn("⚠️ WhatsApp not fully stable yet, waiting more...");
      await new Promise((resolve) => setTimeout(resolve, 3000));
      this.isStable = true; // Asumir estable después del tiempo adicional
    }
  }

  async initialize() {
    if (this.isReady && this.isStable) {
      logger.info("WhatsApp already ready and stable");
      return;
    }

    if (this.isConnecting) {
      logger.info("WhatsApp already connecting, waiting...");
      await this.waitForReady();
      return;
    }

    this.isConnecting = true;
    this.connectionStartTime = Date.now();

    try {
      await this.client.initialize();
      await this.waitForReady();
    } catch (error) {
      this.isConnecting = false;
      logger.error("Failed to initialize WhatsApp:", error);

      if (this.notifications) {
        await this.notifications.notifyError(
          "Error de Inicialización WhatsApp",
          `Fallo al inicializar cliente de WhatsApp: ${error.message}`,
          {
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString(),
          }
        );
      }

      throw error;
    }

    if (this.isReady && this.isStable) {
      // Inicializar servicio de respuestas automáticas
      if (!this.autoReplyService) {
        this.autoReplyService = new AutoReplyService(this);
        logger.info("✅ Auto-reply service initialized");
      }
    }
  }

  async waitForReady(maxWaitMs = 90000) {
    // Aumentado a 90 segundos
    const startTime = Date.now();

    while (
      (!this.isReady || !this.isStable) &&
      Date.now() - startTime < maxWaitMs
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (!this.isReady || !this.isStable) {
      throw new Error(
        "WhatsApp failed to become ready and stable within timeout"
      );
    }
  }

  async ensureStableConnection() {
    if (!this.isReady || !this.isStable) {
      logger.warn("WhatsApp not ready/stable, attempting to reconnect...");
      await this.initialize();
    }

    // Triple verificación de estabilidad
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        const state = await this.client.getState();
        const info = await this.client.info;

        if (state === "CONNECTED" && info) {
          logger.debug(`✅ WhatsApp stable - State: ${state}`);
          return;
        }

        logger.warn(
          `⚠️ WhatsApp unstable - State: ${state}, attempt ${attempts + 1}`
        );
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        logger.error(
          `Connection check failed, attempt ${attempts + 1}:`,
          error.message
        );
        attempts++;

        if (attempts >= maxAttempts) {
          throw new Error("WhatsApp connection critically unstable");
        }

        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  formatSpanishNumber(phone) {
    try {
      logger.info(`Numbe a formatear ${phone}.`);
      let cleaned = phone.toString().replace(/[\s\-\(\)\.]/g, "");

      if (cleaned.startsWith("+346")) {
        cleaned = cleaned.substring(1);
      } else if (cleaned.startsWith("34")) {
        cleaned = cleaned;
      } else if (
        cleaned.startsWith("6") ||
        cleaned.startsWith("7") ||
        cleaned.startsWith("9")
      ) {
        cleaned = "34" + cleaned;
      } else if (cleaned.startsWith("0034")) {
        cleaned = cleaned.substring(2);
      }

      if (cleaned.length !== 11 || !cleaned.startsWith("34")) {
        throw new Error(`Invalid Spanish number format: ${phone}`);
      }

      logger.info(`Formatted number ${phone}. Nuevo numero ${cleaned}`);
      return cleaned;
    } catch (error) {
      logger.error(`Error formatting phone ${phone}:`, error.message);
      throw error;
    }
  }

  async validateWhatsAppNumber(phoneNumber) {
    try {
      await this.ensureStableConnection();

      const formattedNumber = this.formatSpanishNumber(phoneNumber);

      // Validación con reintentos
      let attempts = 0;
      const maxAttempts = 3;

      while (attempts < maxAttempts) {
        try {
          const numberId = await Promise.race([
            this.client.getNumberId(formattedNumber),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Validation timeout")), 15000)
            ),
          ]);

          logger.info("🔍 getNumberId returned:", {
            type: typeof numberId,
            value: numberId,
            serialized: numberId?._serialized,
            user: numberId?.user,
            server: numberId?.server,
          });

          if (numberId) {
            logger.info(`✅ WhatsApp verified for ${phoneNumber}`);
            return {
              valid: true,
              formattedNumber,
              chatId: numberId._serialized,
            };
          } else {
            logger.warn(`❌ No WhatsApp found for ${phoneNumber}`);
            return {
              valid: false,
              formattedNumber,
              error: "Number not registered on WhatsApp",
            };
          }
        } catch (error) {
          attempts++;
          logger.warn(
            `Validation attempt ${attempts} failed for ${phoneNumber}:`,
            error.message
          );

          if (attempts >= maxAttempts) {
            throw error;
          }

          // Esperar antes del reintento
          await new Promise((resolve) => setTimeout(resolve, 2000));

          // Re-verificar conexión
          await this.ensureStableConnection();
        }
      }
    } catch (error) {
      logger.error(`Error validating WhatsApp for ${phoneNumber}:`, error);

      return {
        valid: false,
        formattedNumber: null,
        error: error.message,
      };
    }
  }

  async sendMessage(phoneNumber, message) {
    try {
      logger.info(`Attempting to send message to ${phoneNumber}`);

      await this.ensureStableConnection();

      const validation = await this.validateWhatsAppNumber(phoneNumber);

      if (!validation.valid) {
        return {
          success: false,
          error: validation.error,
          reason: "NO_WHATSAPP",
        };
      }

      logger.info("📱 Sending message with stability checks...");
      logger.info(`🎯 ChatId to use: ${validation.chatId}`);

      await new Promise((resolve) => setTimeout(resolve, 2000));

      // ✅ SOLO UN INTENTO - No bucle de reintentos
      try {
        logger.info(`📤 Calling this.client.sendMessage...`);

        // Obtener timestamp antes del envío
        const beforeTimestamp = Date.now();

        const sentMessage = await Promise.race([
          this.client.sendMessage(validation.chatId, message),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Send timeout")), 20000)
          ),
        ]);

        logger.info("🔍 sendMessage returned:", {
          type: typeof sentMessage,
          isUndefined: sentMessage === undefined,
          isNull: sentMessage === null,
        });

        // ✅ VERIFICACIÓN INTELIGENTE - Comprobar si el mensaje realmente llegó
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Esperar 1s para sincronización

        try {
          const chat = await this.client.getChatById(validation.chatId);
          const lastMessage = chat.lastMessage;

          logger.info("💬 Chat verification:", {
            lastMessageBody: lastMessage?.body?.substring(0, 100),
            lastMessageTimestamp: lastMessage?.timestamp,
            beforeTimestamp: Math.floor(beforeTimestamp / 1000),
          });

          // ✅ VERIFICAR SI EL ÚLTIMO MENSAJE ES NUESTRO MENSAJE
          const isOurMessage =
            lastMessage &&
            lastMessage.body &&
            lastMessage.body.includes(
              message.split("\n")[0].substring(0, 20)
            ) && // Verificar inicio del mensaje
            lastMessage.timestamp >= Math.floor(beforeTimestamp / 1000) - 5; // Timestamp cercano

          if (isOurMessage) {
            logger.info("✅ Message successfully verified in chat");
            return {
              success: true,
              formattedNumber: validation.formattedNumber,
              messageId: lastMessage.id?._serialized || "verified",
              verificationMethod: "chat_verification",
            };
          } else {
            logger.warn("⚠️ Could not verify message in chat");
            // Aún así, considerarlo éxito si no hubo error en sendMessage
            if (sentMessage === undefined) {
              logger.info(
                "✅ Assuming success (undefined response but no error)"
              );
              return {
                success: true,
                formattedNumber: validation.formattedNumber,
                messageId: "assumed_success",
                verificationMethod: "no_error_assumption",
              };
            }
          }
        } catch (chatError) {
          logger.error("Error verifying chat:", chatError.message);
          // Si no podemos verificar el chat pero no hubo error en send, asumir éxito
          if (sentMessage === undefined) {
            logger.info(
              "✅ Assuming success (could not verify chat but no send error)"
            );
            return {
              success: true,
              formattedNumber: validation.formattedNumber,
              messageId: "unverified_success",
              verificationMethod: "send_no_error",
            };
          }
        }

        // Si llegamos aquí y sentMessage no es undefined, usarlo normalmente
        if (sentMessage && sentMessage !== undefined) {
          logger.info(`✅ Message sent with proper response`);
          return {
            success: true,
            formattedNumber: validation.formattedNumber,
            messageId: sentMessage.id?._serialized || "normal_response",
            verificationMethod: "normal_response",
          };
        }

        // Si nada de lo anterior funcionó, marcar como error
        throw new Error("Could not verify message delivery");
      } catch (error) {
        logger.error(`❌ Send failed for ${phoneNumber}: ${error.message}`);
        return {
          success: false,
          error: error.message,
          reason: "SEND_ERROR",
        };
      }
    } catch (error) {
      logger.error(
        `❌ Failed to send message to ${phoneNumber}: ${error.message}`
      );

      return {
        success: false,
        error: error.message,
        reason: "SEND_ERROR",
      };
    }
  }
  async getClientInfo() {
    try {
      await this.ensureStableConnection();
      const info = await this.client.info;
      return {
        isReady: this.isReady,
        isStable: this.isStable,
        number: info.wid?.user,
        pushname: info.pushname,
        platform: info.platform,
      };
    } catch (error) {
      return {
        isReady: this.isReady,
        isStable: this.isStable,
        error: error.message,
      };
    }
  }

  async destroy() {
    try {
      await this.client.destroy();
    } catch (error) {
      logger.error("Error destroying client:", error);
    } finally {
      this.isReady = false;
      this.isConnecting = false;
      this.isStable = false;
    }
  }
}

module.exports = WhatsAppService;
