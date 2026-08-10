/**
 * The synthetic conversation and the tool definitions.
 *
 * Three turns early on settle a decision, then it gets buried. Everything after them avoids the
 * words "license", "apache", "patent", "hardware", "mit", and "sdk", so a match on those terms
 * later can only have come from the planted turns rather than from filler that happened to
 * rhyme with them.
 */

/**
 * The turns that matter, in the order they appear. Three rather than one, because real recall
 * pulls back a cluster of related turns rather than a single perfect hit.
 */
export const PLANTED = [
  {
    at: 8,
    user: "what license are we shipping the sdk under?",
    assistant:
      "Apache 2.0. The patent grant is the deciding factor, because the hardware partners " +
      "will not sign off on anything without one."
  },
  {
    at: 14,
    user: "why not mit? it is simpler",
    assistant:
      "MIT gives the partners no patent protection at all, and their legal team said that was " +
      "a hard no. Apache 2.0 is the only license everyone could live with."
  },
  {
    at: 21,
    user: "does the apache choice affect anything downstream?",
    assistant:
      "Only that every source file needs the license header, and the NOTICE file has to list " +
      "the hardware partners by name."
  }
];

/** The primary one, used where a single turn is needed. */
export const PLANTED_TURN_INDEX = PLANTED[0].at;
export const PLANTED_TURN = { user: PLANTED[0].user, assistant: PLANTED[0].assistant };

/** The question asked at the very end, long after the planted turns have left the window. */
export const FINAL_QUESTION = "remind me what license we settled on and why";

/**
 * Filler.
 *
 * There are enough entries that a 99-turn run never repeats one. That matters more than it
 * sounds: a repeated question is genuinely relevant to its own earlier twin, so recall pulls
 * the twin back and the output reads as if a turn recalled itself. `buildTranscript` throws
 * rather than let the list wrap, so this cannot quietly regress.
 */
const FILLER = [
  ["morning, anything blocking?", "nothing blocking. The staging deploy finished overnight."],
  ["did the nightly suite pass?", "all green, about nine minutes end to end."],
  ["who is on call this week?", "Priya until thursday, then it rotates to Marco."],
  ["can we bump the timeout on the upload endpoint?", "raised it to sixty seconds and redeployed."],
  ["the sidebar looks off on mobile", "the flex container was missing a min-width. Fixed."],
  ["how much did we spend on cloud last month?", "pulling that up now."],
  ["any word from the design review?", "they want more contrast on the secondary buttons."],
  ["is the changelog up to date?", "yes, through this morning's merge."],
  ["are we booked for anything friday?", "let me look."],
  ["the search box feels slow", "it was re-rendering on every keystroke. Debounced it."],
  ["should we drop node 16?", "already did, the floor is 18 now."],
  ["did anyone review the migration script?", "Marco did, one comment about the rollback path."],
  ["coffee machine is broken again", "third time this month. Facilities has been told."],
  ["where is the retry logic implemented?", "let me search the repo."],
  ["can you rerun the failed job?", "restarted it, should be done in five."],
  ["are the docs deployed?", "yes, went out with the last tag."],
  ["what is the weather looking like for friday?", "let me check the forecast."],
  ["the logo is pixelated on retina", "swapped it for the svg."],
  ["do we need a migration for this?", "no, the column is nullable."],
  ["standup moved?", "yes, fifteen minutes later starting monday."],
  ["is the staging database seeded?", "seeded this morning with the anonymised dump."],
  ["why is the bundle so big?", "a date library got pulled in twice. Deduped it."],
  ["did the customer reply about the outage?", "yes, they were fine once we sent the timeline."],
  ["can we cache the settings endpoint?", "added a sixty second cache, invalidated on write."],
  ["the dark theme washes out on the table headers", "bumped the border contrast one step."],
  ["how long is the queue backlog?", "about four thousand, draining steadily."],
  ["do we still need the feature flag?", "no, it has been on for everyone for a month."],
  ["who owns the analytics dashboard now?", "Priya took it over from the old growth team."],
  ["the mobile keyboard covers the submit button", "added padding for the visual viewport."],
  ["is there a reason we poll instead of using websockets?", "history. Nobody got round to changing it."],
  ["can we archive the old branches?", "cleaned up anything merged before june."],
  ["what broke the build yesterday?", "a transitive dependency published a bad minor."],
  ["should the empty state have an illustration?", "design says yes, they are drawing one."],
  ["are we rate limiting the public api?", "sixty a minute per key, burst of a hundred."],
  ["the tooltip flickers on hover", "it was fighting the mouseleave handler. Fixed."],
  ["did we ever write the runbook?", "half of it. The failover section is still empty."],
  ["is anyone using the legacy export?", "two accounts, both told about the replacement."],
  ["did the vendor send the updated contract?", "yes, legal is reading it this week."],
  ["is the changelog entry written for the release?", "drafted, needs a second pair of eyes."],
  ["why did the health check flap overnight?", "a slow dns lookup on one of the nodes."],
  ["can we drop the old image sizes?", "removed everything above 2x, saved a lot of storage."],
  ["who approved the schema change?", "Priya, in the thread on tuesday."],
  ["are the error messages translated yet?", "only the top twenty, the rest fall back to english."],
  ["the pagination skips a row on page two", "off by one in the offset. Patched."],
  ["should the modal close on outside click?", "design says yes, unless there are unsaved edits."],
  ["how big is the uploads bucket now?", "just under four terabytes."],
  ["did the intern finish the onboarding doc?", "first draft is in the shared folder."],
  ["is the webhook retrying on failure?", "three attempts with backoff, then a dead letter queue."],
  ["what happened to the old status page?", "retired it when we moved to the hosted one."],
  ["can we sort the table by two columns?", "added a secondary sort, holding shift."],
  ["the avatars load slowly on the members list", "added lazy loading below the fold."],
  ["do we log the request id anywhere useful?", "it is in every structured log line now."],
  ["are the seeds deterministic?", "yes, fixed seed, same data every run."],
  ["did we get the security questionnaire back?", "returned it friday, waiting on their review."],
  ["why is the footer overlapping on print?", "the print stylesheet had a stale height."],
  ["can the export run in the background?", "moved it to a job, emails a link when done."],
  ["is anyone still on the old mobile build?", "about two percent, mostly on old devices."],
  ["what is the p99 on the search endpoint?", "around three hundred milliseconds."],
  ["should we split the settings page?", "yes, it has grown to eleven sections."],
  ["did the migration lock the table?", "briefly, about four seconds on staging."],
  ["are the invite emails landing in spam?", "not since we set up the dkim record."],
  ["can we preview attachments inline?", "images and pdfs, everything else downloads."],
  ["who is writing the release notes?", "Marco this time, he offered."],
  ["the toast messages stack up forever", "capped it at three, oldest one dismisses."],
  ["is the audit trail immutable?", "append only, nothing exposes an update path."],
  ["what timezone do the reports use?", "the account timezone, not the viewer's."],
  ["did the load test finish?", "yes, held up to about eight hundred concurrent."],
  ["can we reorder the nav items?", "made them configurable per workspace."],
  ["are we storing anything we should not be?", "the audit found two fields, both removed."],
  ["the empty search state says zero results twice", "duplicate string, deleted one."],
  ["is the billing page behind a flag still?", "no, it went out to everyone last week."],
  ["how often does the sync job run?", "every fifteen minutes, or on demand."],
  ["did the design tokens land?", "merged, colors and spacing both come from them now."],
  ["can we bulk archive from the list view?", "added a select all with a confirmation step."],
  ["why did that account get double charged?", "a retry fired before the first call returned."],
  ["are the tooltips reachable by keyboard?", "yes, they open on focus as well as hover."],
  ["should we keep the beta banner?", "dropping it, the feature is stable now."],
  ["what is the largest file anyone has uploaded?", "about nine hundred megabytes."],
  ["did the copy review come back?", "yes, mostly shortening things."],
  ["can the sidebar collapse remember its state?", "stored per user, restores on load."],
  ["is the queue draining faster since the change?", "roughly twice as fast."],
  ["who owns the shared staging account?", "platform team, ask in their channel."],
  ["are there tests for the rollback path?", "two now, one happy and one mid-failure."],
  ["the date picker starts on sunday for everyone", "made the first day follow the locale."],
  ["did we ever fix the duplicate webhook ids?", "yes, they are namespaced by workspace now."],
  ["can we cache the avatar lookups?", "cached for an hour, busted on profile save."],
  ["is the onboarding checklist dismissible?", "yes, and it stays dismissed."],
  ["what broke the search index yesterday?", "a document with a null title."],
  ["should the delete button be red?", "destructive actions all use the danger color now."],
  ["are we sending too many notification emails?", "batched them into a daily digest."],
  ["did the accessibility audit find much?", "eleven issues, nine already fixed."],
  ["can we show relative timestamps?", "yes, with the exact time on hover."],
  ["is the config file documented anywhere?", "every key has a comment now."],
  ["why does the first paint feel slow?", "a blocking font request. Preloaded it."],
  ["did anyone try the import with a huge file?", "tested at fifty thousand rows, took two minutes."],
  ["can we undo a bulk action?", "there is a thirty second window to undo."]
];

