/**
 * Tool Base Class — all tools/extensions inherit from this.
 * 
 * A tool is a capability the AI can invoke when the retrieval pipeline
 * determines it's relevant to the current query. Tools are stored as
 * special nodes and discovered through BM25 matching against their descriptions.
 * 
 * The AI doesn't know about tools until retrieval surfaces them.
 */
export class Tool {
  /**
   * @param {object} config
   * @param {string} config.name - unique identifier (e.g., "web_search")
   * @param {string} config.description - natural language description for BM25 matching
   * @param {object} config.parameters - JSON schema of accepted parameters
   * @param {function} config.execute - async function(params, context) → result
   */
  constructor({ name, description, parameters = {}, execute }) {
    if (!name) throw new Error("[Tool] name is required");
    if (!description) throw new Error("[Tool] description is required");
    if (!execute || typeof execute !== "function") throw new Error("[Tool] execute must be a function");

    this.name = name;
    this.description = description;
    this.parameters = parameters;
    this.execute = execute;
    this._registered = false;

    console.log(`[Tool:${this.name}] Created — "${this.description.slice(0, 60)}..."`);
  }

  /**
   * Convert the tool into a node-like object for indexing.
   * The description becomes the content that BM25 searches against.
   * @returns {object}
   */
  toNode() {
    return {
      id: this.name,
      role: "tool",
      content: `${this.name}: ${this.description}`,
      query: this.description,
      metadata: {
        type: "tool",
        name: this.name,
        description: this.description,
        parameters: this.parameters
      }
    };
  }

  /**
   * Generate the function-calling schema injected into the prompt when this tool is surfaced.
   * Includes the instruction template for the model.
   * @returns {object}
   */
  toSchema() {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
      instruction: `To use this tool, respond ONLY with: {"use": true, "tool": "${this.name}", "params": ${JSON.stringify(this.parameters.properties ? Object.fromEntries(Object.keys(this.parameters.properties).map(k => [k, "<fill in>"])) : {})}}${this.parameters.properties ? "\nParameter rules: " + Object.entries(this.parameters.properties).map(([k, v]) => k + " — " + (v.description || "")).join(". ") : ""}`
    };
  }

  /**
   * Run the tool.
   * @param {object} params - parameters matching the schema
   * @param {object} context - { query, chain, config } for tools that need broader context
   * @returns {object} { success: boolean, result: any, error?: string }
   */
  async run(params, context = {}) {
    console.log(`[Tool:${this.name}] Executing with params:`, JSON.stringify(params).slice(0, 200));
    const startTime = Date.now();

    try {
      const result = await this.execute(params, context);
      const elapsed = Date.now() - startTime;
      console.log(`[Tool:${this.name}] Success in ${elapsed}ms`);
      return { success: true, result, elapsed };
    } catch (err) {
      const elapsed = Date.now() - startTime;
      console.error(`[Tool:${this.name}] Failed in ${elapsed}ms:`, err.message);
      return { success: false, result: null, error: err.message, elapsed };
    }
  }
}
