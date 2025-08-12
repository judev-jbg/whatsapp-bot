const BusinessHoursService = require("./src/services/businessHoursService");

const service = new BusinessHoursService();

console.log("\n🧪 Testing Business Hours Service\n");

// Prueba con fecha actual
const now = new Date();
console.log(`Current time: ${now.toLocaleString("es-ES")}`);
console.log("Status:", service.isBusinessHours(now));
console.log(
  "Auto-reply message:",
  service.getAutoReplyMessage(now) || "No auto-reply (business hours)"
);

// Prueba con diferentes horarios
const testDates = [
  new Date("2025-01-15 09:00:00"), // Miércoles laborable
  new Date("2025-01-15 20:00:00"), // Miércoles fuera de horario
  new Date("2025-01-18 10:00:00"), // Sábado
  new Date("2025-01-01 10:00:00"), // Año Nuevo
  new Date("2025-12-24 10:00:00"), // Nochebuena
];

console.log("\n📅 Test scenarios:\n");
testDates.forEach((date) => {
  console.log(`\nDate: ${date.toLocaleString("es-ES")}`);
  const status = service.isBusinessHours(date);
  console.log("Status:", status);

  if (!status.isOpen) {
    const nextDay = service.getNextBusinessDay(date);
    console.log("Next business day:", nextDay.dateStr);
    console.log("Days until:", nextDay.daysUntil);
  }
});
