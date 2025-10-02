const mysql = require("mysql2/promise");
const logger = require("../utils/logger");

class DatabaseService {
  constructor() {
    this.pool = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: process.env.DB_PORT,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });
  }

  async checkConnection() {
    let connection;
    try {
      connection = await this.pool.getConnection();
      await connection.ping(); // Verifica que la conexión esté activa
      logger.info("Database connection verified successfully");
      return true;
    } catch (error) {
      logger.error("Database connection error:", error);
      return false;
    } finally {
      if (connection) await connection.release();
    }
  }

  async getPendingShipments() {
    try {
      const [rows] = await this.pool.execute(
        `
                SELECT 
                    orderId,
                    expeditionTraking,
                    orderId,
                    shipPhoneNumber,
                    buyerPhoneNumber,
                    recipientName,
                    buyerName,
                    shipAddress1,
                    shipAddress2,
                    shipAddress3,
                    shipCity,
                    shipState,
                    shipPostalCode,
                    shipCountry,
                    loadDate,
                    attempt_count
                FROM ${process.env.DB_TABLE} 
                WHERE whatsapp_status = 'pending' 
                AND expeditionTraking IS NOT NULL
                AND attempt_count < ?
                ORDER BY loadDate ASC
                LIMIT ?
            `,
        [process.env.MAX_RETRIES || 3, process.env.MAX_DAILY_MESSAGES || 50]
      );

      logger.info(`Found ${rows.length} pending shipments`);
      return rows;
    } catch (error) {
      logger.error("Error getting pending shipments:", error);
      throw error;
    }
  }

  async updateShipmentStatus(id, status, error = null, formattedPhone = null) {
    try {
      // Verificar que el registro existe primero
      const [existing] = await this.pool.execute(
        `SELECT orderId FROM ${process.env.DB_TABLE} WHERE orderId = ?`,
        [id]
      );

      if (existing.length === 0) {
        throw new Error(`Shipment with orderId ${id} not found`);
      }

      // Preparar valores seguros - convertir undefined a null
      const now = new Date();
      const sentAt = status === "sent" ? now : null;
      const sentFlag = status === "sent" ? 1 : 0;

      // Asegurar que error y formattedPhone sean null si están undefined
      const safeError = error !== undefined ? error : null;
      const safeFormattedPhone =
        formattedPhone !== undefined ? formattedPhone : null;

      // Construir query dinámicamente basado en qué campos tenemos
      const updates = [];
      const values = [];

      // Status (siempre presente)
      updates.push("whatsapp_status = ?");
      values.push(status);

      // Flag status (siempre presente)
      updates.push("whatsapp_sent = ?");
      values.push(sentFlag);

      // Sent at (siempre presente, puede ser null)
      updates.push("whatsapp_sent_at = ?");
      values.push(sentAt);

      // Error (siempre presente, puede ser null)
      updates.push("whatsapp_error = ?");
      values.push(safeError);

      // Increment attempt count (siempre presente)
      updates.push("attempt_count = attempt_count + 1");

      // Formatted phone (solo si se proporciona y no es undefined)
      if (safeFormattedPhone !== null) {
        updates.push("ship_phone_formatted = ?");
        values.push(safeFormattedPhone);
      }

      // ID para WHERE clause
      values.push(id);

      const query = `
      UPDATE ${process.env.DB_TABLE} 
      SET ${updates.join(", ")} 
      WHERE orderId = ?
    `;

      logger.info(`📝 Updating shipment ${id}:`, {
        status,
        error: safeError ? safeError.substring(0, 100) : null,
        formattedPhone: safeFormattedPhone,
        sentAt: sentAt ? sentAt.toISOString() : null,
        query,
        valuesCount: values.length,
      });

      const [result] = await this.pool.execute(query, values);

      if (result.affectedRows > 0) {
        logger.info(`✅ Successfully updated shipment ${id}`);
      } else {
        logger.warn(`⚠️ No rows affected for shipment ${id}`);
      }

      return result;
    } catch (error) {
      logger.error(`❌ Error updating shipment ${id}:`, {
        message: error.message,
        code: error.code,
        sqlState: error.sqlState,
        errno: error.errno,
        parameters: { id, status, error, formattedPhone },
      });
      throw error;
    }
  }

  async getDailyStats() {
    try {
      const [rows] = await this.pool.execute(`
                SELECT 
                    whatsapp_status,
                    COUNT(*) as count
                FROM ${process.env.DB_TABLE} 
                WHERE DATE(whatsapp_sent_at) = CURDATE()
                GROUP BY whatsapp_status
            `);

      return rows.reduce((acc, row) => {
        acc[row.whatsapp_status] = row.count;
        return acc;
      }, {});
    } catch (error) {
      logger.error("Error getting daily stats:", error);
      return {};
    }
  }

  // Agregar método de verificación al DatabaseService
  async verifyTableSchema() {
    try {
      const [columns] = await this.pool.execute(`
            SHOW COLUMNS FROM ${process.env.DB_TABLE}
        `);

      const columnNames = columns.map((col) => col.Field);
      logger.info("📋 Table columns:", columnNames);

      // Verificar campos requeridos
      const requiredFields = [
        "orderId",
        "whatsapp_status",
        "whatsapp_sent_at",
        "whatsapp_error",
        "attempt_count",
        "ship_phone_formatted",
      ];

      const missingFields = requiredFields.filter(
        (field) => !columnNames.includes(field)
      );

      if (missingFields.length > 0) {
        logger.error("❌ Missing required fields:", missingFields);
        return false;
      }

      logger.info("✅ All required fields exist");
      return true;
    } catch (error) {
      logger.error("Error verifying table schema:", error);
      return false;
    }
  }
}

module.exports = DatabaseService;
