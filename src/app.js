require("dotenv").config();
const cron = require("node-cron");
const WhatsAppService = require("./services/whatsappService");
const DatabaseService = require("./services/databaseService");
const MessageService = require("./services/messageService");
const NotificationService = require("./services/notificationService");
const ConnectionMonitor = require("./services/connectionMonitor");
const RateLimiter = require("./utils/rateLimiter");
const logger = require("./utils/logger");

class ShippingNotificationApp {
  constructor() {
    this.notifications = new NotificationService();
    this.whatsapp = new WhatsAppService(this.notifications);
    this.database = new DatabaseService();
    this.messageService = new MessageService();
    this.connectionMonitor = new ConnectionMonitor(
      this.whatsapp,
      this.notifications
    );
    this.rateLimiter = new RateLimiter(
      parseInt(process.env.MESSAGE_DELAY_MS) || 60000
    );
    this.isRunning = false;
  }

  async initialize() {
    try {
      logger.info("🚀 Initializing Shipping Notification App...");

      // Verificar base de datos
      const dbConnected = await this.database.checkConnection();
      if (!dbConnected) {
        throw new Error("Database connection failed");
      }

      const schemaOk = await this.database.verifyTableSchema();
      if (!schemaOk) {
        throw new Error("Database schema verification failed");
      }

      // Inicializar WhatsApp
      await this.whatsapp.initialize();

      // Mostrar info de WhatsApp
      const clientInfo = await this.whatsapp.getClientInfo();
      logger.info("WhatsApp Client Info:", clientInfo);

      // Iniciar monitor de conexión
      this.connectionMonitor.startMonitoring();

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

      // Notificar error crítico
      await this.notifications.notifyError(
        "Error Crítico de Inicialización",
        `La aplicación no pudo iniciarse: ${error.message}`,
        {
          error: error.message,
          stack: error.stack,
          timestamp: new Date().toISOString(),
          action: "Revisar logs y configuración",
        }
      );

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

      // Verificar que WhatsApp esté listo antes de procesar
      if (!this.whatsapp.isReady || !this.whatsapp.isStable) {
        throw new Error("WhatsApp not ready for processing shipments");
      }

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
          const result = await this.processIndividualShipment(shipment);

          if (result.reason === "NO_WHATSAPP") {
            noWhatsAppCount++;
          } else if (result.success) {
            successCount++;
          } else {
            failedCount++;
          }
        } catch (error) {
          logger.error(`Error processing shipment ${shipment.orderId}:`, error);
          failedCount++;
          // El error ya se guardó en processIndividualShipment
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

      // Notificar resumen del proceso
      await this.notifications.notifyInfo(
        "Proceso de Envíos Completado",
        `Procesamiento diario completado en ${duration.toFixed(1)} segundos`,
        {
          totalProcessed: shipments.length,
          successful: successCount,
          failed: failedCount,
          noWhatsApp: noWhatsAppCount,
          duration: `${duration.toFixed(1)}s`,
          timestamp: new Date().toISOString(),
        }
      );

      // Obtener estadísticas diarias
      const dailyStats = await this.database.getDailyStats();
      logger.info("📈 Daily stats:", dailyStats);
    } catch (error) {
      logger.error("❌ Critical error in process:", error);

      // Notificar error crítico en procesamiento
      await this.notifications.notifyError(
        "Error Crítico en Procesamiento",
        `Error grave durante el procesamiento de envíos: ${error.message}`,
        {
          error: error.message,
          stack: error.stack,
          timestamp: new Date().toISOString(),
          action: "Revisar logs y estado del sistema",
        }
      );
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

      // Usar shipPhoneNumber como prioridad, fallback a buyerPhoneNumber
      const phoneToUse = shipPhoneNumber || buyerPhoneNumber;

      if (!phoneToUse) {
        throw new Error("No phone number available for shipment");
      }

      // Enviar mensaje por WhatsApp
      const result = await this.whatsapp.sendMessage(phoneToUse, message);

      if (result.success) {
        await this.database.updateShipmentStatus(
          orderId,
          "sent",
          null, // error = null
          result.formattedNumber || null // formattedPhone puede ser null
        );
        logger.info(
          `✅ Notification sent for order ${orderId} to ${phoneToUse}`
        );
        return { success: true, reason: "SENT" };
      } else if (result.reason === "NO_WHATSAPP") {
        await this.database.updateShipmentStatus(
          orderId,
          "no_whatsapp",
          result.error || "No WhatsApp account found", // asegurar que no sea undefined
          result.formattedNumber || null
        );
        logger.warn(
          `⚠️ No WhatsApp found for order ${orderId} - ${phoneToUse}`
        );
        return { success: false, reason: "NO_WHATSAPP" };
      } else {
        throw new Error(result.error || "Unknown error occurred");
      }
    } catch (error) {
      logger.error(`❌ Failed to process shipment ${orderId}:`, error);

      // Asegurar que el error se guarde correctamente
      await this.database.updateShipmentStatus(
        orderId,
        "failed",
        error.message || "Unknown error", // asegurar que no sea undefined
        null // formattedPhone = null
      );

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

      // Detener monitoreo
      this.connectionMonitor.stopMonitoring();

      // Destruir WhatsApp
      await this.whatsapp.destroy();

      // Cerrar base de datos
      await this.database.pool.end();

      // Notificar apagado
      await this.notifications.notifyInfo(
        "Sistema Apagado",
        "WhatsApp Bot se ha desconectado correctamente",
        { timestamp: new Date().toISOString() }
      );

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
