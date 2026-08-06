/**
 * Date/Time Tool — returns current date, time, day, timezone.
 * Zero dependencies, instant execution.
 */
import { Tool } from "../tools/base.js";

/**
 * Create a date/time tool instance.
 * @returns {Tool}
 */
export function createDateTimeTool() {
  return new Tool({
    name: "datetime",
    description: "Tell the current time or date when the user asks. Trigger phrases: what time is it, what day is it, whats todays date, current time, current date, what year is it.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: "What to return: 'full' for everything, 'date' for just the date, 'time' for just the time. Default: full"
        }
      },
      required: []
    },
    execute: async function (params) {
      var now = new Date();
      var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

      var result = {
        date: months[now.getMonth()] + ' ' + now.getDate() + ', ' + now.getFullYear(),
        time: now.toLocaleTimeString(),
        day: days[now.getDay()],
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        timestamp: now.toISOString()
      };

      var formatted = 'Current date and time:\n' +
        '- Date: ' + result.date + '\n' +
        '- Day: ' + result.day + '\n' +
        '- Time: ' + result.time + '\n' +
        '- Timezone: ' + result.timezone;

      console.log('[DateTime] ' + result.day + ', ' + result.date + ' ' + result.time);

      return { ...result, formatted: formatted };
    }
  });
}
