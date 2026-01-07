const logger = require("../utils/logger");

class MessageService {
  constructor() {
    this.baseTrackingUrl = process.env.GLS_TRACKING_URL;
  }

  generateShippingMessage(shipment) {
    try {
      const {
        expeditionTraking,
        orderId,
        recipientName,
        shipAddress1,
        shipAddress2,
        shipAddress3,
        shipCity,
        shipPostalCode,
        shipCountry,
        shipState,
      } = shipment;

      // Limpiar y formatear nombre
      const customerName = recipientName;

      const shipAddress = this.formatShippingAddress(
        shipAddress1,
        shipAddress2,
        shipAddress3,
        shipCity,
        shipPostalCode,
        shipState
      );

      // Generar URL de seguimiento
      const trackingUrl = `${this.baseTrackingUrl}${expeditionTraking}`;

      const shipPostalCodeFormated = this.formatPostalCode(
        shipCountry,
        shipPostalCode
      );

      const message = `¡Hola ${customerName}! 👋

Te escribimos de la empresa Toolstock y tenemos buenas noticias 🎉

Tu pedido de Amazon *${orderId}* ya está en camino 📦

🚚 *Transportista:* GLS
📋 *Nº seguimiento:* ${expeditionTraking}
📍 *Dirección:* ${shipAddress}

Puedes seguir tu envío aquí:
${trackingUrl}&cpDst=${shipPostalCodeFormated}

¡Gracias y esperamos que disfrutes tu compra! 😊

*Equipo Toolstock*
https://www.toolstock.info/

\`Este es un mensaje automatico.\`
`;

      logger.info(`Message generated for order ${orderId}`);
      return message;
    } catch (error) {
      logger.error("Error generating message:", error);
      throw error;
    }
  }

  formatShippingAddress(
    shipAddress1,
    shipAddress2,
    shipAddress3,
    shipCity,
    shipPostalCode,
    shipState
  ) {
    // Parte 1: Concatenar las direcciones (eliminando espacios extra)
    const addressParts = [shipAddress1, shipAddress2, shipAddress3]
      .filter((part) => part && part.trim()) // Eliminar partes vacías o solo espacios
      .join(" ");

    // Parte 2: Combinar ciudad y código postal

    const cityPostal = [shipPostalCode, shipCity]
      .filter((part) => part && part.trim())
      .join(" ");

    // Parte 3: Estado (puede estar vacío)
    const state = shipState && shipState.trim() ? shipState.trim() : "";

    // Combinar todas las partes con comas, eliminando partes vacías
    const finalParts = [addressParts, cityPostal, state].filter((part) => part); // Eliminar partes vacías

    return finalParts.join(", ");
  }

  formatPostalCode(shipCountry, shipPostalCode) {
    // Eliminar espacios y guiones
    const cleanCode = shipPostalCode.toString().replace(/\s|-/g, "");

    // Verificar que solo contenga dígitos
    if (!/^\d+$/.test(cleanCode)) {
      return shipPostalCode; // Devolver original si contiene caracteres no numéricos
    }

    if (shipCountry === "ES") {
      // España: asegurar 5 dígitos, rellenando con 0 a la izquierda
      return cleanCode.padStart(5, "0");
    } else if (shipCountry === "PT") {
      // Portugal: formatear como dddd-ddd
      if (cleanCode.length < 4) {
        // Si tiene menos de 4 dígitos, rellenar hasta 4 y agregar 3 ceros
        return `${cleanCode.padStart(4, "0")}-000`;
      } else if (cleanCode.length <= 7) {
        // Tomar los primeros 4 dígitos
        const firstPart = cleanCode.substring(0, 4);
        // Para la segunda parte, tomar el resto y rellenar hasta 3 dígitos
        const remaining = cleanCode.substring(4);
        const secondPart = remaining.padEnd(3, "0");
        return `${firstPart}-${secondPart}`;
      } else {
        // Si tiene más de 7 dígitos, tomar solo los primeros 7
        return `${cleanCode.substring(0, 4)}-${cleanCode.substring(4, 7)}`;
      }
    } else {
      // Otros países: devolver sin cambios
      return shipPostalCode;
    }
  }
}

module.exports = MessageService;
