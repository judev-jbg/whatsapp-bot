class RateLimiter {
  constructor(delayMs = 60000) {
    // 1 minuto por defecto
    this.delayMs = delayMs;
    this.lastExecutionTime = 0;
  }

  async waitIfNeeded() {
    const now = Date.now();
    const timeSinceLastExecution = now - this.lastExecutionTime;

    if (timeSinceLastExecution < this.delayMs) {
      const waitTime = this.delayMs - timeSinceLastExecution;
      console.log(`⏳ Rate limiting: waiting ${waitTime}ms...`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this.lastExecutionTime = Date.now();
  }

  setDelay(delayMs) {
    this.delayMs = delayMs;
  }
}

module.exports = RateLimiter;
