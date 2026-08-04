/**
 * Tools — core infrastructure for the extensible capability system.
 * Actual tool implementations live in src/extensions/.
 */
export { Tool } from "./base.js";
export { ToolRegistry } from "./registry.js";
export { createWebSearchTool } from "../extensions/web-search.js";
export { createDateTimeTool } from "../extensions/datetime.js";
export { createProjectGrepTool } from "../extensions/explorer.js";