/**
 * Build the transcript. The planted turns land at fixed positions and filler fills the rest.
 *
 * @param {number} count  how many turns to produce
 * @returns {{user: string, assistant: string}[]}
 */
export function buildTranscript(count = 99) {
  const needed = count - PLANTED.length;
  if (needed > FILLER.length) {
    throw new Error(
      `[example] ${count} turns needs ${needed} filler exchanges but only ${FILLER.length} exist. ` +
      `Repeating them makes recall look broken, because a repeated question really does match ` +
      `its earlier twin. Add more rather than wrapping.`
    );
  }

  const planted = new Map(PLANTED.map(turn => [turn.at, turn]));
  const turns = [];
  let fillerIndex = 0;

  for (let i = 0; i < count; i++) {
    const seeded = planted.get(i);

    if (seeded) {
      turns.push({ user: seeded.user, assistant: seeded.assistant });
      continue;
    }

    const [user, assistant] = FILLER[fillerIndex];
    fillerIndex++;
    turns.push({ user, assistant });
  }

  return turns;
}

/**
 * The tool pool, stood up once at session start and never touched again.
 *
 * Descriptions are written the way a tool description actually gets written, which is short.
 * That shortness is the reason tools live in their own pool: dropped in with conversation
 * turns, relevance scoring would treat them as abnormally brief documents and rank them oddly.
 */
export const TOOLS = [
  {
    name: "expense_lookup",
    description: "Total spending and cost across a date range, including cloud bills and invoices.",
    call: { from: "YYYY-MM-DD", to: "YYYY-MM-DD" },
    returns: { total: "number", currency: "string", breakdown: "object[]" }
  },
  {
    name: "calendar_search",
    description: "Find scheduled meetings, standups, and events on the team calendar.",
    call: { query: "string", within_days: "number" },
    returns: { events: "object[]" }
  },
  {
    name: "repo_search",
    description: "Search source code for a symbol, function, or implementation.",
    call: { symbol: "string", path: "string" },
    returns: { matches: "object[]" }
  },
  {
    name: "weather_forecast",
    description: "Weather forecast and temperature for a city on a given day.",
    call: { city: "string", day: "string" },
    returns: { summary: "string", high_c: "number", low_c: "number" }
  }
];
