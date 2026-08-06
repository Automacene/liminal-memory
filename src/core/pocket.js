/**
 * Pocket — a parallel instruction queue that lives alongside the main chain.
 * 
 * Users queue notes (corrections, instructions, waypoints) while the system
 * is executing. At each checkpoint, the system consumes the next queued note
 * and applies it to the upcoming step.
 * 
 * Think of it as a "pocket dimension" — a liminal space where user intent
 * accumulates until the system is ready to receive it.
 */
export class Pocket {
  constructor() {
    this.queue = [];       // pending notes waiting to be consumed
    this.consumed = [];    // notes that have been applied (history)
    this.listeners = [];   // callbacks for when notes are added
  }

  /**
   * Queue a pocket note. Called by the user at any time.
   * @param {string} content - the instruction/correction
   * @param {object} [meta] - optional metadata (target step, priority, etc.)
   * @returns {object} the queued note
   */
  add(content, meta = {}) {
    const note = {
      id: this.queue.length + this.consumed.length + 1,
      content,
      timestamp: Date.now(),
      consumed: false,
      consumedAt: null,
      meta
    };
    this.queue.push(note);
    this._emit(note);
    console.log(`[Pocket] Queued #${note.id}: "${content.slice(0, 60)}"`);
    return note;
  }

  /**
   * Consume the next queued note. Called by the system at checkpoints.
   * Returns the note content or null if queue is empty.
   * @returns {object|null} the consumed note, or null
   */
  consume() {
    if (this.queue.length === 0) return null;
    const note = this.queue.shift();
    note.consumed = true;
    note.consumedAt = Date.now();
    this.consumed.push(note);
    console.log(`[Pocket] Consumed #${note.id}: "${note.content.slice(0, 60)}"`);
    return note;
  }

  /**
   * Peek at the next note without consuming it.
   * @returns {object|null}
   */
  peek() {
    return this.queue.length > 0 ? this.queue[0] : null;
  }

  /**
   * Consume ALL pending notes at once (for checkpoints that want everything).
   * @returns {object[]} array of consumed notes
   */
  consumeAll() {
    const notes = [];
    while (this.queue.length > 0) {
      notes.push(this.consume());
    }
    return notes;
  }

  /**
   * How many notes are waiting.
   * @returns {number}
   */
  get pending() {
    return this.queue.length;
  }

  /**
   * Whether there are notes waiting to be consumed.
   * @returns {boolean}
   */
  get hasPending() {
    return this.queue.length > 0;
  }

  /**
   * Get all notes (pending + consumed) as history.
   * @returns {object[]}
   */
  get history() {
    return [...this.consumed, ...this.queue];
  }

  /**
   * Format all pending notes into a single string for prompt injection.
   * @returns {string}
   */
  formatPending() {
    if (this.queue.length === 0) return '';
    return this.queue.map((n, i) => `[Pocket Note ${i + 1}]: ${n.content}`).join('\n');
  }

  /**
   * Register a listener for when notes are added.
   * @param {function} callback - receives the note object
   */
  onAdd(callback) {
    this.listeners.push(callback);
  }

  /**
   * Clear all pending notes (discard without consuming).
   */
  clearPending() {
    this.queue = [];
  }

  /**
   * Export state.
   */
  export() {
    return {
      queue: this.queue,
      consumed: this.consumed
    };
  }

  /**
   * Import state.
   */
  import(data) {
    this.queue = data.queue || [];
    this.consumed = data.consumed || [];
  }

  _emit(note) {
    for (const cb of this.listeners) {
      try { cb(note); } catch (e) { /* swallow */ }
    }
  }
}
