const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");

class BusinessHoursService {
  constructor() {
    this.configPath = path.join(__dirname, "../../config/business-hours.json");
    this.loadConfig();

    // Recargar configuración cada hora por si hay cambios
    setInterval(() => this.loadConfig(), 3600000);
  }

  loadConfig() {
    try {
      const configData = fs.readFileSync(this.configPath, "utf8");
      this.config = JSON.parse(configData);
      logger.info("✅ Business hours configuration loaded");
    } catch (error) {
      logger.error("❌ Error loading business hours config:", error);
      // Configuración por defecto si falla la carga
      this.config = this.getDefaultConfig();
    }
  }

  getDefaultConfig() {
    return {
      businessHours: {
        timezone: "Europe/Madrid",
        regularHours: {
          monday: { start: "08:00", end: "16:00" },
          tuesday: { start: "08:00", end: "16:00" },
          wednesday: { start: "08:00", end: "16:00" },
          thursday: { start: "08:00", end: "16:00" },
          friday: { start: "08:00", end: "16:00" },
          saturday: null,
          sunday: null,
        },
        holidays: { 2025: [] },
        exceptionalClosures: [],
      },
    };
  }

  /**
   * Verifica si es horario de atención
   */
  isBusinessHours(date = new Date()) {
    // Convertir a hora española
    const spanishDate = this.toSpanishTime(date);

    // Verificar si es festivo
    if (this.isHoliday(spanishDate)) {
      return {
        isOpen: false,
        reason: "holiday",
        holidayName: this.getHolidayName(spanishDate),
      };
    }

    // Obtener día de la semana
    const dayNames = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ];
    const dayName = dayNames[spanishDate.getDay()];
    const dayConfig = this.config.businessHours.regularHours[dayName];

    // Si no hay horario configurado para este día (fin de semana)
    if (!dayConfig) {
      return {
        isOpen: false,
        reason: "weekend",
      };
    }

    // Verificar hora actual
    const currentTime = spanishDate.getHours() * 100 + spanishDate.getMinutes();
    const startTime = parseInt(dayConfig.start.replace(":", ""));
    const endTime = parseInt(dayConfig.end.replace(":", ""));

    if (currentTime >= startTime && currentTime < endTime) {
      return { isOpen: true };
    } else {
      return {
        isOpen: false,
        reason: currentTime < startTime ? "beforeHours" : "afterHours",
      };
    }
  }

  /**
   * Verifica si una fecha es festivo
   */
  isHoliday(date) {
    const dateStr = this.formatDate(date);
    const year = date.getFullYear().toString();

    // Verificar festivos regulares
    const holidays = this.config.businessHours.holidays[year] || [];
    const isRegularHoliday = holidays.some((h) => h.date === dateStr);

    // Verificar cierres excepcionales
    const exceptionalClosures =
      this.config.businessHours.exceptionalClosures || [];
    const isExceptionalClosure = exceptionalClosures.some(
      (c) => c.date === dateStr
    );

    return isRegularHoliday || isExceptionalClosure;
  }

  /**
   * Obtiene el nombre del festivo
   */
  getHolidayName(date) {
    const dateStr = this.formatDate(date);
    const year = date.getFullYear().toString();

    const holidays = this.config.businessHours.holidays[year] || [];
    const holiday = holidays.find((h) => h.date === dateStr);
    if (holiday) return holiday.name;

    const exceptionalClosures =
      this.config.businessHours.exceptionalClosures || [];
    const closure = exceptionalClosures.find((c) => c.date === dateStr);
    if (closure) return closure.name;

    return "Día festivo";
  }

  /**
   * Calcula el próximo día laborable
   */
  getNextBusinessDay(fromDate = new Date()) {
    let nextDay = new Date(this.toSpanishTime(fromDate));
    let daysChecked = 0;
    const maxDays = 30; // Límite de seguridad

    // Empezar desde el día siguiente
    nextDay.setDate(nextDay.getDate() + 1);

    while (daysChecked < maxDays) {
      // Primero verificar que NO sea festivo o cierre excepcional
      if (this.isHoliday(nextDay)) {
        nextDay.setDate(nextDay.getDate() + 1);
        daysChecked++;
        continue;
      }

      // Obtener día de la semana
      const dayNames = [
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
      ];
      const dayName = dayNames[nextDay.getDay()];
      const dayConfig = this.config.businessHours.regularHours[dayName];

      // Si hay horario configurado para este día (no es fin de semana), es un día laborable
      if (dayConfig) {
        return {
          date: nextDay,
          dateStr: this.formatDateLong(nextDay),
          daysUntil: daysChecked + 1,
        };
      }

      nextDay.setDate(nextDay.getDate() + 1);
      daysChecked++;
    }

    // Fallback
    return {
      date: nextDay,
      dateStr: this.formatDateLong(nextDay),
      daysUntil: daysChecked,
    };
  }

  /**
   * Genera el mensaje de respuesta automática apropiado
   */
  getAutoReplyMessage(date = new Date()) {
    const status = this.isBusinessHours(date);
    const messages = this.config.businessHours.autoReplyMessages;

    if (status.isOpen) {
      return null; // No enviar respuesta durante horario de atención
    }

    // Si es fin de semana o víspera de varios días sin atención
    const nextBusinessDay = this.getNextBusinessDay(date);

    // Si es festivo
    if (status.reason === "holiday" || nextBusinessDay.daysUntil > 1) {
      return messages.holiday
        .replace("{holidayName}", status.holidayName)
        .replace("{nextBusinessDay}", nextBusinessDay.dateStr);
    }

    if (status.reason === "weekend" || nextBusinessDay.daysUntil > 2) {
      let reason =
        status.reason === "weekend"
          ? "Estamos fuera del horario de atención 😕"
          : "Estamos fuera del horario de atención 😕";

      return messages.weekendOrExtended
        .replace("{reason}", reason)
        .replace("{nextBusinessDay}", nextBusinessDay.dateStr);
    }

    // Fuera de horario normal
    return messages.outOfHours;
  }

  /**
   * Convierte fecha a hora española
   */
  toSpanishTime(date) {
    // Crear fecha con zona horaria española
    const options = { timeZone: "Europe/Madrid" };
    const spanishTimeStr = date.toLocaleString("es-ES", options);

    // Parsear la fecha española
    const [datepart, timepart] = spanishTimeStr.split(", ");
    const [day, month, year] = datepart.split("/");
    const [hours, minutes, seconds] = timepart.split(":");

    return new Date(year, month - 1, day, hours, minutes, seconds);
  }

  /**
   * Formatea fecha como YYYY-MM-DD
   */
  formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  /**
   * Formatea fecha en formato largo en español
   */
  formatDateLong(date) {
    const options = {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    };
    return date.toLocaleDateString("es-ES", options);
  }
}

module.exports = BusinessHoursService;
