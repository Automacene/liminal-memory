/**
 * Memory Manager — tracks RAM usage and emits warnings.
 * The entire node chain lives in memory at all times.
 * Disk (cold storage) is only used for explicitly trimmed/branched data.
 */
export class MemoryManager {
  constructor(chain, config) {
    this.chain = chain;
    this.config = config;
    this.listeners = new Map();
  }

  /**
   * Current memory usage in MB.
   * @returns {number}
   */
  get usageMB() {
    return this.chain.memorySizeBytes / (1024 * 1024);
  }

  /**
   * Current utilization ratio (0 to 1).
   * @returns {number}
   */
  get utilization() {
    return this.usageMB / this.config.memoryLimitMB;
  }

  /**
   * Check if memory is within limits. Emits warning if threshold exceeded.
   * @returns {{ ok: boolean, usageMB: number, utilization: number, warning: boolean }}
   */
  check() {
    const usageMB = this.usageMB;
    const utilization = this.utilization;
    const warning = utilization >= this.config.warnThreshold;
    const blocked = utilization >= 1.0;

    if (warning) {
      this._emit("memory-warning", {
        usageMB,
        utilization,
        limitMB: this.config.memoryLimitMB,
        blocked
      });
    }

    return { ok: !blocked, usageMB, utilization, warning };
  }

  /**
   * Get a status report.
   * @returns {object}
   */
  status() {
    return {
      totalNodes: this.chain.length,
      memoryUsageMB: Math.round(this.usageMB * 100) / 100,
      utilizationPercent: Math.round(this.utilization * 100),
      limitMB: this.config.memoryLimitMB,
      warning: this.utilization >= this.config.warnThreshold
    };
  }

  /**
   * Register an event listener.
   * @param {string} event
   * @param {function} callback
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  /**
   * Emit an event.
   * @param {string} event
   * @param {*} data
   */
  _emit(event, data) {
    const callbacks = this.listeners.get(event) || [];
    for (const cb of callbacks) {
      try { cb(data); } catch (e) { /* swallow listener errors */ }
    }
  }
}
