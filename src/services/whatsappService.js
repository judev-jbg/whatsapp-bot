const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const logger = require("../utils/logger");
const AutoReplyService = require("./autoReplyService");
const path = require("path");

class WhatsAppService {
  constructor(notificationService = null) {
    this.notifications = notificationService;
    this.sock = null;
    this.isReady = false;
    this.isConnecting = false;
    this.isStable = false;
    this.connectionStartTime = null;
    this.autoReplyService = null;

    // Rastrear mensajes enviados por el bot
    this.recentlySentMessages = new Map();
    this.sentMessageTimeout = 60000;

    // Auth state path
    this.authPath = path.join(process.cwd(), ".baileys_auth");

    // Reconnection control
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
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
      console.log("🚀 Initializing Baileys WhatsApp client...");

      // Load auth state
      const { state, saveCreds } = await useMultiFileAuthState(this.authPath);

      // Get latest Baileys version
      const { version } = await fetchLatestBaileysVersion();
      console.log(`📱 Using WhatsApp version: ${version.join(".")}`);

      // Create socket
      this.sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false, // We'll handle QR manually
        logger: require("pino")({ level: "silent" }), // Suppress Baileys logs
      });

      // Setup event handlers
      this.setupEventHandlers(saveCreds);

      // Wait for ready
      await this.waitForReady();

      if (this.isReady && this.isStable) {
        // Initialize auto-reply service
        if (!this.autoReplyService) {
          this.autoReplyService = new AutoReplyService(this);
          logger.info("✅ Auto-reply service initialized");
        }
      }
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
  }

  setupEventHandlers(saveCreds) {
    console.log("🔧 Setting up Baileys event handlers...");

    this.sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Handle QR code
      if (qr) {
        console.log("📱 QR Code generado:");
        qrcode.generate(qr, { small: true });

        if (this.notifications) {
          this.notifications.notifyInfo(
            "QR Code Generado",
            "Nuevo código QR generado. Escanea con WhatsApp Business.",
            { timestamp: new Date().toISOString() }
          );
        }
      }

      // Handle connection state changes
      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(
          `🔴 Connection closed. Status: ${statusCode}, Reconnect: ${shouldReconnect}`
        );
        logger.error("Connection closed:", lastDisconnect?.error);

        this.isReady = false;
        this.isStable = false;
        this.isConnecting = false;

        // Handle specific error codes
        if (statusCode === DisconnectReason.loggedOut) {
          console.log("❌ Logged out - need to scan QR again");
          logger.error("Logged out - authentication required");
        } else if (statusCode === 515) {
          console.log("⚠️ Stream error 515 - waiting 10s before reconnect");
          logger.warn("Stream error 515 detected - delayed reconnect");
          this.reconnectAttempts++;

          if (this.reconnectAttempts <= this.maxReconnectAttempts) {
            setTimeout(() => this.initialize(), 10000);
          } else {
            console.log("❌ Max reconnection attempts reached. Please restart manually.");
            logger.error("Max reconnection attempts reached");
          }
          return;
        } else if (shouldReconnect) {
          // Reconnect automatically with delay
          this.reconnectAttempts++;

          if (this.reconnectAttempts <= this.maxReconnectAttempts) {
            console.log(`🔄 Reconnecting in 5s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            setTimeout(() => this.initialize(), 5000);
          } else {
            console.log("❌ Max reconnection attempts reached. Please restart manually.");
            logger.error("Max reconnection attempts reached");
          }
        }
      } else if (connection === "open") {
        console.log("✅ WhatsApp connected and ready!");
        logger.info("WhatsApp connected and ready!");
        this.isReady = true;
        this.isConnecting = false;
        this.isStable = true;
        this.reconnectAttempts = 0; // Reset counter on successful connection
      }
    });

    // Save credentials whenever they update
    this.sock.ev.on("creds.update", saveCreds);

    // Handle incoming messages
    this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const message of messages) {
        // Ignore if no message or if it's from us
        if (!message.message || message.key.fromMe) continue;

        // Get real sender number
        const senderNumber = message.key.senderPn || message.key.remoteJid;
        console.log(
          `📨 Received message from ${senderNumber}: ${this.getMessageBody(message)?.substring(0, 50)}`
        );

        // Check if we recently sent a message to this chat
        const chatId = message.key.remoteJid;
        const lastSentTime = this.recentlySentMessages.get(chatId);

        if (lastSentTime) {
          const timeSinceSent = Date.now() - lastSentTime;
          if (timeSinceSent < this.sentMessageTimeout) {
            logger.info(
              `🚫 Ignoring message from ${chatId} - bot sent message ${timeSinceSent}ms ago`
            );
            continue;
          } else {
            this.recentlySentMessages.delete(chatId);
          }
        }

        // Convert Baileys message to whatsapp-web.js compatible format
        const adaptedMessage = this.adaptMessage(message);

        if (this.autoReplyService) {
          await this.autoReplyService.handleIncomingMessage(adaptedMessage);
        }
      }
    });
  }

  // Adapt Baileys message format to whatsapp-web.js format for compatibility
  adaptMessage(baileysMessage) {
    const body = this.getMessageBody(baileysMessage);

    // Extract real phone number from JID
    // remoteJid can be: "34XXXXXXXXX@s.whatsapp.net" or "820372336865@lid"
    // For @lid, the real number is in senderPn
    let from = baileysMessage.key.remoteJid;

    // If it's a LID (Local ID), use senderPn for the real phone number
    if (from.endsWith('@lid') && baileysMessage.key.senderPn) {
      from = baileysMessage.key.senderPn;
    } else if (from.endsWith('@lid') && baileysMessage.key.participant) {
      // For group messages, use participant
      from = baileysMessage.key.participant;
    }

    return {
      from: from,
      to: baileysMessage.key.remoteJid,
      body: body,
      fromMe: baileysMessage.key.fromMe,
      timestamp: baileysMessage.messageTimestamp,
      pushName: baileysMessage.pushName || '',
      _raw: baileysMessage,
    };
  }

  // Extract message body from Baileys message
  getMessageBody(message) {
    return (
      message.message?.conversation ||
      message.message?.extendedTextMessage?.text ||
      message.message?.imageMessage?.caption ||
      message.message?.videoMessage?.caption ||
      ""
    );
  }

  async waitForReady(maxWaitMs = 90000) {
    const startTime = Date.now();

    while (
      (!this.isReady || !this.isStable) &&
      Date.now() - startTime < maxWaitMs
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (!this.isReady || !this.isStable) {
      const error = `WhatsApp failed to become ready within ${maxWaitMs}ms. isReady=${this.isReady}, isStable=${this.isStable}`;
      console.error(`❌ ${error}`);
      throw new Error(error);
    }
  }

  async ensureStableConnection() {
    if (!this.isReady || !this.isStable) {
      logger.warn("WhatsApp not ready/stable, attempting to reconnect...");
      await this.initialize();
    }
  }

  formatSpanishNumber(phone) {
    try {
      logger.info(`Number a formatear ${phone}.`);
      let cleaned = phone
        .toString()
        .replace(".0", "")
        .replace(/[\s\-\(\)\.]/g, "");

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
      logger.error(`Error formatting phone ${phone}:`, error);
      throw error;
    }
  }

  async validateWhatsAppNumber(phoneNumber) {
    try {
      await this.ensureStableConnection();

      const formattedNumber = this.formatSpanishNumber(phoneNumber);
      const jid = formattedNumber + "@s.whatsapp.net";

      // Check if number exists on WhatsApp
      let attempts = 0;
      const maxAttempts = 3;

      while (attempts < maxAttempts) {
        try {
          const [result] = await this.sock.onWhatsApp(jid);

          if (result && result.exists) {
            logger.info(`✅ WhatsApp verified for ${formattedNumber}`);
            return {
              valid: true,
              formattedNumber,
              chatId: jid,
            };
          } else {
            logger.warn(`❌ No WhatsApp found for ${formattedNumber}`);
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

          await new Promise((resolve) => setTimeout(resolve, 2000));
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

      logger.info("📱 Sending message with Baileys...");
      logger.info(`🎯 ChatId to use: ${validation.chatId}`);

      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Mark chat before sending
      this.recentlySentMessages.set(validation.chatId, Date.now());
      logger.debug(`📝 Pre-marked chat ${validation.chatId} before sending`);

      try {
        logger.info(`📤 Sending message...`);

        const sentMessage = await this.sock.sendMessage(validation.chatId, {
          text: message,
        });

        logger.info("✅ Message sent successfully!");
        logger.info("🔍 sendMessage returned:", {
          key: sentMessage.key,
          status: sentMessage.status,
        });

        // Mark chat after successful send
        this.recentlySentMessages.set(validation.chatId, Date.now());
        logger.debug(`📝 Marked chat ${validation.chatId} as recently sent`);

        return {
          success: true,
          formattedNumber: validation.formattedNumber,
          messageId: sentMessage.key.id,
          verificationMethod: "baileys_send",
        };
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

      // Get user info from socket
      const userJid = this.sock.user?.id;
      const userName = this.sock.user?.name;

      return {
        isReady: this.isReady,
        isStable: this.isStable,
        number: userJid?.split("@")[0],
        pushname: userName,
        platform: "baileys",
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
      if (this.sock) {
        await this.sock.logout();
      }
    } catch (error) {
      logger.error("Error destroying client:", error);
    } finally {
      this.isReady = false;
      this.isConnecting = false;
      this.isStable = false;
      this.sock = null;
    }
  }
}

module.exports = WhatsAppService;
