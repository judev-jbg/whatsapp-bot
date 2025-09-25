const logger = require("../utils/logger");

class ConnectionMonitor {
  constructor(whatsappService, notificationService) {
    this.whatsapp = whatsappService;
    this.notifications = notificationService;
    this.isMonitoring = false;
    this.reconnectionAttempts = 0;
    this.maxReconnectionAttempts = 5;
    this.reconnectionDelay = 30000; // 30 segundos inicial
    this.maxReconnectionDelay = 300000; // 5 minutos máximo
    this.healthCheckInterval = 60000; // Verificar cada minuto
    this.lastHealthCheck = Date.now();
    this.healthCheckTimer = null;
    this.connectionHistory = [];
    this.isReconnecting = false;
  }

  startMonitoring() {
    if (this.isMonitoring) return;

    this.isMonitoring = true;
    logger.info("🔍 Starting WhatsApp connection monitoring");

    // Verificar salud de la conexión periódicamente
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.healthCheckInterval);

    // Configurar listeners de eventos
    this.setupEventListeners();
  }

  stopMonitoring() {
    if (!this.isMonitoring) return;

    this.isMonitoring = false;

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    logger.info("🛑 Connection monitoring stopped");
  }

  setupEventListeners() {
    // Listener para desconexiones
    this.whatsapp.client.on("disconnected", async (reason) => {
      this.logConnectionEvent("disconnected", { reason });

      await this.notifications.notifyDisconnection(
        "WhatsApp Desconectado",
        `Conexión perdida con WhatsApp: ${reason}`,
        {
          reason,
          timestamp: new Date().toISOString(),
          reconnectionAttempts: this.reconnectionAttempts,
        }
      );

      // Iniciar proceso de reconexión si no estamos ya reconectando
      if (!this.isReconnecting) {
        this.initiateReconnection();
      }
    });

    // Listener para errores de autenticación
    this.whatsapp.client.on("auth_failure", async (msg) => {
      this.logConnectionEvent("auth_failure", { message: msg });

      await this.notifications.notifyError(
        "Error de Autenticación WhatsApp",
        "Fallo en la autenticación con WhatsApp. Se requiere intervención manual.",
        {
          message: msg,
          timestamp: new Date().toISOString(),
          action: "Revisar sesión y reescanear QR si es necesario",
        }
      );

      // En caso de error de auth, no intentar reconexión automática
      this.isReconnecting = false;
    });

    // Listener para cuando se recupera la conexión
    this.whatsapp.client.on("ready", async () => {
      this.logConnectionEvent("ready");

      if (this.reconnectionAttempts > 0) {
        await this.notifications.notifySuccess(
          "WhatsApp Reconectado",
          "Conexión con WhatsApp restablecida exitosamente",
          {
            reconnectionAttempts: this.reconnectionAttempts,
            timestamp: new Date().toISOString(),
            totalDowntime: this.calculateDowntime(),
          }
        );
      }

      // Reset counters después de conexión exitosa
      this.reconnectionAttempts = 0;
      this.isReconnecting = false;
    });
  }

  async performHealthCheck() {
    if (!this.whatsapp.isReady || !this.whatsapp.isStable) {
      logger.warn("⚠️ Health check failed - WhatsApp not ready/stable");

      if (!this.isReconnecting) {
        await this.notifications.notifyWarning(
          "WhatsApp Estado Inestable",
          "WhatsApp no está en estado ready/stable. Verificando conexión...",
          {
            isReady: this.whatsapp.isReady,
            isStable: this.whatsapp.isStable,
            timestamp: new Date().toISOString(),
          }
        );

        this.initiateReconnection();
      }
      return;
    }

    // Verificación adicional: intentar obtener estado del cliente
    try {
      const state = await Promise.race([
        this.whatsapp.client.getState(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Health check timeout")), 10000)
        ),
      ]);

      if (state !== "CONNECTED") {
        logger.warn(`⚠️ WhatsApp state is ${state}, expected CONNECTED`);

        if (!this.isReconnecting) {
          this.initiateReconnection();
        }
      } else {
        this.lastHealthCheck = Date.now();
        this.logConnectionEvent("health_check_passed", { state });
      }
    } catch (error) {
      logger.error("❌ Health check error:", error.message);

      if (!this.isReconnecting) {
        await this.notifications.notifyWarning(
          "Error en Verificación de Salud",
          `No se pudo verificar el estado de WhatsApp: ${error.message}`,
          { error: error.message, timestamp: new Date().toISOString() }
        );

        this.initiateReconnection();
      }
    }
  }

  async initiateReconnection() {
    if (this.isReconnecting) {
      logger.info("🔄 Reconnection already in progress...");
      return;
    }

    if (this.reconnectionAttempts >= this.maxReconnectionAttempts) {
      await this.notifications.notifyError(
        "Reconexión Fallida - Máximo Alcanzado",
        `Se alcanzó el máximo de intentos de reconexión (${this.maxReconnectionAttempts}). Intervención manual requerida.`,
        {
          attempts: this.reconnectionAttempts,
          maxAttempts: this.maxReconnectionAttempts,
          timestamp: new Date().toISOString(),
          action: "Revisar configuración y reiniciar manualmente",
        }
      );
      return;
    }

    this.isReconnecting = true;
    this.reconnectionAttempts++;

    const delay = Math.min(
      this.reconnectionDelay * Math.pow(2, this.reconnectionAttempts - 1),
      this.maxReconnectionDelay
    );

    logger.info(
      `🔄 Initiating reconnection attempt ${this.reconnectionAttempts}/${this.maxReconnectionAttempts} in ${delay}ms`
    );

    await this.notifications.notifyReconnection(
      `Intentando Reconexión #${this.reconnectionAttempts}`,
      `Iniciando intento de reconexión automática en ${delay / 1000} segundos`,
      {
        attempt: this.reconnectionAttempts,
        maxAttempts: this.maxReconnectionAttempts,
        delay: delay,
        timestamp: new Date().toISOString(),
      }
    );

    setTimeout(async () => {
      try {
        await this.attemptReconnection();
      } catch (error) {
        logger.error(
          `❌ Reconnection attempt ${this.reconnectionAttempts} failed:`,
          error
        );

        await this.notifications.notifyError(
          `Reconexión #${this.reconnectionAttempts} Fallida`,
          `Error en intento de reconexión: ${error.message}`,
          {
            attempt: this.reconnectionAttempts,
            error: error.message,
            timestamp: new Date().toISOString(),
          }
        );

        this.isReconnecting = false;

        // Programar próximo intento si no hemos alcanzado el máximo
        if (this.reconnectionAttempts < this.maxReconnectionAttempts) {
          setTimeout(() => this.initiateReconnection(), 5000);
        }
      }
    }, delay);
  }

  async attemptReconnection() {
    logger.info(
      `🔄 Executing reconnection attempt ${this.reconnectionAttempts}`
    );

    // Destruir cliente actual
    try {
      await this.whatsapp.destroy();
      logger.info("🗑️ Previous WhatsApp client destroyed");
    } catch (error) {
      logger.warn("⚠️ Error destroying previous client:", error.message);
    }

    // Esperar un momento antes de reinicializar
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Crear nuevo cliente y reinicializar
    this.whatsapp.client = new (require("whatsapp-web.js").Client)({
      authStrategy: new (require("whatsapp-web.js").LocalAuth)({
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
        ],
      },
    });

    // Reconfigurar event handlers
    this.whatsapp.setupEventHandlers();
    this.setupEventListeners();

    // Inicializar
    await this.whatsapp.initialize();

    logger.info(
      `✅ Reconnection attempt ${this.reconnectionAttempts} completed`
    );
  }

  logConnectionEvent(event, data = {}) {
    const eventEntry = {
      timestamp: new Date().toISOString(),
      event,
      data,
      reconnectionAttempts: this.reconnectionAttempts,
    };

    this.connectionHistory.push(eventEntry);

    // Mantener solo los últimos 100 eventos
    if (this.connectionHistory.length > 100) {
      this.connectionHistory.shift();
    }

    logger.info(`📝 Connection event logged: ${event}`, data);
  }

  calculateDowntime() {
    // Calcular tiempo de inactividad basado en el historial
    const disconnectEvent = this.connectionHistory
      .reverse()
      .find((e) => e.event === "disconnected" || e.event === "auth_failure");

    if (disconnectEvent) {
      return Date.now() - new Date(disconnectEvent.timestamp).getTime();
    }

    return 0;
  }

  getStatus() {
    return {
      isMonitoring: this.isMonitoring,
      isReconnecting: this.isReconnecting,
      reconnectionAttempts: this.reconnectionAttempts,
      maxReconnectionAttempts: this.maxReconnectionAttempts,
      lastHealthCheck: this.lastHealthCheck,
      connectionHistory: this.connectionHistory.slice(-10), // Últimos 10 eventos
      whatsappStatus: {
        isReady: this.whatsapp.isReady,
        isStable: this.whatsapp.isStable,
        isConnecting: this.whatsapp.isConnecting,
      },
    };
  }
}

module.exports = ConnectionMonitor;
