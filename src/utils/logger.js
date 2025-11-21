const winston = require("winston");
const path = require("path");

// Función para capturar información del call site
function getCallerInfo() {
  const originalFunc = Error.prepareStackTrace;
  let callerfile;
  let callerFunc;
  let callerLine;

  try {
    const err = new Error();
    let currentfile;

    Error.prepareStackTrace = function (err, stack) {
      return stack;
    };

    currentfile = err.stack.shift().getFileName();

    while (err.stack.length) {
      const frame = err.stack.shift();
      callerfile = frame.getFileName();
      callerFunc = frame.getFunctionName();
      callerLine = frame.getLineNumber();

      if (currentfile !== callerfile) break;
    }
  } catch (e) {}

  Error.prepareStackTrace = originalFunc;

  return {
    filename: callerfile ? path.basename(callerfile) : "unknown",
    funcName: callerFunc || "anonymous",
    lineNumber: callerLine || 0,
  };
}

// Definir niveles de log personalizados
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Definir colores para los niveles
const colors = {
  error: "red",
  warn: "yellow",
  info: "green",
  http: "magenta",
  debug: "white",
};

winston.addColors(colors);

const getLocalTimestamp = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

// Formato personalizado para consola
const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({
    format: getLocalTimestamp,
  }),
  winston.format.errors({ stack: true }),
  winston.format.printf((info) => {
    const caller = info.caller || "unknown:unknown:0";
    return `${info.timestamp} | ${info.level} | ${caller} | ${info.message}`;
  })
);

// Formato para archivos (mantiene JSON)
const fileFormat = winston.format.combine(
  winston.format.timestamp({
    format: getLocalTimestamp,
  }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Crear directorio de logs si no existe
const logsDir = path.join(__dirname, "../../logs");

// Configurar transports
const transports = [
  new winston.transports.Console({
    level: process.env.NODE_ENV === "production" ? "warn" : "debug",
    format: consoleFormat,
  }),

  new winston.transports.File({
    filename: path.join(logsDir, "error.log"),
    options: {
      encoding: "utf8",
    },
    level: "error",
    format: fileFormat,
    maxsize: 5242880,
    maxFiles: 5,
  }),

  new winston.transports.File({
    filename: path.join(logsDir, "combined.log"),
    options: {
      encoding: "utf8",
    },
    format: fileFormat,
    maxsize: 5242880,
    maxFiles: 5,
  }),
];

// Crear el logger base
const baseLogger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  levels,
  transports,
  exitOnError: false,
});

// Crear wrapper que captura información del caller
const logger = {
  error: function (message, ...args) {
    const caller = getCallerInfo();
    baseLogger.error(message, {
      caller: `${caller.filename}:${caller.funcName}:${caller.lineNumber}`,
      ...args[0],
    });
  },

  warn: function (message, ...args) {
    const caller = getCallerInfo();
    baseLogger.warn(message, {
      caller: `${caller.filename}:${caller.funcName}:${caller.lineNumber}`,
      ...args[0],
    });
  },

  info: function (message, ...args) {
    const caller = getCallerInfo();
    baseLogger.info(message, {
      caller: `${caller.filename}:${caller.funcName}:${caller.lineNumber}`,
      ...args[0],
    });
  },

  http: function (message, ...args) {
    const caller = getCallerInfo();
    baseLogger.http(message, {
      caller: `${caller.filename}:${caller.funcName}:${caller.lineNumber}`,
      ...args[0],
    });
  },

  debug: function (message, ...args) {
    const caller = getCallerInfo();
    baseLogger.debug(message, {
      caller: `${caller.filename}:${caller.funcName}:${caller.lineNumber}`,
      ...args[0],
    });
  },

  // Método para logs con contexto personalizado
  logWithContext: function (level, message, context = {}) {
    const caller = getCallerInfo();
    baseLogger.log(level, message, {
      caller: `${caller.filename}:${caller.funcName}:${caller.lineNumber}`,
      context,
      timestamp: new Date().toISOString(),
      pid: process.pid,
    });
  },

  // Stream para middleware HTTP
  stream: {
    write: function (message) {
      const caller = getCallerInfo();
      baseLogger.http(message.trim(), {
        caller: `${caller.filename}:${caller.funcName}:${caller.lineNumber}`,
      });
    },
  },
};

module.exports = logger;
