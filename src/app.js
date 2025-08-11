require("dotenv").config();
const cron = require("node-cron");
const WhatsAppService = require("./services/whatsappService");
const DatabaseService = require("./services/databaseService");
const MessageService = require("./services/messageService");
const RateLimiter = require("./utils/rateLimiter");
const logger = require("./utils/logger");

class ShippingNotificationApp {
  constructor() {
    this.whatsapp = new WhatsAppService();
    this.database = new DatabaseService();
    this.messageService = new MessageService();
    this.rateLimiter = new RateLimiter(
      parseInt(process.env.MESSAGE_DELAY_MS) || 60000
    );
    this.isRunning = false;
  }

  async initialize() {
    try {
      logger.info("🚀 Initializing Shipping Notification App...");

      // Inicializar WhatsApp
      await this.whatsapp.initialize();

      // Mostrar info de WhatsApp
      const clientInfo = await this.whatsapp.getClientInfo();
      logger.info("WhatsApp Client Info:", clientInfo);

      this.database.checkConnection();

      const schemaOk = await this.database.verifyTableSchema();
      if (!schemaOk) {
        throw new Error("Database schema verification failed");
      }

      // Configurar cron job - todos los días a las 8:30 AM
      cron.schedule(
        "30 8 * * *",
        () => {
          this.processShipments();
        },
        {
          scheduled: true,
          timezone: "Europe/Madrid",
        }
      );

      logger.info("✅ App initialized successfully");
      logger.info("📅 Cron job scheduled for 8:30 AM daily");
    } catch (error) {
      logger.error("❌ Failed to initialize app:", error);
      process.exit(1);
    }
  }

  async processShipments() {
    if (this.isRunning) {
      logger.warn("⚠️ Process already running, skipping...");
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      logger.info("🔄 Starting shipment notification process...");

      // Obtener envíos pendientes
      const shipments = await this.database.getPendingShipments();

      if (shipments.length === 0) {
        logger.info("✅ No pending shipments found");
        return;
      }

      logger.info(`📦 Processing ${shipments.length} shipments...`);

      let successCount = 0;
      let failedCount = 0;
      let noWhatsAppCount = 0;

      // Procesar cada envío
      for (const shipment of shipments) {
        try {
          await this.processIndividualShipment(shipment);
          successCount++;
        } catch (error) {
          logger.error(`Error processing shipment ${shipment.id}:`, error);
          await this.database.updateShipmentStatus(
            shipment.id,
            "failed",
            error.message
          );
          failedCount++;
        }

        // Rate limiting entre mensajes
        if (shipment !== shipments[shipments.length - 1]) {
          await this.rateLimiter.waitIfNeeded();
        }
      }

      // Log final statistics
      const duration = (Date.now() - startTime) / 1000;
      logger.info(`✅ Process completed in ${duration}s`);
      logger.info(
        `📊 Results: ${successCount} sent, ${failedCount} failed, ${noWhatsAppCount} no WhatsApp`
      );

      // Obtener estadísticas diarias
      const dailyStats = await this.database.getDailyStats();
      logger.info("📈 Daily stats:", dailyStats);
    } catch (error) {
      logger.error("❌ Critical error in process:", error);
    } finally {
      this.isRunning = false;
    }
  }

  async processIndividualShipment(shipment) {
    const { orderId, shipPhoneNumber, buyerPhoneNumber } = shipment;

    logger.info(`📱 Processing shipment ${orderId}`);

    try {
      // Generar mensaje personalizado
      const message = this.messageService.generateShippingMessage(shipment);

      const ship_phone = shipPhoneNumber | buyerPhoneNumber;
      // Enviar mensaje por WhatsApp
      const result = await this.whatsapp.sendMessage(ship_phone, message);

      if (result.success) {
        await this.database.updateShipmentStatus(
          orderId,
          "sent",
          null,
          result.formattedNumber
        );
        logger.info(
          `✅ Notification sent for order ${orderId} to ${ship_phone}`
        );
      } else if (result.reason === "NO_WHATSAPP") {
        await this.database.updateShipmentStatus(
          orderId,
          "no_whatsapp",
          result.error
        );
        logger.warn(
          `⚠️ No WhatsApp found for order ${orderId} - ${ship_phone}`
        );
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      logger.error(`❌ Failed to process shipment ${orderId}:`, error);
      throw error;
    }
  }

  // Método para testing manual
  async testSingleShipment(shipmentId) {
    try {
      const [shipment] = await this.database.pool.execute(
        `SELECT * FROM ${process.env.DB_TABLE} WHERE orderId = ?`,
        [shipmentId]
      );

      if (shipment.length === 0) {
        throw new Error("Shipment not found");
      }

      await this.processIndividualShipment(shipment[0]);
      logger.info("✅ Test shipment processed successfully");
    } catch (error) {
      logger.error("❌ Test failed:", error);
      throw error;
    }
  }

  async shutdown() {
    try {
      logger.info("🔄 Shutting down app...");
      await this.whatsapp.destroy();
      await this.database.pool.end();
      logger.info("✅ App shutdown completed");
    } catch (error) {
      logger.error("❌ Error during shutdown:", error);
    }
  }
}

// Inicializar aplicación
const app = new ShippingNotificationApp();

// Manejar señales del sistema
process.on("SIGINT", async () => {
  console.log("\n🛑 Received SIGINT, shutting down gracefully...");
  await app.shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 Received SIGTERM, shutting down gracefully...");
  await app.shutdown();
  process.exit(0);
});

const isManualMode = process.argv.includes("--manual");

// Inicializar
if (isManualMode) {
  // Modo manual - ejecutar una vez y salir
  (async () => {
    try {
      console.log("🚀 Running in manual mode...");
      await app.initialize();
      await app.processShipments();
      await app.shutdown();
      process.exit(0);
    } catch (error) {
      logger.error("💥 Manual execution failed:", error);
      process.exit(1);
    }
  })();
} else {
  // Modo normal con cron job
  app.initialize().catch((error) => {
    logger.error("💥 Failed to start app:", error);
    process.exit(1);
  });
}
// Exportar para testing
module.exports = app;
